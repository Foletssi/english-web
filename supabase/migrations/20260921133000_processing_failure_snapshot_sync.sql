-- Keep the control console truthful when a processing run fails.
-- This only updates the draft snapshot metadata; it does not delete media or
-- change the published snapshot.

create or replace function private.sync_processing_failure_snapshot_v1(
  p_job public.processing_jobs,
  p_error jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content private.content_snapshots%rowtype;
  v_video jsonb;
  v_display jsonb;
  v_pointer text;
begin
  select * into v_content
  from private.content_snapshots
  where environment = 'production'
  for update;
  if not found then return; end if;

  select value into v_video
  from jsonb_array_elements(coalesce(v_content.draft->'videos', '[]'::jsonb)) value
  where value->>'id' = p_job.video_id
  limit 1;
  if v_video is null then return; end if;

  v_pointer := case when p_job.input->>'kind' = 'LEARNING_REPAIR'
    then 'learningRepairJobId' else 'processingJobId' end;
  v_video := v_video
    || jsonb_build_object(
      'pipelineStatus', 'ERROR',
      v_pointer, p_job.id::text,
      'processingError', coalesce(p_error, '{}'::jsonb),
      'updatedAt', clock_timestamp()
    );

  v_display := private.processing_job_admin_summary_v1(p_job, v_video);
  v_content.draft := jsonb_set(
    v_content.draft,
    '{videos}',
    private.upsert_json_array_item(v_content.draft->'videos', v_video, 'id'),
    true
  );
  v_content.draft := jsonb_set(
    v_content.draft,
    '{jobs}',
    private.upsert_json_array_item(v_content.draft->'jobs', v_display, 'id'),
    true
  );
  perform private.validate_content_snapshot(v_content.draft);
  update private.content_snapshots
  set draft = v_content.draft,
      revision = revision + 1,
      updated_at = clock_timestamp()
  where environment = 'production';
end;
$$;

create or replace function public.processing_fail_job_v2(
  p_job_id uuid,
  p_run_id uuid,
  p_token text,
  p_worker_id text,
  p_error jsonb,
  p_retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.processing_jobs%rowtype;
  v_error jsonb;
begin
  select * into v_job from private.processing_lock_run(p_job_id,p_run_id,p_token,p_worker_id);
  v_error := coalesce(p_error,'{}'::jsonb)
    || jsonb_build_object('retryable',p_retryable,'stage',v_job.stage,'runId',p_run_id);
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
    values(p_job_id,p_run_id,'ERROR',v_job.stage,v_error);
  update private.processing_job_runs
  set ended_at=now(),outcome='ERROR',error=v_error
  where job_id=p_job_id and run_id=p_run_id;
  update public.processing_jobs
  set status='ERROR',error=v_error,lease_token=null,lease_until=null,
    worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,
    source_token_expires_at=null,completed_at=now(),updated_at=now()
  where id=p_job_id returning * into v_job;
  perform private.sync_processing_failure_snapshot_v1(v_job,v_error);
  return to_jsonb(v_job);
end;
$$;

-- Automatic recovery exhaustion takes the same truthful snapshot path.
create or replace function public.processing_claim_local_job(
  p_worker_id text,
  p_token_hash text,
  p_lease_seconds integer default 180
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
  v_exhausted public.processing_jobs%rowtype;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_worker_id is null or p_worker_id!~'^[A-Za-z0-9._-]{3,80}$' then raise exception 'WORKER_ID_INVALID'; end if;
  if p_token_hash is null or p_token_hash!~'^[0-9a-f]{64}$'
    or p_lease_seconds is null or p_lease_seconds<60 or p_lease_seconds>600
    then raise exception 'PROCESSING_CLAIM_ARGUMENT_INVALID'; end if;

  for v_exhausted in
    update public.processing_jobs j set
      status='ERROR',
      error=jsonb_build_object('code','AUTOMATIC_RECOVERY_EXHAUSTED','message','处理节点多次失联，已停止自动恢复，请人工检查后重试','retryable',true),
      completed_at=clock_timestamp(),updated_at=clock_timestamp()
    where j.status='RUNNING' and j.cancel_requested_at is null
      and j.lease_until<clock_timestamp()
      and j.automatic_recovery_count>=j.max_automatic_recoveries
    returning j.*
  loop
    insert into private.processing_job_events(job_id,run_id,kind,stage,details)
      values(v_exhausted.id,v_exhausted.run_id,'ERROR',v_exhausted.stage,v_exhausted.error);
    perform private.sync_processing_failure_snapshot_v1(v_exhausted,v_exhausted.error);
  end loop;

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

revoke all on function private.sync_processing_failure_snapshot_v1(public.processing_jobs,jsonb) from public,anon,authenticated;
revoke all on function public.processing_fail_job_v2(uuid,uuid,text,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.processing_fail_job_v2(uuid,uuid,text,text,jsonb,boolean) to service_role;
revoke all on function public.processing_claim_local_job(text,text,integer) from public,anon,authenticated;
grant execute on function public.processing_claim_local_job(text,text,integer) to service_role;
