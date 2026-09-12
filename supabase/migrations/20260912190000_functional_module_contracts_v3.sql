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
    'records',coalesce((select jsonb_agg(jsonb_build_object(
      'id',j.id,'videoId',j.video_id,'type',coalesce(j.input->>'kind','CLOUD_PIPELINE'),'mode',j.input->>'mode',
      'title',coalesce(p.video->>'title',p.video->>'titleZh',j.input->>'title',j.input->>'titleZh',j.result->'video'->>'title'),
      'inputTitle',coalesce(j.input->>'title',j.input->>'titleZh'),'cover',coalesce(p.video->>'cover',j.input->>'cover',j.result->'video'->>'cover'),
      'videoState','ACTIVE','canOpenVideo',true,'canRetry',j.status='ERROR',
      'resultSentenceCount',case when jsonb_typeof(j.result->'sentences')='array' then jsonb_array_length(j.result->'sentences') else 0 end,
      'outputReceiptCount',(select count(*) from private.processing_output_receipts r where r.job_id=j.id),
      'status',j.status,'stage',j.stage,'progress',j.progress,'attempt',j.attempt,'provider',j.provider,'error',j.error,'runId',j.run_id,'message',j.work->>'message',
      'telemetry',j.work->'telemetry','attemptStartedAt',j.attempt_started_at,'stageStartedAt',j.stage_started_at,'lastHeartbeatAt',j.last_heartbeat_at,
      'lastProgressAt',j.last_progress_at,'metricsReportedAt',j.metrics_reported_at,'leaseUntil',j.lease_until,'nextRunAt',j.next_run_at,
      'automaticRecoveryCount',j.automatic_recovery_count,'maxAutomaticRecoveries',j.max_automatic_recoveries,'createdAt',j.created_at,'updatedAt',j.updated_at,
      'completedAt',j.completed_at,'serverNow',clock_timestamp()) order by j.updated_at desc,j.id)
      from public.processing_jobs j where j.video_id=p.video_id),'[]'::jsonb)
  ) order by p.newest desc,p.video_id),'[]'::jsonb) into v_items from page_videos p;

  return jsonb_build_object('items',v_items,'total',v_total,'page',v_page,'pageSize',v_size,'serverNow',clock_timestamp());
end;
$$;

revoke all on function private.learning_access_v2(uuid) from public,anon,authenticated;
revoke all on function public.service_resolve_playback_access_v2(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.admin_list_processing_video_groups_v1(integer,integer) from public,anon;
grant execute on function public.service_resolve_playback_access_v2(uuid,uuid,text) to service_role;
grant execute on function public.admin_list_processing_video_groups_v1(integer,integer) to authenticated;

comment on function public.admin_list_processing_video_groups_v1(integer,integer) is 'Pages valid videos first, then returns all processing records for each video on that page.';
