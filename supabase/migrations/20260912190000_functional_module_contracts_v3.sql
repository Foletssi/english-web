-- Eastudy functional module corrections v3.
-- Forward-only: tightens learner roles/playback binding and pages processing work by video.

create or replace function private.learning_access_v2(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case
    when p_user_id is null then jsonb_build_object('canEnterLearning',false,'canPlay',false,'reason','AUTH_REQUIRED','kind','NONE')
    when not exists(select 1 from public.profiles p where p.id=p_user_id and p.is_active is true)
      then jsonb_build_object('canEnterLearning',false,'canPlay',false,'reason','ACCOUNT_UNAVAILABLE','kind','NONE')
    when exists(
      select 1 from private.admin_memberships m where m.user_id=p_user_id and m.status='active'
      union all
      select 1 from public.profiles p where p.id=p_user_id and lower(coalesce(p.role,''))='admin' and p.is_active is true
    ) then jsonb_build_object('canEnterLearning',true,'canPlay',true,'reason','OK','kind','ADMIN','expiresAt',null)
    when not exists(select 1 from public.profiles p where p.id=p_user_id and lower(coalesce(p.role,'')) in ('learner','student'))
      then jsonb_build_object('canEnterLearning',false,'canPlay',false,'reason','ROLE_FORBIDDEN','kind','NONE')
    when exists(select 1 from public.membership_entitlements e where e.user_id=p_user_id and e.product_id='eastudy_pro' and e.revoked_at is not null)
      then jsonb_build_object('canEnterLearning',false,'canPlay',false,'reason','VIP_REVOKED','kind','LEARNER',
        'expiresAt',(select e.expires_at from public.membership_entitlements e where e.user_id=p_user_id and e.product_id='eastudy_pro'))
    when not exists(select 1 from public.membership_entitlements e where e.user_id=p_user_id and e.product_id='eastudy_pro')
      then jsonb_build_object('canEnterLearning',false,'canPlay',false,'reason','VIP_REQUIRED','kind','LEARNER','expiresAt',null)
    when exists(select 1 from public.membership_entitlements e where e.user_id=p_user_id and e.product_id='eastudy_pro' and e.expires_at<=now())
      then jsonb_build_object('canEnterLearning',false,'canPlay',false,'reason','VIP_EXPIRED','kind','LEARNER',
        'expiresAt',(select e.expires_at from public.membership_entitlements e where e.user_id=p_user_id and e.product_id='eastudy_pro'))
    else jsonb_build_object('canEnterLearning',true,'canPlay',true,'reason','OK','kind','LEARNER',
      'expiresAt',(select e.expires_at from public.membership_entitlements e where e.user_id=p_user_id and e.product_id='eastudy_pro'))
  end;
$$;

create or replace function public.service_resolve_playback_access_v2(p_user_id uuid,p_job_id uuid,p_path text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_access jsonb; v_key text; v_job public.processing_jobs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_access:=private.learning_access_v2(p_user_id);
  if coalesce((v_access->>'canPlay')::boolean,false) is not true then return v_access; end if;
  if p_path !~ '^(cover\.webp|720p/(index\.m3u8|segment_[0-9]{5}\.ts))$' then
    return jsonb_build_object('canPlay',false,'reason','MEDIA_PATH_INVALID');
  end if;
  select * into v_job from public.processing_jobs j where j.id=p_job_id and j.status='REVIEW';
  if not found
    or exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=v_job.video_id and t.restored_at is null)
    or not exists(
      select 1 from private.content_snapshots c,
        jsonb_array_elements(coalesce(c.published->'videos','[]'::jsonb)) v
      where c.environment='production'
        and v->>'id'=v_job.video_id
        and v->>'status'='PUBLISHED'
        and v->>'processingJobId'=p_job_id::text
    ) then return jsonb_build_object('canPlay',false,'reason','PLAYBACK_FORBIDDEN');
  end if;
  v_key:='videos/'||substring(v_job.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||v_job.id::text||'/'||
    case when v_job.output_run_id is null then p_path else 'runs/'||v_job.output_run_id::text||'/'||p_path end;
  return v_access||jsonb_build_object('canPlay',true,'objectKey',v_key,'prefix',left(v_key,length(v_key)-length(p_path)));
end;
$$;

create or replace function private.processing_job_admin_summary_v1(p_job public.processing_jobs,p_video jsonb)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id',p_job.id,'videoId',p_job.video_id,'type',coalesce(p_job.input->>'kind','CLOUD_PIPELINE'),'mode',p_job.input->>'mode',
    'title',coalesce(p_video->>'title',p_video->>'titleZh',p_job.input->>'title',p_job.input->>'titleZh',p_job.result->'video'->>'title'),
    'inputTitle',coalesce(p_job.input->>'title',p_job.input->>'titleZh'),'cover',coalesce(p_video->>'cover',p_job.input->>'cover',p_job.result->'video'->>'cover'),
    'videoState','ACTIVE','canOpenVideo',true,'canRetry',p_job.status='ERROR',
    'resultSentenceCount',case when jsonb_typeof(p_job.result->'sentences')='array' then jsonb_array_length(p_job.result->'sentences') else 0 end,
    'outputReceiptCount',(select count(*) from private.processing_output_receipts r where r.job_id=p_job.id),
    'status',p_job.status,'stage',p_job.stage,'progress',p_job.progress,'attempt',p_job.attempt,'provider',p_job.provider,'error',p_job.error,
    'runId',p_job.run_id,'message',p_job.work->>'message','telemetry',p_job.work->'telemetry','attemptStartedAt',p_job.attempt_started_at,
    'stageStartedAt',p_job.stage_started_at,'lastHeartbeatAt',p_job.last_heartbeat_at,'lastProgressAt',p_job.last_progress_at,
    'metricsReportedAt',p_job.metrics_reported_at,'leaseUntil',p_job.lease_until,'nextRunAt',p_job.next_run_at,
    'automaticRecoveryCount',p_job.automatic_recovery_count,'maxAutomaticRecoveries',p_job.max_automatic_recoveries,
    'createdAt',p_job.created_at,'updatedAt',p_job.updated_at,'completedAt',p_job.completed_at,'serverNow',clock_timestamp()
  );
$$;

create or replace function public.admin_list_processing_video_groups_v1(p_page integer default 1,p_page_size integer default 50)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_page integer:=greatest(coalesce(p_page,1),1); v_size integer:=least(greatest(coalesce(p_page_size,50),1),100); v_total bigint; v_items jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;

  with eligible as (
    select j.video_id,j.updated_at
    from public.processing_jobs j
    cross join private.content_snapshots c
    join lateral (
      select value video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) value
      where value->>'id'=j.video_id limit 1
    ) v on true
    where c.environment='production'
      and not exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
  ) select count(distinct video_id) into v_total from eligible;

  with eligible as (
    select j.video_id,j.updated_at,v.video
    from public.processing_jobs j
    cross join private.content_snapshots c
    join lateral (
      select value video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) value
      where value->>'id'=j.video_id limit 1
    ) v on true
    where c.environment='production'
      and not exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
  ), latest as (
    select distinct on (video_id) video_id,video,updated_at newest
    from eligible order by video_id,updated_at desc
  ), page_videos as (
    select * from latest order by newest desc,video_id
    offset (v_page-1)*v_size limit v_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'videoId',p.video_id,'video',p.video,'recordCount',(select count(*) from public.processing_jobs c where c.video_id=p.video_id),
    'records',coalesce((select jsonb_agg(private.processing_job_admin_summary_v1(j,p.video) order by j.updated_at desc,j.id)
      from (select x.* from public.processing_jobs x where x.video_id=p.video_id order by (x.status in ('RUNNING','QUEUED','WAITING')) desc,x.updated_at desc,x.id limit 5) j),'[]'::jsonb)
  ) order by p.newest desc,p.video_id),'[]'::jsonb) into v_items from page_videos p;

  return jsonb_build_object('items',v_items,'total',v_total,'page',v_page,'pageSize',v_size,'serverNow',clock_timestamp());
end;
$$;

create or replace function public.admin_list_processing_video_history_v1(p_video_id text,p_page integer default 1,p_page_size integer default 25)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_page integer:=greatest(coalesce(p_page,1),1); v_size integer:=least(greatest(coalesce(p_page_size,25),1),100); v_total bigint; v_items jsonb; v_video jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if coalesce(p_video_id,'') !~ '^[0-9]+$' then raise exception 'VIDEO_ID_INVALID'; end if;
  select value into v_video from private.content_snapshots c,
    jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) value
    where c.environment='production' and value->>'id'=p_video_id limit 1;
  if v_video is null then raise exception 'VIDEO_NOT_FOUND'; end if;
  select count(*) into v_total from public.processing_jobs j where j.video_id=p_video_id;
  select coalesce(jsonb_agg(private.processing_job_admin_summary_v1(j,v_video) order by j.updated_at desc,j.id),'[]'::jsonb) into v_items
  from (
    select * from public.processing_jobs
    where video_id=p_video_id
    order by updated_at desc,id
    offset (v_page-1)*v_size limit v_size
  ) j;
  return jsonb_build_object('items',v_items,'total',v_total,'page',v_page,'pageSize',v_size,'serverNow',clock_timestamp());
end;
$$;

create or replace function public.admin_get_processing_job_v1(p_job_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_item jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select private.processing_job_admin_summary_v1(j,v.video) into v_item
  from public.processing_jobs j
  cross join private.content_snapshots c
  join lateral (
    select value video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) value
    where value->>'id'=j.video_id limit 1
  ) v on true
  where j.id=p_job_id and c.environment='production'
    and not exists(
      select 1 from private.content_video_trash t
      where t.environment='production' and t.video_id=j.video_id and t.restored_at is null
    );
  if v_item is null then raise exception 'PROCESSING_JOB_NOT_FOUND'; end if;
  return v_item;
end;
$$;

revoke all on function private.learning_access_v2(uuid) from public,anon,authenticated;
revoke all on function private.processing_job_admin_summary_v1(public.processing_jobs,jsonb) from public,anon,authenticated;
revoke all on function public.service_resolve_playback_access_v2(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.admin_list_processing_video_groups_v1(integer,integer) from public,anon;
revoke all on function public.admin_list_processing_video_history_v1(text,integer,integer) from public,anon;
revoke all on function public.admin_get_processing_job_v1(uuid) from public,anon;
grant execute on function public.service_resolve_playback_access_v2(uuid,uuid,text) to service_role;
grant execute on function public.admin_list_processing_video_groups_v1(integer,integer) to authenticated;
grant execute on function public.admin_list_processing_video_history_v1(text,integer,integer) to authenticated;
grant execute on function public.admin_get_processing_job_v1(uuid) to authenticated;

comment on function public.admin_list_processing_video_groups_v1(integer,integer) is 'Pages valid videos first, then returns a bounded current record summary for each video.';
comment on function public.admin_list_processing_video_history_v1(text,integer,integer) is 'Pages processing history independently for one active video.';
comment on function public.admin_get_processing_job_v1(uuid) is 'Returns one processing record for an active video so paged history links remain addressable.';
