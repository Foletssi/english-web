-- Truthful student data, entity-scoped publishing and reliable multi-device learning sync.
-- R2 objects and subtitle/media payloads are intentionally untouched.

create or replace function public.admin_publish_content_entity_v3(
  p_entity_type text,
  p_entity jsonb,
  p_expected_revision bigint
)
returns table(revision bigint, published_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content private.content_snapshots%rowtype;
  v_draft jsonb;
  v_published jsonb;
  v_array_key text;
  v_id text := nullif(trim(p_entity->>'id'), '');
  v_is_public boolean;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_entity_type not in ('creator', 'collection') or jsonb_typeof(p_entity) <> 'object' or v_id is null then
    raise exception 'INVALID_CONTENT_ENTITY';
  end if;

  select * into v_content from private.content_snapshots
  where environment = 'production' for update;
  if not found or v_content.revision is distinct from p_expected_revision then
    raise exception 'CONTENT_REVISION_CONFLICT';
  end if;

  v_array_key := case p_entity_type when 'creator' then 'creators' else 'collections' end;
  v_is_public := case p_entity_type
    when 'creator' then coalesce(p_entity->>'status', 'ACTIVE') = 'ACTIVE'
    else p_entity->>'status' = 'PUBLISHED'
  end;
  v_draft := jsonb_set(
    v_content.draft,
    array[v_array_key],
    private.upsert_json_array_item(v_content.draft->v_array_key, p_entity, 'id'),
    true
  );

  if v_is_public then
    v_published := jsonb_set(
      v_content.published,
      array[v_array_key],
      private.upsert_json_array_item(v_content.published->v_array_key, p_entity, 'id'),
      true
    );
  else
    v_published := jsonb_set(
      v_content.published,
      array[v_array_key],
      coalesce((
        select jsonb_agg(value order by ord)
        from jsonb_array_elements(coalesce(v_content.published->v_array_key, '[]'::jsonb)) with ordinality rows(value, ord)
        where value->>'id' is distinct from v_id
      ), '[]'::jsonb),
      true
    );
  end if;

  perform private.validate_content_snapshot(v_draft);
  perform private.validate_content_snapshot(v_published);
  update private.content_snapshots c
  set draft = v_draft,
      published = v_published,
      revision = c.revision + 1,
      updated_by = auth.uid(),
      updated_at = now(),
      published_at = now()
  where c.environment = 'production';

  return query select c.revision, c.published_at
  from private.content_snapshots c where c.environment = 'production';
end;
$$;

revoke all on function public.admin_publish_content_entity_v3(text,jsonb,bigint) from public, anon;
grant execute on function public.admin_publish_content_entity_v3(text,jsonb,bigint) to authenticated;

create or replace function public.get_my_learning_summary_v3()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  return jsonb_build_object(
    'totalSeconds', coalesce((select sum(s.learning_seconds) from public.daily_learning_stats s where s.user_id = v_user), 0),
    'learningDays', coalesce((select count(*) from public.daily_learning_stats s where s.user_id = v_user and s.learning_seconds > 0), 0),
    'completedVideos', coalesce((select count(*) from public.user_progress p where p.user_id = v_user and p.completed_at is not null), 0),
    'masteredWords', coalesce((select count(*) from public.user_vocabulary w where w.user_id = v_user and w.state = 'mastered'), 0)
  );
end;
$$;

revoke all on function public.get_my_learning_summary_v3() from public, anon;
grant execute on function public.get_my_learning_summary_v3() to authenticated;

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

  -- Serialize all learning aggregates for one learner, even across different videos.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  insert into public.study_events(user_id,event_type,video_id,payload,occurred_at,session_id,sequence_no,client_recorded_at,active_seconds)
  values(v_user,'learning_sync_v2',p_video_id,jsonb_build_object('mediaVersion',coalesce(nullif(p_media_version,''),'unknown'),'watchRanges',p_watch_ranges),now(),p_session_id,p_sequence_no,p_client_recorded_at,p_active_seconds)
  on conflict(user_id,session_id,sequence_no) where session_id is not null do nothing;
  get diagnostics v_inserted=row_count;

  -- Epoch makes the first real client position eligible for last-write comparison.
  insert into public.user_progress(user_id,video_id,position_updated_at)
  values(v_user,p_video_id,'epoch'::timestamptz)
  on conflict(user_id,video_id) do nothing;
  select * into v_existing from public.user_progress where user_id=v_user and video_id=p_video_id for update;

  if v_inserted=1 then
    v_ranges:=public.eastudy_merge_watch_ranges(
      case when v_existing.media_version=coalesce(nullif(p_media_version,''),'unknown') then v_existing.watch_ranges else '[]'::jsonb end,
      p_watch_ranges,p_duration_seconds);
    select coalesce(sum((item->>1)::numeric-(item->>0)::numeric),0) into v_watched from jsonb_array_elements(v_ranges) item;
    v_coverage:=least(100,greatest(0,round(v_watched/greatest(p_duration_seconds,0.001)*100,2)));
    update public.user_progress set
      position_seconds=case when p_client_recorded_at>=position_updated_at then p_position_seconds else position_seconds end,
      duration_seconds=greatest(duration_seconds,p_duration_seconds),
      completion_percent=greatest(completion_percent,least(100,p_position_seconds/p_duration_seconds*100)),
      watch_coverage_percent=v_coverage,watch_ranges=v_ranges,
      completed_at=case when completed_at is not null then completed_at when v_coverage>=90 and p_position_seconds>=p_duration_seconds*.9 then now() else null end,
      last_watched_at=greatest(last_watched_at,p_client_recorded_at),media_version=coalesce(nullif(p_media_version,''),'unknown'),
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

-- Replace fine-grained production tags with evidence-linked broad categories.
do $$
declare
  v_draft jsonb;
  v_published jsonb;
  v_revision bigint;
  v_evidence_first jsonb;
  v_evidence_second jsonb;
begin
  select draft,published,revision into v_draft,v_published,v_revision
  from private.content_snapshots where environment='production' for update;
  if v_revision is null then raise exception 'PRODUCTION_CONTENT_SNAPSHOT_MISSING'; end if;

  insert into private.content_snapshot_repair_backups(repair_id,environment,draft,published,revision)
  values('beta6.30.0-truthful-player-learning-v3','production',v_draft,v_published,v_revision)
  on conflict(repair_id) do nothing;

  select coalesce(jsonb_agg(value->'id' order by ord),'[]'::jsonb) into v_evidence_first
  from jsonb_array_elements(coalesce(v_published->'sentences'->'1788926081632','[]'::jsonb)) with ordinality rows(value,ord)
  where ord<=3 and nullif(value->>'id','') is not null;
  select coalesce(jsonb_agg(value->'id' order by ord),'[]'::jsonb) into v_evidence_second
  from jsonb_array_elements(coalesce(v_published->'sentences'->'1788957611645','[]'::jsonb)) with ordinality rows(value,ord)
  where ord<=3 and nullif(value->>'id','') is not null;
  if jsonb_array_length(v_evidence_first)=0 or jsonb_array_length(v_evidence_second)=0 then
    raise exception 'PRODUCTION_SUBTITLE_EVIDENCE_MISSING';
  end if;

  select jsonb_set(v_draft,'{videos}',coalesce(jsonb_agg(
    case value->>'id'
      when '1788926081632' then value || jsonb_build_object(
        'tagIds',jsonb_build_array('daily-life','spoken-english','friendship'),
        'tagAssignments',jsonb_build_array(
          jsonb_build_object('tagId','daily-life','sentenceIds',v_evidence_first,'reasonZh','字幕记录真实的一周生活场景','reviewStatus','APPROVED','source','human-backfill'),
          jsonb_build_object('tagId','spoken-english','sentenceIds',v_evidence_first,'reasonZh','字幕包含连续自然口语表达','reviewStatus','APPROVED','source','human-backfill'),
          jsonb_build_object('tagId','friendship','sentenceIds',v_evidence_first,'reasonZh','视频包含与朋友交流的生活片段','reviewStatus','APPROVED','source','human-backfill')))
      when '1788957611645' then value || jsonb_build_object(
        'tagIds',jsonb_build_array('daily-life','spoken-english','food-culture'),
        'tagAssignments',jsonb_build_array(
          jsonb_build_object('tagId','daily-life','sentenceIds',v_evidence_second,'reasonZh','字幕记录忙碌一天的真实生活','reviewStatus','APPROVED','source','human-backfill'),
          jsonb_build_object('tagId','spoken-english','sentenceIds',v_evidence_second,'reasonZh','字幕包含连续自然口语表达','reviewStatus','APPROVED','source','human-backfill'),
          jsonb_build_object('tagId','food-culture','sentenceIds',v_evidence_second,'reasonZh','视频包含饮品和用餐生活语境','reviewStatus','APPROVED','source','human-backfill')))
      else value end order by ord
  ),'[]'::jsonb),true) into v_draft
  from jsonb_array_elements(coalesce(v_draft->'videos','[]'::jsonb)) with ordinality rows(value,ord);

  select jsonb_set(v_published,'{videos}',coalesce(jsonb_agg(
    case value->>'id'
      when '1788926081632' then value || jsonb_build_object(
        'tagIds',jsonb_build_array('daily-life','spoken-english','friendship'),
        'tagAssignments',jsonb_build_array(
          jsonb_build_object('tagId','daily-life','sentenceIds',v_evidence_first,'reasonZh','字幕记录真实的一周生活场景','reviewStatus','APPROVED','source','human-backfill'),
          jsonb_build_object('tagId','spoken-english','sentenceIds',v_evidence_first,'reasonZh','字幕包含连续自然口语表达','reviewStatus','APPROVED','source','human-backfill'),
          jsonb_build_object('tagId','friendship','sentenceIds',v_evidence_first,'reasonZh','视频包含与朋友交流的生活片段','reviewStatus','APPROVED','source','human-backfill')))
      when '1788957611645' then value || jsonb_build_object(
        'tagIds',jsonb_build_array('daily-life','spoken-english','food-culture'),
        'tagAssignments',jsonb_build_array(
          jsonb_build_object('tagId','daily-life','sentenceIds',v_evidence_second,'reasonZh','字幕记录忙碌一天的真实生活','reviewStatus','APPROVED','source','human-backfill'),
          jsonb_build_object('tagId','spoken-english','sentenceIds',v_evidence_second,'reasonZh','字幕包含连续自然口语表达','reviewStatus','APPROVED','source','human-backfill'),
          jsonb_build_object('tagId','food-culture','sentenceIds',v_evidence_second,'reasonZh','视频包含饮品和用餐生活语境','reviewStatus','APPROVED','source','human-backfill')))
      else value end order by ord
  ),'[]'::jsonb),true) into v_published
  from jsonb_array_elements(coalesce(v_published->'videos','[]'::jsonb)) with ordinality rows(value,ord);

  perform private.validate_content_snapshot(v_draft);
  perform private.validate_content_snapshot(v_published);
  update private.content_snapshots
  set draft=v_draft,published=v_published,revision=revision+1,updated_at=now(),published_at=now()
  where environment='production' and revision=v_revision;
  if not found then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
end $$;
