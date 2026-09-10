-- Eastudy learner administration and truthful recent-activity tracking.
-- Additive only: no membership, learning history, content or R2 object is deleted.

create table if not exists private.learner_activity (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_seen_at timestamptz not null
);

alter table private.learner_activity enable row level security;
revoke all on table private.learner_activity from public, anon, authenticated;

create index if not exists user_progress_admin_history_idx
  on public.user_progress(user_id, last_watched_at desc);

create or replace function public.touch_my_activity_v1()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
begin
  if v_user is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = v_user and p.is_active is true
  ) then
    raise exception 'ACCOUNT_INACTIVE' using errcode = '42501';
  end if;

  insert into private.learner_activity as activity(user_id, last_seen_at)
  values(v_user, v_now)
  on conflict(user_id) do update
    set last_seen_at = excluded.last_seen_at
    where activity.last_seen_at <= excluded.last_seen_at - interval '60 seconds';
end;
$$;

revoke all on function public.touch_my_activity_v1() from public, anon;
grant execute on function public.touch_my_activity_v1() to authenticated;

create or replace function public.admin_list_learners_v1(
  p_query text default '',
  p_status text default 'all',
  p_page integer default 1,
  p_page_size integer default 25,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_result jsonb;
begin
  if auth.uid() is null or public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_page is null or p_page not between 1 and 100000
     or p_page_size is null or p_page_size not between 1 and 100
     or length(v_query) > 100
     or p_status is null
     or p_status not in ('all', 'none', 'active', 'expired', 'revoked') then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;

  with base as (
    select p.id, p.phone, p.nickname, p.avatar_url, p.role, p.is_active, p.created_at,
      entitlement.expires_at,
      case
        when entitlement.user_id is null then 'none'
        when entitlement.revoked_at is not null then 'revoked'
        when entitlement.expires_at <= v_now then 'expired'
        else 'active'
      end as membership_status
    from public.profiles p
    left join public.membership_entitlements entitlement
      on entitlement.user_id = p.id and entitlement.product_id = 'eastudy_pro'
    where (p_user_id is null or p.id = p_user_id)
      and (v_query = ''
        or strpos(lower(coalesce(p.nickname, '')), v_query) > 0
        or strpos(lower(coalesce(p.phone, '')), v_query) > 0)
  ), filtered as (
    select * from base
    where p_status = 'all' or membership_status = p_status
  ), page_rows as (
    select * from filtered
    order by created_at desc, id desc
    limit p_page_size offset ((p_page::bigint - 1) * p_page_size)
  )
  select jsonb_build_object(
    'serverTime', v_now,
    'page', p_page,
    'pageSize', p_page_size,
    'total', (select count(*) from filtered),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', learner.id,
        'phone', learner.phone,
        'nickname', learner.nickname,
        'avatarUrl', learner.avatar_url,
        'role', learner.role,
        'isActive', learner.is_active,
        'createdAt', learner.created_at,
        'membershipStatus', learner.membership_status,
        'membershipExpiresAt', learner.expires_at,
        'remainingSeconds', case when learner.membership_status = 'active'
          then greatest(0, floor(extract(epoch from (learner.expires_at - v_now))))
          else 0 end,
        'lastSignInAt', auth_user.last_sign_in_at,
        'lastSeenAt', activity.last_seen_at,
        'totalLearningSeconds', daily.total_seconds,
        'learningDays', daily.learning_days,
        'completedVideos', progress.completed_videos,
        'masteredWords', vocabulary.mastered_words
      ) order by learner.created_at desc, learner.id desc)
      from page_rows learner
      left join auth.users auth_user on auth_user.id = learner.id
      left join private.learner_activity activity on activity.user_id = learner.id
      cross join lateral (
        select coalesce(sum(stat.learning_seconds), 0) as total_seconds,
          count(*) filter(where stat.learning_seconds > 0) as learning_days
        from public.daily_learning_stats stat where stat.user_id = learner.id
      ) daily
      cross join lateral (
        select count(*) as completed_videos
        from public.user_progress item
        where item.user_id = learner.id and item.completed_at is not null
      ) progress
      cross join lateral (
        select count(*) as mastered_words
        from public.user_vocabulary item
        where item.user_id = learner.id and item.state = 'mastered'
      ) vocabulary
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_list_learners_v1(text,text,integer,integer,uuid)
  from public, anon;
grant execute on function public.admin_list_learners_v1(text,text,integer,integer,uuid)
  to authenticated;

create or replace function public.admin_get_learner_detail_v1(
  p_user_id uuid,
  p_from date default (current_date - 29),
  p_to date default current_date,
  p_history_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_page jsonb;
  v_daily jsonb;
  v_history jsonb;
  v_history_total bigint;
begin
  if auth.uid() is null or public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_user_id is null or p_from is null or p_to is null
     or p_to < p_from or p_to - p_from > 92
     or p_history_page is null or p_history_page not between 1 and 100000
     or p_page_size is null or p_page_size not between 1 and 100 then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;

  v_page := public.admin_list_learners_v1('', 'all', 1, 1, p_user_id);
  if coalesce((v_page->>'total')::bigint, 0) = 0 then
    raise exception 'LEARNER_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'studyDate', stat.study_date,
    'learningSeconds', stat.learning_seconds
  ) order by stat.study_date), '[]'::jsonb)
  into v_daily
  from public.daily_learning_stats stat
  where stat.user_id = p_user_id and stat.study_date between p_from and p_to;

  select count(*) into v_history_total
  from public.user_progress progress where progress.user_id = p_user_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'videoId', history.video_id,
    'videoTitle', history.video_title,
    'positionSeconds', history.position_seconds,
    'durationSeconds', history.duration_seconds,
    'completionPercent', history.completion_percent,
    'watchCoveragePercent', history.watch_coverage_percent,
    'completedAt', history.completed_at,
    'lastWatchedAt', history.last_watched_at
  ) order by history.last_watched_at desc nulls last, history.video_id desc), '[]'::jsonb)
  into v_history
  from (
    select progress.video_id, progress.position_seconds, progress.duration_seconds,
      progress.completion_percent, progress.watch_coverage_percent,
      progress.completed_at, progress.last_watched_at,
      coalesce(
        (
          select nullif(coalesce(video.value->>'titleZh', video.value->>'title'), '')
          from private.content_snapshots snapshot
          cross join lateral jsonb_array_elements(coalesce(snapshot.draft->'videos', '[]'::jsonb)) video(value)
          where snapshot.environment = 'production'
            and video.value->>'id' = progress.video_id::text
          limit 1
        ),
        (
          select nullif(coalesce(trash.payload->'video'->>'titleZh', trash.payload->'video'->>'title'), '')
          from private.content_video_trash trash
          where trash.environment = 'production' and trash.video_id = progress.video_id::text
          order by trash.deleted_at desc limit 1
        )
      ) as video_title
    from public.user_progress progress
    where progress.user_id = p_user_id
    order by progress.last_watched_at desc nulls last, progress.video_id desc
    limit p_page_size offset ((p_history_page::bigint - 1) * p_page_size)
  ) history;

  return jsonb_build_object(
    'serverTime', v_now,
    'learner', v_page->'items'->0,
    'daily', v_daily,
    'history', jsonb_build_object(
      'items', v_history,
      'total', v_history_total,
      'page', p_history_page,
      'pageSize', p_page_size
    )
  );
end;
$$;

revoke all on function public.admin_get_learner_detail_v1(uuid,date,date,integer,integer)
  from public, anon;
grant execute on function public.admin_get_learner_detail_v1(uuid,date,date,integer,integer)
  to authenticated;

comment on table private.learner_activity is
  'Server-authenticated recent activity heartbeat; not precise presence and not study time.';
comment on function public.admin_list_learners_v1(text,text,integer,integer,uuid) is
  'Admin-only paginated learner account, membership and authoritative learning summary.';
comment on function public.admin_get_learner_detail_v1(uuid,date,date,integer,integer) is
  'Admin-only learner detail with bounded daily and video history windows.';
