-- Truthful processing state and bounded automatic lease recovery.
-- Additive only: no content rows or R2 objects are deleted.

alter table public.processing_jobs
  add column if not exists automatic_recovery_count integer not null default 0,
  add column if not exists max_automatic_recoveries integer not null default 2;

alter table public.processing_jobs drop constraint if exists processing_jobs_automatic_recovery_count_check;
alter table public.processing_jobs add constraint processing_jobs_automatic_recovery_count_check
  check (automatic_recovery_count >= 0 and max_automatic_recoveries between 0 and 10);

create or replace function public.processing_claim_local_job(
  p_worker_id text,p_token_hash text,p_lease_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.processing_jobs%rowtype;
  v_run_id uuid:=extensions.gen_random_uuid();
  v_recovery boolean:=false;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_worker_id is null or p_worker_id!~'^[A-Za-z0-9._-]{3,80}$' then raise exception 'WORKER_ID_INVALID'; end if;
  if p_token_hash is null or p_token_hash!~'^[0-9a-f]{64}$'
    or p_lease_seconds is null or p_lease_seconds<60 or p_lease_seconds>600
    then raise exception 'PROCESSING_CLAIM_ARGUMENT_INVALID'; end if;

  with exhausted as (
    update public.processing_jobs j set
      status='ERROR',
      error=jsonb_build_object('code','AUTOMATIC_RECOVERY_EXHAUSTED','message','处理节点多次失联，已停止自动恢复，请人工检查后重试','retryable',true),
      completed_at=clock_timestamp(),updated_at=clock_timestamp()
    where j.status='RUNNING' and j.cancel_requested_at is null
      and j.lease_until<clock_timestamp()
      and j.automatic_recovery_count>=j.max_automatic_recoveries
    returning j.id,j.run_id,j.stage
  )
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
  select id,run_id,'ERROR',stage,jsonb_build_object('code','AUTOMATIC_RECOVERY_EXHAUSTED') from exhausted;

  select * into v_job from public.processing_jobs j
  where j.cancel_requested_at is null and j.status in ('QUEUED','RUNNING','WAITING')
    and j.stage in ('LOCAL_DOWNLOAD','PROBE','TRANSCODE','ASR','ENRICH','LOCAL_UPLOAD')
    and j.next_run_at<=clock_timestamp() and (j.lease_until is null or j.lease_until<clock_timestamp())
  order by j.next_run_at,j.created_at for update skip locked limit 1;
  if not found then return null; end if;

  v_recovery:=v_job.status='RUNNING' and v_job.run_id is not null;
  if v_recovery then
    update private.processing_job_runs set ended_at=coalesce(ended_at,clock_timestamp()),outcome=coalesce(outcome,'LEASE_LOST')
      where job_id=v_job.id and run_id=v_job.run_id;
    insert into private.processing_job_events(job_id,run_id,kind,stage,details)
      values(v_job.id,v_job.run_id,'LEASE_LOST',v_job.stage,
        jsonb_build_object('replacedByWorkerId',p_worker_id,'automaticRecoveryCount',v_job.automatic_recovery_count+1));
  end if;

  update public.processing_jobs set status='RUNNING',provider='local-worker',worker_id=p_worker_id,
    run_id=v_run_id,telemetry_seq=0,attempt_started_at=clock_timestamp(),stage_started_at=clock_timestamp(),
    last_heartbeat_at=clock_timestamp(),last_progress_at=clock_timestamp(),metrics_reported_at=null,
    automatic_recovery_count=automatic_recovery_count+case when v_recovery then 1 else 0 end,
    worker_token_hash=p_token_hash,worker_token_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    source_token_hash=p_token_hash,source_token_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    lease_token=extensions.gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=clock_timestamp()
  where id=v_job.id returning * into v_job;
  insert into private.processing_job_runs(job_id,run_id,worker_id) values(v_job.id,v_run_id,p_worker_id);
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
    values(v_job.id,v_run_id,'CLAIMED',v_job.stage,jsonb_build_object('attempt',v_job.attempt,'automaticRecovery',v_recovery));
  return to_jsonb(v_job);
end;
$$;

create or replace function public.admin_list_processing_jobs(p_limit integer default 50)
returns table(job jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query
  select jsonb_build_object(
    'id',j.id,'videoId',j.video_id,
    'title',coalesce(v.video->>'title',v.video->>'titleZh',t.video->>'title',t.video->>'titleZh',j.input->>'title',j.input->>'titleZh',j.result->'video'->>'title'),
    'inputTitle',coalesce(j.input->>'title',j.input->>'titleZh'),
    'cover',coalesce(v.video->>'cover',t.video->>'cover',j.input->>'cover',j.result->'video'->>'cover'),
    'videoState',case when v.video is not null then 'ACTIVE' when t.video is not null then 'TRASHED' else 'MISSING' end,
    'canOpenVideo',v.video is not null,'canRetry',j.status='ERROR' and v.video is not null,
    'resultSentenceCount',case when jsonb_typeof(j.result->'sentences')='array' then jsonb_array_length(j.result->'sentences') else 0 end,
    'outputReceiptCount',(select count(*) from private.processing_output_receipts r where r.job_id=j.id),
    'status',j.status,'stage',j.stage,'progress',j.progress,'attempt',j.attempt,
    'provider',j.provider,'error',j.error,'runId',j.run_id,'message',j.work->>'message',
    'telemetry',j.work->'telemetry','attemptStartedAt',j.attempt_started_at,'stageStartedAt',j.stage_started_at,
    'lastHeartbeatAt',j.last_heartbeat_at,'lastProgressAt',j.last_progress_at,'metricsReportedAt',j.metrics_reported_at,
    'leaseUntil',j.lease_until,'nextRunAt',j.next_run_at,
    'automaticRecoveryCount',j.automatic_recovery_count,'maxAutomaticRecoveries',j.max_automatic_recoveries,
    'createdAt',j.created_at,'updatedAt',j.updated_at,'completedAt',j.completed_at,'serverNow',clock_timestamp()
  )
  from public.processing_jobs j
  cross join private.content_snapshots c
  left join lateral (
    select value as video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) value
    where value->>'id'=j.video_id limit 1
  ) v on true
  left join lateral (
    select coalesce(trash.payload->'draft'->'video',trash.payload->'published'->'video') as video
    from private.content_video_trash trash
    where trash.environment='production' and trash.video_id=j.video_id and trash.restored_at is null limit 1
  ) t on true
  where c.environment='production'
  order by j.created_at desc limit least(greatest(p_limit,1),100);
end;
$$;

revoke all on function public.processing_claim_local_job(text,text,integer) from public,anon,authenticated;
grant execute on function public.processing_claim_local_job(text,text,integer) to service_role;
revoke all on function public.admin_list_processing_jobs(integer) from public,anon;
grant execute on function public.admin_list_processing_jobs(integer) to authenticated;

comment on column public.processing_jobs.automatic_recovery_count is 'Expired RUNNING leases reclaimed automatically.';
comment on column public.processing_jobs.max_automatic_recoveries is 'Bounded automatic recovery limit before operator intervention.';
