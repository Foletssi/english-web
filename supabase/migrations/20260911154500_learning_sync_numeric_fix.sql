-- Keep study-event coverage arithmetic in numeric space so the two-argument
-- round() call is valid on PostgreSQL.

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

  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));
  insert into public.study_events(user_id,event_type,video_id,payload,occurred_at,session_id,sequence_no,client_recorded_at,active_seconds)
  values(v_user,'learning_sync_v2',p_video_id,jsonb_build_object('mediaVersion',coalesce(nullif(p_media_version,''),'unknown'),'watchRanges',p_watch_ranges),now(),p_session_id,p_sequence_no,p_client_recorded_at,p_active_seconds)
  on conflict(user_id,session_id,sequence_no) where session_id is not null do nothing;
  get diagnostics v_inserted=row_count;

  insert into public.user_progress(user_id,video_id,position_updated_at)
  values(v_user,p_video_id,'epoch'::timestamptz)
  on conflict(user_id,video_id) do nothing;
  select * into v_existing from public.user_progress where user_id=v_user and video_id=p_video_id for update;

  if v_inserted=1 then
    v_ranges:=public.eastudy_merge_watch_ranges(
      case when v_existing.media_version=coalesce(nullif(p_media_version,''),'unknown') then v_existing.watch_ranges else '[]'::jsonb end,
      p_watch_ranges,p_duration_seconds);
    select coalesce(sum((item->>1)::numeric-(item->>0)::numeric),0)
      into v_watched from jsonb_array_elements(v_ranges) item;
    v_coverage:=least(100::numeric,greatest(0::numeric,
      round(v_watched/greatest(p_duration_seconds::numeric,0.001::numeric)*100::numeric,2)));
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

  return jsonb_build_object('accepted',v_inserted=1,'progress',(select to_jsonb(progress) from public.user_progress progress where progress.user_id=v_user and progress.video_id=p_video_id));
end $$;

revoke all on function public.apply_study_event_v2(uuid,bigint,bigint,text,double precision,double precision,jsonb,integer,timestamptz,timestamptz,timestamptz)
  from public,anon;
grant execute on function public.apply_study_event_v2(uuid,bigint,bigint,text,double precision,double precision,jsonb,integer,timestamptz,timestamptz,timestamptz)
  to authenticated;
