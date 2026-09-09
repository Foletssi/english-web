-- Reliable, idempotent learning sync for multiple devices.
-- Existing progress, vocabulary and daily aggregates are retained.

alter table public.study_events add column if not exists session_id uuid;
alter table public.study_events add column if not exists sequence_no bigint;
alter table public.study_events add column if not exists client_recorded_at timestamptz;
alter table public.study_events add column if not exists active_seconds integer not null default 0;
create unique index if not exists study_events_session_sequence_uidx
  on public.study_events(user_id, session_id, sequence_no) where session_id is not null;

alter table public.user_progress add column if not exists media_version text not null default 'legacy';
alter table public.user_progress add column if not exists revision bigint not null default 1;
alter table public.user_progress add column if not exists position_session_id uuid;
alter table public.user_progress add column if not exists position_sequence_no bigint;
alter table public.user_progress add column if not exists position_updated_at timestamptz not null default now();

alter table public.saved_sentences add column if not exists sentence_id text;
alter table public.saved_sentences add column if not exists content_version text not null default 'legacy';
create unique index if not exists saved_sentences_stable_uidx
  on public.saved_sentences(user_id, video_id, sentence_id) where sentence_id is not null;

alter table public.user_vocabulary add column if not exists source_video_id bigint;
alter table public.user_vocabulary add column if not exists source_sentence_id text;
alter table public.user_vocabulary add column if not exists content_version text not null default 'legacy';

create table if not exists public.study_activity_intervals (
  user_id uuid not null references public.profiles(id) on delete cascade,
  session_id uuid not null,
  sequence_no bigint not null,
  video_id bigint not null,
  active_range tstzrange not null,
  created_at timestamptz not null default now(),
  primary key(user_id, session_id, sequence_no),
  check (not isempty(active_range)),
  check (lower_inc(active_range) and not upper_inc(active_range))
);
-- Keep UUID lookup and range overlap separate to avoid requiring btree_gist.
create index if not exists study_activity_intervals_user_idx
  on public.study_activity_intervals(user_id);
create index if not exists study_activity_intervals_range_idx
  on public.study_activity_intervals using gist(active_range);
alter table public.study_activity_intervals enable row level security;
drop policy if exists "activity intervals select own or admin" on public.study_activity_intervals;
create policy "activity intervals select own or admin" on public.study_activity_intervals
  for select to authenticated using (user_id=auth.uid() or public.is_admin());
revoke all on public.study_activity_intervals from anon, authenticated;
grant select on public.study_activity_intervals to authenticated;

create table if not exists public.user_creator_follows (
  user_id uuid not null references public.profiles(id) on delete cascade,
  creator_id text not null,
  active boolean not null default true,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key(user_id, creator_id)
);
create table if not exists public.user_collection_saves (
  user_id uuid not null references public.profiles(id) on delete cascade,
  collection_id text not null,
  active boolean not null default true,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key(user_id, collection_id)
);
create table if not exists public.user_learning_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(settings)='object')
);

alter table public.user_creator_follows enable row level security;
alter table public.user_collection_saves enable row level security;
alter table public.user_learning_preferences enable row level security;
drop policy if exists "creator follows own" on public.user_creator_follows;
drop policy if exists "collection saves own" on public.user_collection_saves;
drop policy if exists "learning preferences own" on public.user_learning_preferences;
create policy "creator follows own" on public.user_creator_follows for all to authenticated
  using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy "collection saves own" on public.user_collection_saves for all to authenticated
  using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy "learning preferences own" on public.user_learning_preferences for all to authenticated
  using(user_id=auth.uid()) with check(user_id=auth.uid());
grant select,insert,update,delete on public.user_creator_follows to authenticated;
grant select,insert,update,delete on public.user_collection_saves to authenticated;
grant select,insert,update,delete on public.user_learning_preferences to authenticated;

create or replace function public.eastudy_merge_watch_ranges(
  p_existing jsonb, p_incoming jsonb, p_duration numeric
) returns jsonb
language sql immutable set search_path=public,pg_temp as $$
  with raw as (
    select greatest(0::numeric,least(p_duration,(item->>0)::numeric)) as start_at,
           greatest(0::numeric,least(p_duration,(item->>1)::numeric)) as end_at
    from jsonb_array_elements(coalesce(p_existing,'[]'::jsonb)||coalesce(p_incoming,'[]'::jsonb)) item
    where jsonb_typeof(item)='array' and jsonb_array_length(item)=2
      and jsonb_typeof(item->0)='number' and jsonb_typeof(item->1)='number'
      and (item->>1)::numeric>(item->>0)::numeric
  ), aggregated as (
    select range_agg(numrange(start_at,end_at,'[)')) as ranges from raw where end_at>start_at
  )
  select coalesce(jsonb_agg(jsonb_build_array(lower(segment),upper(segment)) order by lower(segment)),'[]'::jsonb)
  from aggregated cross join lateral unnest(aggregated.ranges) segment
$$;

create or replace function public.apply_study_event_v2(
  p_session_id uuid,
  p_sequence_no bigint,
  p_video_id bigint,
  p_media_version text,
  p_position_seconds double precision,
  p_duration_seconds double precision,
  p_watch_ranges jsonb default '[]'::jsonb,
  p_active_seconds integer default 0,
  p_activity_started_at timestamptz default null,
  p_activity_ended_at timestamptz default null,
  p_client_recorded_at timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_user uuid:=auth.uid();
  v_inserted integer:=0;
  v_existing public.user_progress%rowtype;
  v_ranges jsonb;
  v_watched numeric:=0;
  v_coverage numeric:=0;
  v_tz text:='Asia/Shanghai';
  v_day date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_seconds integer;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  if p_session_id is null or p_sequence_no<1 or p_video_id is null or p_duration_seconds<=0 or
     p_position_seconds<0 or p_position_seconds>p_duration_seconds+1 or
     jsonb_typeof(coalesce(p_watch_ranges,'[]'::jsonb))<>'array' or
     p_active_seconds<0 or p_active_seconds>60 or
     p_client_recorded_at<now()-interval '1 day' or p_client_recorded_at>now()+interval '5 minutes' then
    raise exception 'INVALID_STUDY_EVENT';
  end if;
  if p_active_seconds>0 and (p_activity_started_at is null or p_activity_ended_at is null or
     p_activity_ended_at<=p_activity_started_at or p_activity_ended_at-p_activity_started_at>interval '60 seconds') then
    raise exception 'INVALID_ACTIVITY_RANGE';
  end if;

  insert into public.study_events(user_id,event_type,video_id,payload,occurred_at,session_id,sequence_no,client_recorded_at,active_seconds)
  values(v_user,'learning_sync_v2',p_video_id,jsonb_build_object('mediaVersion',coalesce(nullif(p_media_version,''),'legacy'),'watchRanges',p_watch_ranges),now(),p_session_id,p_sequence_no,p_client_recorded_at,p_active_seconds)
  on conflict(user_id,session_id,sequence_no) where session_id is not null do nothing;
  get diagnostics v_inserted=row_count;

  insert into public.user_progress(user_id,video_id) values(v_user,p_video_id)
  on conflict(user_id,video_id) do nothing;
  select * into v_existing from public.user_progress where user_id=v_user and video_id=p_video_id for update;

  if v_inserted=1 then
    v_ranges:=public.eastudy_merge_watch_ranges(
      case when v_existing.media_version=coalesce(nullif(p_media_version,''),'legacy') then v_existing.watch_ranges else '[]'::jsonb end,
      p_watch_ranges,p_duration_seconds);
    select coalesce(sum((item->>1)::numeric-(item->>0)::numeric),0) into v_watched from jsonb_array_elements(v_ranges) item;
    v_coverage:=least(100,greatest(0,round(v_watched/greatest(p_duration_seconds,0.001)*100,2)));
    update public.user_progress set
      position_seconds=case when p_client_recorded_at>=position_updated_at then p_position_seconds else position_seconds end,
      duration_seconds=greatest(duration_seconds,p_duration_seconds),
      completion_percent=greatest(completion_percent,least(100,p_position_seconds/p_duration_seconds*100)),
      watch_coverage_percent=v_coverage,watch_ranges=v_ranges,
      completed_at=case when completed_at is not null then completed_at when v_coverage>=90 and p_position_seconds>=p_duration_seconds*.9 then now() else null end,
      last_watched_at=greatest(last_watched_at,p_client_recorded_at),media_version=coalesce(nullif(p_media_version,''),'legacy'),
      position_session_id=case when p_client_recorded_at>=position_updated_at then p_session_id else position_session_id end,
      position_sequence_no=case when p_client_recorded_at>=position_updated_at then p_sequence_no else position_sequence_no end,
      position_updated_at=greatest(position_updated_at,p_client_recorded_at),revision=revision+1
    where user_id=v_user and video_id=p_video_id;

    if p_active_seconds>0 then
      insert into public.study_activity_intervals(user_id,session_id,sequence_no,video_id,active_range)
      values(v_user,p_session_id,p_sequence_no,p_video_id,tstzrange(p_activity_started_at,p_activity_ended_at,'[)'))
      on conflict do nothing;
      select coalesce(timezone,'Asia/Shanghai') into v_tz from public.learner_goal_profiles where user_id=v_user;
      v_tz:=coalesce(v_tz,'Asia/Shanghai');
      for v_day in select generate_series((p_activity_started_at at time zone v_tz)::date,(p_activity_ended_at at time zone v_tz)::date,interval '1 day')::date loop
        v_day_start:=v_day::timestamp at time zone v_tz;
        v_day_end:=(v_day+1)::timestamp at time zone v_tz;
        select coalesce(round(sum(extract(epoch from upper(segment)-lower(segment)))),0)::integer into v_seconds
        from (select unnest(range_agg(active_range*tstzrange(v_day_start,v_day_end,'[)'))) segment
              from public.study_activity_intervals where user_id=v_user and active_range&&tstzrange(v_day_start,v_day_end,'[)')) merged;
        insert into public.daily_learning_stats(user_id,study_date,learning_seconds,updated_at)
        values(v_user,v_day,v_seconds,now()) on conflict(user_id,study_date) do update
        set learning_seconds=excluded.learning_seconds,updated_at=now();
      end loop;
    end if;
  end if;

  return jsonb_build_object('accepted',v_inserted=1,'progress',(select to_jsonb(p) from public.user_progress p where p.user_id=v_user and p.video_id=p_video_id));
end $$;

revoke all on function public.apply_study_event_v2(uuid,bigint,bigint,text,double precision,double precision,jsonb,integer,timestamptz,timestamptz,timestamptz) from public,anon;
grant execute on function public.apply_study_event_v2(uuid,bigint,bigint,text,double precision,double precision,jsonb,integer,timestamptz,timestamptz,timestamptz) to authenticated;
