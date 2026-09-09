-- Resumable local processing protocol. Additive: existing jobs and R2 objects remain valid.

alter table public.processing_jobs
  add column if not exists run_id uuid,
  add column if not exists telemetry_seq bigint not null default 0,
  add column if not exists attempt_started_at timestamptz,
  add column if not exists stage_started_at timestamptz,
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists last_progress_at timestamptz,
  add column if not exists metrics_reported_at timestamptz,
  add column if not exists output_run_id uuid;

create table if not exists private.processing_job_runs (
  job_id uuid not null references public.processing_jobs(id),
  run_id uuid not null,
  worker_id text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  outcome text check (outcome in ('REVIEW','ERROR','CANCELLED','LEASE_LOST')),
  error jsonb,
  primary key(job_id,run_id)
);

create table if not exists private.processing_job_events (
  event_id bigint generated always as identity primary key,
  job_id uuid not null references public.processing_jobs(id),
  run_id uuid,
  kind text not null check (kind in ('CLAIMED','PROGRESS','ERROR','RETRY','REVIEW','LEASE_LOST')),
  stage text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists private.processing_output_receipts (
  job_id uuid not null,
  run_id uuid not null,
  path text not null,
  size bigint not null check (size > 0 and size <= 15728640),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  etag text not null,
  confirmed_at timestamptz not null default now(),
  primary key(job_id,run_id,path),
  foreign key(job_id,run_id) references private.processing_job_runs(job_id,run_id)
);

create index if not exists processing_job_events_recent
  on private.processing_job_events(job_id,created_at desc);
alter table private.processing_job_runs enable row level security;
alter table private.processing_job_events enable row level security;
alter table private.processing_output_receipts enable row level security;
revoke all on private.processing_job_runs,private.processing_job_events,
  private.processing_output_receipts from public,anon,authenticated;

create or replace function private.processing_lock_run(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text
)
returns public.processing_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.processing_jobs%rowtype; v_now timestamptz;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into v_job from public.processing_jobs where id=p_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  v_now:=clock_timestamp();
  if v_job.status<>'RUNNING' or v_job.cancel_requested_at is not null
    or v_job.run_id is distinct from p_run_id or v_job.worker_id is distinct from p_worker_id
    or v_job.lease_until is null or v_job.lease_until<=v_now
    or v_job.worker_token_expires_at is null or v_job.worker_token_expires_at<=v_now
    or p_token is null or length(p_token) not between 32 and 256
    or v_job.worker_token_hash is distinct from pg_catalog.encode(extensions.digest(p_token,'sha256'),'hex')
  then raise exception 'JOB_LEASE_LOST_OR_CANCELLED'; end if;
  if exists(select 1 from private.content_video_trash t where t.environment='production'
    and t.video_id=v_job.video_id and t.restored_at is null)
  then raise exception 'VIDEO_IN_TRASH'; end if;
  return v_job;
end;
$$;

create or replace function public.processing_claim_local_job(
  p_worker_id text,p_token_hash text,p_lease_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.processing_jobs%rowtype; v_run_id uuid:=extensions.gen_random_uuid();
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_worker_id is null or p_worker_id!~'^[A-Za-z0-9._-]{3,80}$' then raise exception 'WORKER_ID_INVALID'; end if;
  if p_token_hash is null or p_token_hash!~'^[0-9a-f]{64}$'
    or p_lease_seconds is null or p_lease_seconds<60 or p_lease_seconds>600
    then raise exception 'PROCESSING_CLAIM_ARGUMENT_INVALID'; end if;
  select * into v_job from public.processing_jobs j
  where j.cancel_requested_at is null and j.status in ('QUEUED','RUNNING','WAITING')
    and j.stage in ('LOCAL_DOWNLOAD','PROBE','TRANSCODE','ASR','ENRICH','LOCAL_UPLOAD')
    and j.next_run_at<=now() and (j.lease_until is null or j.lease_until<now())
  order by j.next_run_at,j.created_at for update skip locked limit 1;
  if not found then return null; end if;
  if v_job.run_id is not null then
    update private.processing_job_runs set ended_at=coalesce(ended_at,now()),outcome=coalesce(outcome,'LEASE_LOST')
      where job_id=v_job.id and run_id=v_job.run_id;
    insert into private.processing_job_events(job_id,run_id,kind,stage,details)
      values(v_job.id,v_job.run_id,'LEASE_LOST',v_job.stage,
        jsonb_build_object('replacedByWorkerId',p_worker_id));
  end if;
  update public.processing_jobs set status='RUNNING',provider='local-worker',worker_id=p_worker_id,
    run_id=v_run_id,telemetry_seq=0,attempt_started_at=now(),stage_started_at=now(),
    last_heartbeat_at=now(),last_progress_at=now(),metrics_reported_at=null,
    worker_token_hash=p_token_hash,worker_token_expires_at=now()+make_interval(secs=>p_lease_seconds),
    source_token_hash=p_token_hash,source_token_expires_at=now()+make_interval(secs=>p_lease_seconds),
    lease_token=extensions.gen_random_uuid(),lease_until=now()+make_interval(secs=>p_lease_seconds),updated_at=now()
  where id=v_job.id returning * into v_job;
  insert into private.processing_job_runs(job_id,run_id,worker_id) values(v_job.id,v_run_id,p_worker_id);
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
    values(v_job.id,v_run_id,'CLAIMED',v_job.stage,jsonb_build_object('attempt',v_job.attempt));
  return to_jsonb(v_job);
end;
$$;

create or replace function public.processing_heartbeat_job_v2(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,
  p_capabilities jsonb default '{}'::jsonb,p_lease_seconds integer default 240
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.processing_jobs%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds<60 or p_lease_seconds>600
    then raise exception 'PROCESSING_HEARTBEAT_ARGUMENT_INVALID'; end if;
  select * into v_job from private.processing_lock_run(p_job_id,p_run_id,p_token,p_worker_id);
  perform public.processing_worker_heartbeat(p_worker_id,p_capabilities,null);
  update public.processing_jobs set lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    worker_token_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    source_token_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    last_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp()
  where id=p_job_id returning * into v_job;
  return to_jsonb(v_job);
end;
$$;

create or replace function public.processing_report_job_v2(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_sequence bigint,
  p_stage text,p_progress integer,p_message text default null,p_metrics jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.processing_jobs%rowtype;
  v_stage_changed boolean;
  v_made_progress boolean;
begin
  if p_sequence is null or p_sequence<1 or p_stage is null
    or p_stage not in ('LOCAL_DOWNLOAD','PROBE','TRANSCODE','ASR','ENRICH','LOCAL_UPLOAD')
    or p_progress is null or p_progress<0 or p_progress>99
    or jsonb_typeof(coalesce(p_metrics,'{}'::jsonb))<>'object'
    or pg_catalog.octet_length(coalesce(p_metrics,'{}'::jsonb)::text)>16384
  then raise exception 'PROCESSING_PROGRESS_INVALID'; end if;
  select * into v_job from private.processing_lock_run(p_job_id,p_run_id,p_token,p_worker_id);
  if p_sequence<=v_job.telemetry_seq then return jsonb_build_object('ignored',true,'sequence',v_job.telemetry_seq); end if;
  v_stage_changed:=v_job.stage is distinct from p_stage;
  v_made_progress:=v_stage_changed or p_progress>v_job.progress or (
    jsonb_typeof(p_metrics->'current')='number'
    and jsonb_typeof(v_job.work->'telemetry'->'current')='number'
    and p_metrics->>'substage' is not distinct from v_job.work->'telemetry'->>'substage'
    and p_metrics->>'unit' is not distinct from v_job.work->'telemetry'->>'unit'
    and (p_metrics->>'current')::numeric>(v_job.work->'telemetry'->>'current')::numeric
  );
  update public.processing_jobs set stage=p_stage,progress=greatest(progress,p_progress),telemetry_seq=p_sequence,
    stage_started_at=case when v_stage_changed then clock_timestamp() else stage_started_at end,
    last_progress_at=case when v_made_progress then clock_timestamp() else last_progress_at end,
    metrics_reported_at=clock_timestamp(),
    work=jsonb_set(jsonb_set(coalesce(work,'{}'::jsonb),'{message}',to_jsonb(left(coalesce(p_message,''),300)),true),
      '{telemetry}',coalesce(p_metrics,'{}'::jsonb),true),updated_at=clock_timestamp()
  where id=p_job_id returning * into v_job;
  return to_jsonb(v_job);
end;
$$;

create or replace function public.processing_record_output_v2(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_path text,
  p_size bigint,p_sha256 text,p_etag text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.processing_jobs%rowtype;
begin
  if p_path is null or p_path!~'^(master\.m3u8|cover\.webp|[0-9]{3,4}p/(index\.m3u8|segment_[0-9]{5}\.ts))$'
    or p_size is null or p_size<1 or p_size>15728640
    or p_sha256 is null or p_sha256!~'^[0-9a-f]{64}$' or coalesce(length(p_etag),0)<1
  then raise exception 'OUTPUT_RECEIPT_INVALID'; end if;
  select * into v_job from private.processing_lock_run(p_job_id,p_run_id,p_token,p_worker_id);
  insert into private.processing_output_receipts(job_id,run_id,path,size,sha256,etag)
  values(p_job_id,p_run_id,p_path,p_size,p_sha256,left(p_etag,200))
  on conflict(job_id,run_id,path) do update set size=excluded.size,sha256=excluded.sha256,
    etag=excluded.etag,confirmed_at=now()
  where private.processing_output_receipts.sha256=excluded.sha256
    and private.processing_output_receipts.size=excluded.size;
  if not found then raise exception 'OUTPUT_RECEIPT_CONFLICT'; end if;
  return jsonb_build_object('ok',true,'path',p_path,'size',p_size,'sha256',p_sha256);
end;
$$;

create or replace function public.processing_fail_job_v2(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_error jsonb,p_retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.processing_jobs%rowtype; v_error jsonb;
begin
  select * into v_job from private.processing_lock_run(p_job_id,p_run_id,p_token,p_worker_id);
  v_error:=coalesce(p_error,'{}'::jsonb)||jsonb_build_object('retryable',p_retryable,'stage',v_job.stage,'runId',p_run_id);
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
    values(p_job_id,p_run_id,'ERROR',v_job.stage,v_error);
  update private.processing_job_runs set ended_at=now(),outcome='ERROR',error=v_error
    where job_id=p_job_id and run_id=p_run_id;
  update public.processing_jobs set status='ERROR',error=v_error,lease_token=null,lease_until=null,
    worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,
    source_token_expires_at=null,completed_at=now(),updated_at=now()
  where id=p_job_id returning * into v_job;
  return to_jsonb(v_job);
end;
$$;

create or replace function public.resolve_processing_output_v2(
  p_job_id uuid,p_run_id uuid,p_token text,p_path text
)
returns table(object_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'videos/'||substring(j.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||j.id::text||
    '/runs/'||p_run_id::text||'/'||p_path
  from public.processing_jobs j where j.id=p_job_id and j.status='RUNNING' and j.run_id=p_run_id
    and j.cancel_requested_at is null and j.worker_token_expires_at>now()
    and pg_catalog.encode(extensions.digest(p_token,'sha256'),'hex')=j.worker_token_hash
    and p_path~'^(master\.m3u8|cover\.webp|[0-9]{3,4}p/(index\.m3u8|segment_[0-9]{5}\.ts))$';
$$;

create or replace function public.processing_commit_leased_result_v2(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_result jsonb,p_manifest jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.processing_jobs%rowtype;
  v_count integer;
  v_content private.content_snapshots%rowtype;
begin
  -- Match recoverable deletion and processing_commit_result lock order.
  select * into v_content from private.content_snapshots where environment='production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;
  select * into v_job from private.processing_lock_run(p_job_id,p_run_id,p_token,p_worker_id);
  if jsonb_typeof(p_manifest)<>'array' or jsonb_array_length(p_manifest)<1
    or not exists(select 1 from jsonb_array_elements(p_manifest) x where x->>'path'='master.m3u8')
    or exists(select 1 from jsonb_array_elements(p_manifest) x
      where x->>'path'!~'^(master\.m3u8|cover\.webp|[0-9]{3,4}p/(index\.m3u8|segment_[0-9]{5}\.ts))$'
        or x->>'size'!~'^[1-9][0-9]{0,7}$' or x->>'sha256'!~'^[0-9a-f]{64}$')
    or exists(select 1 from jsonb_array_elements(p_manifest) x where not exists(
      select 1 from private.processing_output_receipts r where r.job_id=p_job_id and r.run_id=p_run_id
        and r.path=x->>'path' and r.size=case when x->>'size'~'^[1-9][0-9]{0,7}$'
          then (x->>'size')::bigint else -1 end and r.sha256=x->>'sha256'))
  then raise exception 'OUTPUT_MANIFEST_INCOMPLETE'; end if;
  select count(*) into v_count from private.processing_output_receipts where job_id=p_job_id and run_id=p_run_id;
  if v_count<>jsonb_array_length(p_manifest) then raise exception 'OUTPUT_MANIFEST_MISMATCH'; end if;
  update public.processing_jobs set output_run_id=p_run_id,worker_token_hash=null,worker_token_expires_at=null,
    source_token_hash=null,source_token_expires_at=null,updated_at=now()
  where id=p_job_id;
  update private.processing_job_runs set ended_at=now(),outcome='REVIEW' where job_id=p_job_id and run_id=p_run_id;
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
    values(p_job_id,p_run_id,'REVIEW','REVIEW',jsonb_build_object('assetCount',v_count));
  return public.processing_commit_result(p_job_id,p_result);
end;
$$;

create or replace function public.resolve_processing_media(p_job_id uuid,p_path text)
returns table(object_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'videos/'||substring(j.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||j.id::text||'/'||
    case when j.output_run_id is null then p_path else 'runs/'||j.output_run_id::text||'/'||p_path end
  from public.processing_jobs j
  where j.id=p_job_id and j.status='REVIEW'
    and p_path~'^(master\.m3u8|cover\.webp|[0-9]{3,4}p/(index\.m3u8|segment_[0-9]{5}\.ts))$'
    and not exists(select 1 from private.content_video_trash t where t.environment='production'
      and t.video_id=j.video_id and t.restored_at is null)
    and (public.is_admin() or exists(select 1 from private.content_snapshots c,
      jsonb_array_elements(coalesce(c.published->'videos','[]'::jsonb)) v
      where c.environment='production' and v->>'id'=j.video_id and v->>'status'='PUBLISHED'));
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
  return query select jsonb_build_object(
    'id',j.id,'videoId',j.video_id,'status',j.status,'stage',j.stage,'progress',j.progress,
    'attempt',j.attempt,'provider',j.provider,'error',j.error,'runId',j.run_id,
    'message',j.work->>'message','telemetry',j.work->'telemetry',
    'attemptStartedAt',j.attempt_started_at,'stageStartedAt',j.stage_started_at,
    'lastHeartbeatAt',j.last_heartbeat_at,'lastProgressAt',j.last_progress_at,
    'metricsReportedAt',j.metrics_reported_at,'createdAt',j.created_at,
    'updatedAt',j.updated_at,'completedAt',j.completed_at,'serverNow',now()
  ) from public.processing_jobs j order by j.created_at desc limit least(greatest(p_limit,1),100);
end;
$$;

create or replace function public.admin_retry_processing_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.processing_jobs%rowtype;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_job from public.processing_jobs where id=p_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  if v_job.status not in ('ERROR','CANCELLED') then raise exception 'JOB_NOT_RETRYABLE'; end if;
  if v_job.attempt>=20 then raise exception 'RETRY_LIMIT_REACHED'; end if;
  if exists(select 1 from private.content_video_trash where environment='production'
    and video_id=v_job.video_id and restored_at is null) then raise exception 'VIDEO_IN_TRASH'; end if;
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
    values(v_job.id,v_job.run_id,'RETRY',v_job.stage,jsonb_build_object('previousError',v_job.error));
  update public.processing_jobs set status='QUEUED',stage='LOCAL_DOWNLOAD',progress=0,attempt=attempt+1,
    cancel_requested_at=null,error=null,lease_token=null,lease_until=null,next_run_at=now(),
    worker_id=null,worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,
    source_token_expires_at=null,completed_at=null,run_id=null,telemetry_seq=0,
    attempt_started_at=null,stage_started_at=null,last_heartbeat_at=null,last_progress_at=null,
    metrics_reported_at=null,updated_at=now() where id=p_job_id returning * into v_job;
  return to_jsonb(v_job);
end;
$$;

revoke all on function private.processing_lock_run(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.processing_heartbeat_job_v2(uuid,uuid,text,text,jsonb,integer) from public,anon,authenticated;
revoke all on function public.processing_report_job_v2(uuid,uuid,text,text,bigint,text,integer,text,jsonb) from public,anon,authenticated;
revoke all on function public.processing_record_output_v2(uuid,uuid,text,text,text,bigint,text,text) from public,anon,authenticated;
revoke all on function public.processing_fail_job_v2(uuid,uuid,text,text,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.resolve_processing_output_v2(uuid,uuid,text,text) from public;
grant execute on function public.processing_heartbeat_job_v2(uuid,uuid,text,text,jsonb,integer) to service_role;
grant execute on function public.processing_report_job_v2(uuid,uuid,text,text,bigint,text,integer,text,jsonb) to service_role;
grant execute on function public.processing_record_output_v2(uuid,uuid,text,text,text,bigint,text,text) to service_role;
grant execute on function public.processing_fail_job_v2(uuid,uuid,text,text,jsonb,boolean) to service_role;
grant execute on function public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb) to service_role;
grant execute on function public.resolve_processing_output_v2(uuid,uuid,text,text) to anon,authenticated;

comment on table private.processing_job_runs is 'Immutable processing attempts used to reject stale workers.';
comment on table private.processing_job_events is 'Retained, redacted processing history; retry does not erase failures.';
comment on table private.processing_output_receipts is 'Server-confirmed R2 output manifest for one processing run.';
