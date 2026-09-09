-- Free production processing lane: a trusted desktop worker leases durable jobs,
-- downloads R2 originals, uploads HLS assets, and commits review-ready results.

create table if not exists public.processing_workers (
  worker_id text primary key check (worker_id ~ '^[A-Za-z0-9._-]{3,80}$'),
  last_seen_at timestamptz not null default now(),
  capabilities jsonb not null default '{}'::jsonb,
  version text,
  updated_at timestamptz not null default now()
);

alter table public.processing_workers enable row level security;
revoke all on table public.processing_workers from public, anon, authenticated;

alter table public.processing_jobs drop constraint if exists processing_jobs_stage_check;
alter table public.processing_jobs alter column stage set default 'LOCAL_DOWNLOAD';
alter table public.processing_jobs add constraint processing_jobs_stage_check check (stage in (
  'STREAM_SUBMIT','STREAM_ENCODING','CAPTIONING','METADATA',
  'LOCAL_DOWNLOAD','PROBE','TRANSCODE','ASR','ENRICH','LOCAL_UPLOAD','REVIEW'
));
alter table public.processing_jobs add column if not exists worker_id text;
alter table public.processing_jobs add column if not exists worker_token_hash text;
alter table public.processing_jobs add column if not exists worker_token_expires_at timestamptz;

-- Existing unfinished Stream jobs become recoverable local jobs. Cancelled and
-- review jobs are deliberately untouched, and no R2 object is deleted.
update public.processing_jobs
set status='QUEUED', stage='LOCAL_DOWNLOAD', progress=0, provider='local-worker',
    provider_job_id=null, lease_token=null, lease_until=null, next_run_at=now(),
    source_token_hash=null, source_token_expires_at=null,
    worker_token_hash=null, worker_token_expires_at=null, worker_id=null,
    error=null, updated_at=now()
where status in ('QUEUED','RUNNING','WAITING');

create or replace function public.processing_worker_heartbeat(
  p_worker_id text, p_capabilities jsonb default '{}'::jsonb, p_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_worker public.processing_workers%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_worker_id is null or p_worker_id !~ '^[A-Za-z0-9._-]{3,80}$' then raise exception 'WORKER_ID_INVALID'; end if;
  if jsonb_typeof(coalesce(p_capabilities,'{}'::jsonb)) <> 'object' then raise exception 'WORKER_CAPABILITIES_INVALID'; end if;
  insert into public.processing_workers(worker_id,last_seen_at,capabilities,version,updated_at)
  values(p_worker_id,now(),coalesce(p_capabilities,'{}'::jsonb),left(p_version,80),now())
  on conflict(worker_id) do update set last_seen_at=now(),capabilities=excluded.capabilities,
    version=excluded.version,updated_at=now()
  returning * into v_worker;
  return to_jsonb(v_worker);
end;
$$;

create or replace function public.processing_worker_health()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object(
      'workerId',w.worker_id,'lastSeenAt',w.last_seen_at,'capabilities',w.capabilities,'version',w.version,
      'ready',w.last_seen_at > now()-interval '150 seconds'
        and coalesce((w.capabilities->>'ffmpeg')::boolean,false)
        and coalesce((w.capabilities->>'whisper')::boolean,false)
        and coalesce((w.capabilities->>'deepseek')::boolean,false)
    ) from public.processing_workers w order by w.last_seen_at desc limit 1
  ), jsonb_build_object('ready',false,'capabilities','{}'::jsonb));
$$;

create or replace function public.processing_claim_local_job(
  p_worker_id text, p_token_hash text, p_lease_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.processing_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_worker_id is null or p_worker_id !~ '^[A-Za-z0-9._-]{3,80}$' then raise exception 'WORKER_ID_INVALID'; end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'WORKER_TOKEN_HASH_INVALID'; end if;
  if p_lease_seconds < 60 or p_lease_seconds > 600 then raise exception 'PROCESSING_CLAIM_ARGUMENT_INVALID'; end if;
  select * into v_job from public.processing_jobs j
  where j.cancel_requested_at is null and j.status in ('QUEUED','RUNNING','WAITING')
    and j.stage in ('LOCAL_DOWNLOAD','PROBE','TRANSCODE','ASR','ENRICH','LOCAL_UPLOAD')
    and j.next_run_at <= now() and (j.lease_until is null or j.lease_until < now())
  order by j.next_run_at,j.created_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.processing_jobs set status='RUNNING',provider='local-worker',worker_id=p_worker_id,
    worker_token_hash=p_token_hash,worker_token_expires_at=now()+make_interval(secs=>p_lease_seconds),
    source_token_hash=p_token_hash,source_token_expires_at=now()+make_interval(secs=>p_lease_seconds),
    lease_token=extensions.gen_random_uuid(),lease_until=now()+make_interval(secs=>p_lease_seconds),updated_at=now()
  where id=v_job.id returning * into v_job;
  return to_jsonb(v_job);
end;
$$;

create or replace function private.processing_worker_job(p_job_id uuid,p_token text)
returns public.processing_jobs
language sql
stable
set search_path = ''
as $$
  select j from public.processing_jobs j where j.id=p_job_id
    and j.status='RUNNING' and j.cancel_requested_at is null
    and j.worker_token_expires_at > now()
    and pg_catalog.encode(extensions.digest(p_token,'sha256'),'hex')=j.worker_token_hash;
$$;

create or replace function public.processing_heartbeat_job(
  p_job_id uuid,p_token text,p_worker_id text,p_capabilities jsonb default '{}'::jsonb,p_lease_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.processing_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_lease_seconds < 60 or p_lease_seconds > 600 then raise exception 'PROCESSING_HEARTBEAT_ARGUMENT_INVALID'; end if;
  select * into v_job from private.processing_worker_job(p_job_id,p_token);
  if not found or v_job.worker_id is distinct from p_worker_id then raise exception 'JOB_LEASE_LOST_OR_CANCELLED'; end if;
  perform public.processing_worker_heartbeat(p_worker_id,p_capabilities,null);
  update public.processing_jobs set lease_until=now()+make_interval(secs=>p_lease_seconds),
    worker_token_expires_at=now()+make_interval(secs=>p_lease_seconds),
    source_token_expires_at=now()+make_interval(secs=>p_lease_seconds),updated_at=now()
  where id=p_job_id returning * into v_job;
  return to_jsonb(v_job);
end;
$$;

create or replace function public.processing_progress_job(
  p_job_id uuid,p_token text,p_stage text,p_progress integer,p_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.processing_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_stage not in ('LOCAL_DOWNLOAD','PROBE','TRANSCODE','ASR','ENRICH','LOCAL_UPLOAD')
     or p_progress < 0 or p_progress > 99 then raise exception 'PROCESSING_PROGRESS_INVALID'; end if;
  select * into v_job from private.processing_worker_job(p_job_id,p_token);
  if not found then raise exception 'JOB_LEASE_LOST_OR_CANCELLED'; end if;
  update public.processing_jobs set stage=p_stage,progress=p_progress,
    work=jsonb_set(coalesce(work,'{}'::jsonb),'{message}',to_jsonb(left(coalesce(p_message,''),300)),true),updated_at=now()
  where id=p_job_id returning * into v_job;
  return to_jsonb(v_job);
end;
$$;

create or replace function public.processing_fail_job(
  p_job_id uuid,p_token text,p_error jsonb,p_retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.processing_jobs%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into v_job from private.processing_worker_job(p_job_id,p_token);
  if not found then raise exception 'JOB_LEASE_LOST_OR_CANCELLED'; end if;
  update public.processing_jobs set status='ERROR',error=coalesce(p_error,'{}'::jsonb)||jsonb_build_object('retryable',p_retryable,'stage',stage),
    lease_token=null,lease_until=null,worker_token_hash=null,worker_token_expires_at=null,
    source_token_hash=null,source_token_expires_at=null,completed_at=now(),updated_at=now()
  where id=p_job_id returning * into v_job;
  return to_jsonb(v_job);
end;
$$;

create or replace function public.resolve_processing_output(p_job_id uuid,p_token text,p_path text)
returns table(object_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'videos/'||substring(j.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||j.id::text||'/'||p_path
  from public.processing_jobs j
  where j.id=p_job_id and j.status='RUNNING' and j.cancel_requested_at is null
    and j.worker_token_expires_at > now()
    and pg_catalog.encode(extensions.digest(p_token,'sha256'),'hex')=j.worker_token_hash
    and p_path ~ '^(master\.m3u8|cover\.webp|[0-9]{3,4}p/(index\.m3u8|segment_[0-9]{5}\.ts))$';
$$;

create or replace function public.resolve_processing_media(p_job_id uuid,p_path text)
returns table(object_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'videos/'||substring(j.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||j.id::text||'/'||p_path
  from public.processing_jobs j
  where j.id=p_job_id and j.status='REVIEW'
    and p_path ~ '^(master\.m3u8|cover\.webp|[0-9]{3,4}p/(index\.m3u8|segment_[0-9]{5}\.ts))$'
    and (public.is_admin() or exists(
      select 1 from private.content_snapshots c,jsonb_array_elements(coalesce(c.published->'videos','[]'::jsonb)) v
      where c.environment='production' and v->>'id'=j.video_id and v->>'status'='PUBLISHED'
    ));
$$;

create or replace function public.processing_commit_leased_result(p_job_id uuid,p_token text,p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  update public.processing_jobs j set worker_token_hash=null,worker_token_expires_at=null,
    source_token_hash=null,source_token_expires_at=null,updated_at=now()
  where j.id=p_job_id and j.status='RUNNING' and j.cancel_requested_at is null
    and j.worker_token_expires_at > now()
    and pg_catalog.encode(extensions.digest(p_token,'sha256'),'hex')=j.worker_token_hash;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'JOB_LEASE_LOST_OR_CANCELLED'; end if;
  return public.processing_commit_result(p_job_id,p_result);
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
  if exists(select 1 from private.content_video_trash where environment='production' and video_id=v_job.video_id and restored_at is null)
    then raise exception 'VIDEO_IN_TRASH'; end if;
  update public.processing_jobs set status='QUEUED',stage='LOCAL_DOWNLOAD',progress=0,attempt=attempt+1,
    cancel_requested_at=null,error=null,result=null,lease_token=null,lease_until=null,next_run_at=now(),
    worker_id=null,worker_token_hash=null,worker_token_expires_at=null,
    source_token_hash=null,source_token_expires_at=null,completed_at=null,updated_at=now()
  where id=p_job_id returning * into v_job;
  return to_jsonb(v_job);
end;
$$;

revoke all on function public.processing_worker_heartbeat(text,jsonb,text) from public,anon,authenticated;
revoke all on function public.processing_worker_health() from public,anon,authenticated;
revoke all on function public.processing_claim_local_job(text,text,integer) from public,anon,authenticated;
revoke all on function public.processing_heartbeat_job(uuid,text,text,jsonb,integer) from public,anon,authenticated;
revoke all on function public.processing_progress_job(uuid,text,text,integer,text) from public,anon,authenticated;
revoke all on function public.processing_fail_job(uuid,text,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.processing_commit_leased_result(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.resolve_processing_output(uuid,text,text) from public;
revoke all on function public.resolve_processing_media(uuid,text) from public;
grant execute on function public.processing_worker_heartbeat(text,jsonb,text) to service_role;
grant execute on function public.processing_worker_health() to service_role;
grant execute on function public.processing_claim_local_job(text,text,integer) to service_role;
grant execute on function public.processing_heartbeat_job(uuid,text,text,jsonb,integer) to service_role;
grant execute on function public.processing_progress_job(uuid,text,text,integer,text) to service_role;
grant execute on function public.processing_fail_job(uuid,text,jsonb,boolean) to service_role;
grant execute on function public.processing_commit_leased_result(uuid,text,jsonb) to service_role;
grant execute on function public.resolve_processing_output(uuid,text,text) to anon,authenticated;
grant execute on function public.resolve_processing_media(uuid,text) to authenticated;

comment on table public.processing_workers is 'Heartbeats and capabilities for trusted Eastudy desktop video workers.';
