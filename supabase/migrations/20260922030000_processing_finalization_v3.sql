-- Replace the ambiguous v2 terminal protocol with one reconciled, resumable v3 path.
-- Existing jobs, run checkpoints, AI caches, output receipts and R2 objects are retained.
begin;
set local lock_timeout='2s';
set local statement_timeout='15min';

alter table private.processing_job_runs
  drop constraint if exists processing_job_runs_outcome_check;
alter table private.processing_job_runs
  add constraint processing_job_runs_outcome_check
  check (outcome in ('REVIEW','ERROR','CANCELLED','LEASE_LOST','DEFERRED'));

create table private.processing_defer_receipts (
  job_id uuid not null references public.processing_jobs(id) on delete cascade,
  run_id uuid not null,
  worker_id text not null,
  token_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(job_id,run_id),
  foreign key(job_id,run_id) references private.processing_job_runs(job_id,run_id)
);
alter table private.processing_defer_receipts enable row level security;
revoke all on private.processing_defer_receipts from public,anon,authenticated,service_role;

alter function private.processing_commit_leased_result_pre_receipt_v2(uuid,uuid,text,text,jsonb,jsonb)
  rename to processing_commit_leased_result_core;
alter function private.processing_commit_leased_result_core(uuid,uuid,text,text,jsonb,jsonb)
  reset statement_timeout;
alter function private.processing_commit_leased_result_core(uuid,uuid,text,text,jsonb,jsonb)
  reset lock_timeout;
revoke all on function private.processing_commit_leased_result_core(uuid,uuid,text,text,jsonb,jsonb)
  from public,anon,authenticated,service_role;

create function public.processing_commit_leased_result_v3(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_result jsonb,p_manifest jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_receipt private.processing_commit_receipts%rowtype;
  v_result jsonb;
  v_hash text:=encode(extensions.digest(jsonb_build_array(p_result,p_manifest)::text,'sha256'),'hex');
  v_token_hash text:=encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex');
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  -- All terminal paths keep the production snapshot -> job lock order.
  perform 1 from private.content_snapshots where environment='production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;
  perform 1 from public.processing_jobs where id=p_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  select * into v_receipt from private.processing_commit_receipts
    where job_id=p_job_id and run_id=p_run_id;
  if found then
    if v_receipt.worker_id is distinct from p_worker_id
      or v_receipt.token_hash is distinct from v_token_hash
      or v_receipt.request_hash is distinct from v_hash
    then raise exception 'COMMIT_RECEIPT_CONFLICT'; end if;
    return v_receipt.result;
  end if;
  v_result:=private.processing_commit_leased_result_core(
    p_job_id,p_run_id,p_token,p_worker_id,p_result,p_manifest)-'snapshot';
  insert into private.processing_commit_receipts(job_id,run_id,worker_id,token_hash,request_hash,result)
    values(p_job_id,p_run_id,p_worker_id,v_token_hash,v_hash,v_result);
  return v_result;
end $$;
alter function public.processing_commit_leased_result_v3(uuid,uuid,text,text,jsonb,jsonb)
  set statement_timeout='180s';
alter function public.processing_commit_leased_result_v3(uuid,uuid,text,text,jsonb,jsonb)
  set lock_timeout='2s';

create function public.processing_finalization_status_v3(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_job public.processing_jobs%rowtype;
  v_commit private.processing_commit_receipts%rowtype;
  v_defer private.processing_defer_receipts%rowtype;
  v_token_hash text:=encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex');
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_job_id is null or p_run_id is null or p_worker_id is null
    or p_token is null or length(p_token) not between 32 and 256
  then raise exception 'FINALIZATION_ARGUMENT_INVALID'; end if;
  select * into v_commit from private.processing_commit_receipts
    where job_id=p_job_id and run_id=p_run_id;
  if found then
    if v_commit.worker_id is distinct from p_worker_id or v_commit.token_hash is distinct from v_token_hash
      then raise exception 'FINALIZATION_RECEIPT_CONFLICT'; end if;
    return jsonb_build_object('state','COMMITTED','result',v_commit.result);
  end if;
  select * into v_defer from private.processing_defer_receipts
    where job_id=p_job_id and run_id=p_run_id;
  if found then
    if v_defer.worker_id is distinct from p_worker_id or v_defer.token_hash is distinct from v_token_hash
      then raise exception 'FINALIZATION_RECEIPT_CONFLICT'; end if;
    return jsonb_build_object('state','DEFERRED','job',v_defer.result);
  end if;
  select * into v_job from public.processing_jobs where id=p_job_id;
  if not found then return jsonb_build_object('state','STALE','reason','JOB_NOT_FOUND'); end if;
  if v_job.status='REVIEW' and v_job.output_run_id=p_run_id
    then return jsonb_build_object('state','COMMITTED'); end if;
  if v_job.status='RUNNING' and v_job.cancel_requested_at is null
    and v_job.run_id=p_run_id and v_job.worker_id=p_worker_id
    and v_job.worker_token_hash=v_token_hash
    and v_job.lease_until>clock_timestamp()
    and v_job.worker_token_expires_at>clock_timestamp()
  then return jsonb_build_object('state','PENDING'); end if;
  return jsonb_build_object('state','STALE','jobStatus',v_job.status,'jobRunId',v_job.run_id);
end $$;

create function public.processing_defer_job_v3(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_error jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_job public.processing_jobs%rowtype;
  v_commit private.processing_commit_receipts%rowtype;
  v_defer private.processing_defer_receipts%rowtype;
  v_result jsonb;
  v_code text:=coalesce(p_error->>'code','');
  v_token_hash text:=encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex');
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if v_code not in ('EDGE_UNAVAILABLE','EDGE_INVALID_RESPONSE','REQUEST_FAILED',
    'DB_STATEMENT_TIMEOUT','DB_LOCK_TIMEOUT','DB_SERIALIZATION_RETRY','DB_DEADLOCK_RETRY')
  then raise exception 'FINALIZATION_DEFER_NOT_ALLOWED'; end if;
  perform 1 from private.content_snapshots where environment='production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;
  select * into v_commit from private.processing_commit_receipts
    where job_id=p_job_id and run_id=p_run_id;
  if found then
    if v_commit.worker_id is distinct from p_worker_id or v_commit.token_hash is distinct from v_token_hash
      then raise exception 'FINALIZATION_RECEIPT_CONFLICT'; end if;
    return jsonb_build_object('state','COMMITTED','result',v_commit.result);
  end if;
  select * into v_defer from private.processing_defer_receipts
    where job_id=p_job_id and run_id=p_run_id;
  if found then
    if v_defer.worker_id is distinct from p_worker_id or v_defer.token_hash is distinct from v_token_hash
      then raise exception 'FINALIZATION_RECEIPT_CONFLICT'; end if;
    return jsonb_build_object('state','DEFERRED','job',v_defer.result);
  end if;
  select * into v_job from private.processing_lock_run(p_job_id,p_run_id,p_token,p_worker_id);
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
    values(p_job_id,p_run_id,'RETRY',v_job.stage,
      jsonb_build_object('source','worker-finalization-v3','previousError',coalesce(p_error,'{}'::jsonb)));
  update private.processing_job_runs set ended_at=clock_timestamp(),outcome='DEFERRED',error=p_error
    where job_id=p_job_id and run_id=p_run_id;
  update public.processing_jobs set
    status='QUEUED',automatic_recovery_count=0,attempt=attempt+1,
    cancel_requested_at=null,error=null,lease_token=null,lease_until=null,
    next_run_at=clock_timestamp()+interval '5 seconds',worker_id=null,
    worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,
    source_token_expires_at=null,completed_at=null,run_id=null,telemetry_seq=0,
    attempt_started_at=null,stage_started_at=null,last_heartbeat_at=null,last_progress_at=null,
    metrics_reported_at=null,updated_at=clock_timestamp(),
    work=(coalesce(work,'{}'::jsonb)-'telemetry')||jsonb_build_object(
      'message','最终提交暂时不可用；原任务将复用成品、AI 缓存和上传回执继续',
      'resumePosition',jsonb_build_object('verified',true,'phase','final','stage',v_job.stage,
        'progress',v_job.progress,'runId',p_run_id))
    where id=p_job_id returning * into v_job;
  perform private.sync_processing_retry_snapshot_v1(v_job);
  v_result:=to_jsonb(v_job);
  insert into private.processing_defer_receipts(job_id,run_id,worker_id,token_hash,result)
    values(p_job_id,p_run_id,p_worker_id,v_token_hash,v_result);
  return jsonb_build_object('state','DEFERRED','job',v_result);
end $$;
alter function public.processing_defer_job_v3(uuid,uuid,text,text,jsonb)
  set statement_timeout='60s';
alter function public.processing_defer_job_v3(uuid,uuid,text,text,jsonb)
  set lock_timeout='2s';

create function public.processing_fail_job_v3(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_error jsonb,p_retryable boolean default true
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_job public.processing_jobs%rowtype;
  v_run private.processing_job_runs%rowtype;
  v_error jsonb;
  v_token_hash text:=encode(extensions.digest(coalesce(p_token,''),'sha256'),'hex');
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into v_run from private.processing_job_runs where job_id=p_job_id and run_id=p_run_id;
  select * into v_job from public.processing_jobs where id=p_job_id;
  if found and v_job.status='ERROR' and v_run.outcome='ERROR'
    and v_run.worker_id=p_worker_id and v_run.error->>'tokenHash'=v_token_hash
  then return to_jsonb(v_job); end if;
  perform 1 from private.content_snapshots where environment='production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;
  select * into v_job from private.processing_lock_run(p_job_id,p_run_id,p_token,p_worker_id);
  v_error:=coalesce(p_error,'{}'::jsonb)||jsonb_build_object(
    'retryable',p_retryable,'stage',v_job.stage,'runId',p_run_id);
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
    values(p_job_id,p_run_id,'ERROR',v_job.stage,v_error);
  update private.processing_job_runs set ended_at=clock_timestamp(),outcome='ERROR',
    error=v_error||jsonb_build_object('tokenHash',v_token_hash)
    where job_id=p_job_id and run_id=p_run_id;
  update public.processing_jobs set status='ERROR',error=v_error,lease_token=null,lease_until=null,
    worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,
    source_token_expires_at=null,completed_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=p_job_id returning * into v_job;
  perform private.sync_processing_failure_snapshot_v1(v_job,v_error);
  return to_jsonb(v_job);
end $$;
alter function public.processing_fail_job_v3(uuid,uuid,text,text,jsonb,boolean)
  set statement_timeout='60s';
alter function public.processing_fail_job_v3(uuid,uuid,text,text,jsonb,boolean)
  set lock_timeout='2s';

revoke all on function public.processing_commit_leased_result_v3(uuid,uuid,text,text,jsonb,jsonb)
  from public,anon,authenticated;
revoke all on function public.processing_finalization_status_v3(uuid,uuid,text,text)
  from public,anon,authenticated;
revoke all on function public.processing_defer_job_v3(uuid,uuid,text,text,jsonb)
  from public,anon,authenticated;
revoke all on function public.processing_fail_job_v3(uuid,uuid,text,text,jsonb,boolean)
  from public,anon,authenticated;
grant execute on function public.processing_commit_leased_result_v3(uuid,uuid,text,text,jsonb,jsonb) to service_role;
grant execute on function public.processing_finalization_status_v3(uuid,uuid,text,text) to service_role;
grant execute on function public.processing_defer_job_v3(uuid,uuid,text,text,jsonb) to service_role;
grant execute on function public.processing_fail_job_v3(uuid,uuid,text,text,jsonb,boolean) to service_role;

-- Clean break: terminal v1/v2 RPCs are no longer callable after v3 exists.
drop function public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb);
drop function public.processing_fail_job_v2(uuid,uuid,text,text,jsonb,boolean);

-- Resume only the known interrupted jobs, preserving their local checkpoints and
-- leaving every successful upload receipt and R2 object intact.
do $resume$
declare
  jid uuid;
  previous public.processing_jobs%rowtype;
  current_job public.processing_jobs%rowtype;
begin
  foreach jid in array array[
    'eff1647d-974b-4e66-874c-d0f368470d17'::uuid,
    '42d334fd-b661-42ab-bfb0-f279565eba43'::uuid,
    '6b358c10-3f84-4f53-a111-7a02ab5420b6'::uuid
  ] loop
    select * into previous from public.processing_jobs where id=jid for update;
    if found and previous.status='ERROR'
      and coalesce(previous.error->>'code','') in ('AUTOMATIC_RECOVERY_EXHAUSTED','DB_STATEMENT_TIMEOUT')
    then
      perform private.assert_current_processing_job(jid);
      insert into private.processing_job_events(job_id,run_id,kind,stage,details)
        values(jid,previous.run_id,'RETRY',previous.stage,
          jsonb_build_object('previousError',previous.error,'source','finalization-v3-migration'));
      update public.processing_jobs set status='QUEUED',automatic_recovery_count=0,attempt=attempt+1,
        stage=previous.stage,progress=least(99,greatest(0,previous.progress)),
        cancel_requested_at=null,error=null,lease_token=null,lease_until=null,next_run_at=clock_timestamp(),
        worker_id=null,worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,
        source_token_expires_at=null,completed_at=null,run_id=null,telemetry_seq=0,
        attempt_started_at=null,stage_started_at=null,last_heartbeat_at=null,last_progress_at=null,
        metrics_reported_at=null,updated_at=clock_timestamp(),
        work=(coalesce(work,'{}'::jsonb)-'telemetry')||jsonb_build_object(
          'message','最终提交协议已修复；正在复用原任务断点、AI 缓存和上传回执',
          'resumePosition',jsonb_build_object('verified',false,'phase','validating','stage',previous.stage,
            'progress',previous.progress,'runId',previous.run_id))
        where id=jid returning * into current_job;
      perform private.sync_processing_retry_snapshot_v1(current_job);
    end if;
  end loop;
end $resume$;

notify pgrst,'reload schema';
commit;
