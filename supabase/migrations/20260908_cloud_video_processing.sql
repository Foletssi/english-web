-- Durable cloud video processing jobs. R2 originals remain the source of record.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists public.processing_jobs (
  id uuid primary key default gen_random_uuid(),
  video_id text not null check (video_id ~ '^[0-9]+$'),
  source_key text not null check (source_key ~ '^videos/[0-9a-f-]{36}/source\.(mp4|mov|webm|m4v)$'),
  input jsonb not null default '{}'::jsonb,
  requested_by uuid not null references auth.users(id),
  idempotency_key text not null,
  status text not null default 'QUEUED' check (status in ('QUEUED','RUNNING','WAITING','REVIEW','ERROR','CANCELLED')),
  stage text not null default 'STREAM_SUBMIT' check (stage in ('STREAM_SUBMIT','STREAM_ENCODING','CAPTIONING','ENRICH','METADATA','REVIEW')),
  progress integer not null default 0 check (progress between 0 and 100),
  attempt integer not null default 1 check (attempt between 1 and 20),
  provider text,
  provider_job_id text,
  source_token_hash text,
  source_token_expires_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  next_run_at timestamptz not null default now(),
  cancel_requested_at timestamptz,
  error jsonb,
  work jsonb not null default '{}'::jsonb,
  result jsonb,
  input_revision bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(requested_by, idempotency_key)
);

create index if not exists processing_jobs_due
  on public.processing_jobs(next_run_at, created_at)
  where status in ('QUEUED','RUNNING','WAITING');
create index if not exists processing_jobs_video on public.processing_jobs(video_id, created_at desc);

alter table public.processing_jobs enable row level security;
revoke all on table public.processing_jobs from public, anon, authenticated;

create or replace function private.upsert_json_array_item(p_array jsonb, p_item jsonb, p_id_key text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce((select jsonb_agg(value) from jsonb_array_elements(coalesce(p_array, '[]'::jsonb))
                   where value->>p_id_key is distinct from p_item->>p_id_key), '[]'::jsonb)
         || jsonb_build_array(p_item);
$$;

create or replace function public.admin_create_processing_job(
  p_video jsonb,
  p_source_key text,
  p_idempotency_key text,
  p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content private.content_snapshots%rowtype;
  v_job public.processing_jobs%rowtype;
  v_video_id text := p_video->>'id';
  v_draft jsonb;
  v_display jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if v_video_id is null or v_video_id !~ '^[0-9]+$' then raise exception 'VIDEO_ID_INVALID'; end if;
  if p_source_key !~ '^videos/[0-9a-f-]{36}/source\.(mp4|mov|webm|m4v)$' then raise exception 'SOURCE_KEY_INVALID'; end if;
  if nullif(trim(p_video->>'title'), '') is null then raise exception 'VIDEO_TITLE_EMPTY'; end if;
  if nullif(trim(p_idempotency_key), '') is null or length(p_idempotency_key) > 128 then raise exception 'IDEMPOTENCY_KEY_INVALID'; end if;

  select * into v_content from private.content_snapshots where environment='production' for update;
  if not found or v_content.revision <> p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  if exists(select 1 from private.content_video_trash t where t.environment='production'
            and t.video_id=v_video_id and t.restored_at is null) then raise exception 'VIDEO_IN_TRASH'; end if;

  select * into v_job from public.processing_jobs
  where requested_by=auth.uid() and idempotency_key=p_idempotency_key;
  if found then
    return jsonb_build_object('snapshot', v_content.draft, 'revision', v_content.revision, 'job', to_jsonb(v_job));
  end if;

  insert into public.processing_jobs(video_id, source_key, input, requested_by, idempotency_key, input_revision)
  values(v_video_id, p_source_key, p_video, auth.uid(), p_idempotency_key, v_content.revision)
  returning * into v_job;

  v_display := jsonb_build_object(
    'id', v_job.id::text, 'videoId', v_video_id::bigint, 'type', 'CLOUD_PIPELINE',
    'status', 'QUEUED', 'currentStep', 'STREAM_SUBMIT', 'progress', 0,
    'steps', jsonb_build_array(
      jsonb_build_array('upload','SUCCESS'), jsonb_build_array('transcode','WAITING'),
      jsonb_build_array('asr','WAITING'), jsonb_build_array('enrich','WAITING'),
      jsonb_build_array('review','WAITING')
    ),
    'createdAt', to_jsonb(v_job.created_at), 'updatedAt', to_jsonb(v_job.updated_at)
  );
  v_draft := jsonb_set(v_content.draft, '{videos}', private.upsert_json_array_item(
    v_content.draft->'videos', p_video || jsonb_build_object(
      'id', v_video_id::bigint, 'status', 'DRAFT', 'pipelineStatus', 'QUEUED',
      'processingJobId', v_job.id::text, 'mediaKey', p_source_key,
      'mediaUrl', '/api/media?key=' || p_source_key
    ), 'id'), true);
  v_draft := jsonb_set(v_draft, '{jobs}', private.upsert_json_array_item(v_draft->'jobs', v_display, 'id'), true);
  perform private.validate_content_snapshot(v_draft);
  update private.content_snapshots c set draft=v_draft, revision=c.revision+1,
    updated_by=auth.uid(), updated_at=now() where environment='production';
  return jsonb_build_object('snapshot', v_draft, 'revision', v_content.revision+1, 'job', to_jsonb(v_job));
end;
$$;

-- The cron worker claims work atomically. Expired leases are recoverable after
-- an Edge Function timeout, while SKIP LOCKED prevents duplicate Stream jobs.
create or replace function public.processing_claim_jobs(p_limit integer default 1, p_lease_seconds integer default 90)
returns table(job jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_limit < 1 or p_limit > 5 or p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'PROCESSING_CLAIM_ARGUMENT_INVALID';
  end if;
  return query
  with candidates as (
    select j.id from public.processing_jobs j
    where j.cancel_requested_at is null
      and j.status in ('QUEUED','RUNNING','WAITING')
      and j.next_run_at <= now()
      and (j.lease_until is null or j.lease_until < now())
    order by j.next_run_at, j.created_at
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.processing_jobs j set
      status='RUNNING', lease_token=extensions.gen_random_uuid(),
      lease_until=now() + make_interval(secs => p_lease_seconds), updated_at=now()
    from candidates c where j.id=c.id
    returning j.*
  )
  select to_jsonb(claimed) from claimed;
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
  return query select jsonb_build_object(
    'id', j.id, 'videoId', j.video_id, 'status', j.status, 'stage', j.stage,
    'progress', j.progress, 'attempt', j.attempt, 'provider', j.provider,
    'providerJobId', j.provider_job_id, 'error', j.error,
    'createdAt', j.created_at, 'updatedAt', j.updated_at, 'completedAt', j.completed_at
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
  if exists(select 1 from private.content_video_trash where environment='production'
            and video_id=v_job.video_id and restored_at is null) then raise exception 'VIDEO_IN_TRASH'; end if;
  update public.processing_jobs set status='QUEUED',
    stage=case when error->>'stage' in ('STREAM_SUBMIT','STREAM_ENCODING','CAPTIONING','ENRICH','METADATA')
      then (error->>'stage') else 'STREAM_SUBMIT' end,
    progress=case when error->>'stage'='STREAM_SUBMIT' then 0 else progress end,
    attempt=attempt+1, cancel_requested_at=null,
    error=null, result=null, lease_token=null, lease_until=null,
    next_run_at=now(), updated_at=now(), completed_at=null where id=p_job_id returning * into v_job;
  return to_jsonb(v_job);
end;
$$;

create or replace function public.resolve_processing_source(p_job_id uuid, p_token text)
returns table(source_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select j.source_key from public.processing_jobs j
  where j.id=p_job_id and j.status in ('QUEUED','RUNNING','WAITING')
    and j.cancel_requested_at is null and j.source_token_expires_at > now()
    and pg_catalog.encode(extensions.digest(p_token, 'sha256'), 'hex') = j.source_token_hash;
$$;

create or replace function public.processing_commit_result(p_job_id uuid, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.processing_jobs%rowtype;
  v_content private.content_snapshots%rowtype;
  v_video jsonb;
  v_display jsonb;
  v_draft jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  -- Follow the same content-then-job lock order as recoverable deletion.
  select * into v_job from public.processing_jobs where id=p_job_id;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  select * into v_content from private.content_snapshots where environment='production' for update;
  select * into v_job from public.processing_jobs where id=p_job_id for update;
  if v_job.cancel_requested_at is not null or exists(
    select 1 from private.content_video_trash where environment='production'
      and video_id=v_job.video_id and restored_at is null
  ) then
    update public.processing_jobs set status='CANCELLED', completed_at=now(), updated_at=now() where id=p_job_id;
    return jsonb_build_object('status','CANCELLED');
  end if;
  if jsonb_typeof(p_result->'sentences') <> 'array' or jsonb_array_length(p_result->'sentences') < 1 then
    raise exception 'PROCESSING_RESULT_SENTENCES_INVALID';
  end if;
  select value into v_video from jsonb_array_elements(v_content.draft->'videos') value
    where value->>'id'=v_job.video_id limit 1;
  if v_video is null then raise exception 'VIDEO_NOT_FOUND'; end if;
  v_video := v_video || coalesce(p_result->'video','{}'::jsonb) || jsonb_build_object(
    'id', v_job.video_id::bigint, 'status','REVIEW', 'pipelineStatus','READY',
    'processingJobId', v_job.id::text, 'processingEvidence', coalesce(p_result->'evidence','{}'::jsonb),
    'updatedAt', to_jsonb(now())
  );
  v_display := jsonb_build_object(
    'id',v_job.id::text,'videoId',v_job.video_id::bigint,'type','CLOUD_PIPELINE','status','REVIEW',
    'currentStep','review','progress',100,'steps',jsonb_build_array(
      jsonb_build_array('upload','SUCCESS'),jsonb_build_array('transcode','SUCCESS'),
      jsonb_build_array('asr','SUCCESS'),jsonb_build_array('enrich','SUCCESS'),
      jsonb_build_array('review','WAITING')
    ),'updatedAt',to_jsonb(now())
  );
  v_draft := jsonb_set(v_content.draft,'{videos}',private.upsert_json_array_item(v_content.draft->'videos',v_video,'id'),true);
  v_draft := jsonb_set(v_draft,array['sentences',v_job.video_id],p_result->'sentences',true);
  v_draft := jsonb_set(v_draft,'{jobs}',private.upsert_json_array_item(v_draft->'jobs',v_display,'id'),true);
  perform private.validate_content_snapshot(v_draft);
  update private.content_snapshots set draft=v_draft, revision=revision+1, updated_at=now()
    where environment='production';
  update public.processing_jobs set status='REVIEW',stage='REVIEW',progress=100,result=p_result,
    lease_token=null,lease_until=null,completed_at=now(),updated_at=now() where id=p_job_id;
  return jsonb_build_object('status','REVIEW','snapshot',v_draft,'revision',v_content.revision+1);
end;
$$;

create or replace function public.install_video_processing_cron(p_url text, p_secret text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_id bigint;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform cron.unschedule(jobid) from cron.job where jobname='eastudy-video-processing';
  select cron.schedule('eastudy-video-processing','* * * * *',format(
    $cmd$select net.http_post(url := %L, headers := jsonb_build_object('content-type','application/json','x-cron-secret',%L), body := '{"action":"run"}'::jsonb);$cmd$,
    p_url, p_secret)) into v_id;
  return v_id;
end;
$$;

-- Active normalized jobs are cancellation requests, never deletion blockers.
create or replace function private.cancel_processing_jobs(p_video_ids text[])
returns void
language sql
volatile
set search_path = ''
as $$
  update public.processing_jobs set cancel_requested_at=coalesce(cancel_requested_at,now()),
    status='CANCELLED', lease_token=null, lease_until=null, completed_at=now(), updated_at=now()
  where video_id=any(p_video_ids) and status in ('QUEUED','RUNNING','WAITING');
$$;

-- Inject normalized cancellation into the already revisioned, recoverable trash function.
create or replace function public.admin_trash_content_videos(p_video_ids text[], p_expected_revision bigint)
returns table(snapshot jsonb, revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare v_content private.content_snapshots%rowtype; v_ids text[]; v_id text; v_payload jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select array_agg(distinct value order by value) into v_ids from unnest(coalesce(p_video_ids,array[]::text[])) value;
  if coalesce(array_length(v_ids,1),0)<1 or array_length(v_ids,1)>100 then raise exception 'VIDEO_DELETE_COUNT_INVALID'; end if;
  if exists(select 1 from unnest(v_ids) value where value !~ '^[0-9]+$') then raise exception 'VIDEO_ID_INVALID'; end if;
  select * into v_content from private.content_snapshots where environment='production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;
  if v_content.revision<>p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  perform private.cancel_processing_jobs(v_ids);
  foreach v_id in array v_ids loop
    if not exists(select 1 from jsonb_array_elements(coalesce(v_content.draft->'videos','[]'::jsonb)) v where v->>'id'=v_id)
       and not exists(select 1 from jsonb_array_elements(coalesce(v_content.published->'videos','[]'::jsonb)) v where v->>'id'=v_id)
    then raise exception 'VIDEO_NOT_FOUND:%',v_id; end if;
    v_payload:=jsonb_build_object(
      'draft',private.cancel_jobs_in_video_payload(private.content_video_payload(v_content.draft,v_id)),
      'published',private.cancel_jobs_in_video_payload(private.content_video_payload(v_content.published,v_id)));
    insert into private.content_video_trash(environment,video_id,payload,deleted_by)
      values('production',v_id,v_payload,auth.uid())
      on conflict(environment,video_id) where restored_at is null do update
      set payload=excluded.payload,deleted_by=excluded.deleted_by,deleted_at=now(),reason=excluded.reason;
  end loop;
  update private.content_snapshots c set draft=private.without_content_videos(c.draft,v_ids),
    published=private.without_content_videos(c.published,v_ids),revision=c.revision+1,
    updated_by=auth.uid(),updated_at=now() where environment='production';
  return query select c.draft,c.revision,c.updated_at from private.content_snapshots c where environment='production';
end;
$$;

revoke all on function public.admin_create_processing_job(jsonb,text,text,bigint) from public, anon;
revoke all on function public.admin_list_processing_jobs(integer) from public, anon;
revoke all on function public.admin_retry_processing_job(uuid) from public, anon;
revoke all on function public.processing_claim_jobs(integer,integer) from public, anon, authenticated;
revoke all on function public.resolve_processing_source(uuid,text) from public;
revoke all on function public.processing_commit_result(uuid,jsonb) from public, anon, authenticated;
revoke all on function public.install_video_processing_cron(text,text) from public, anon, authenticated;
grant execute on function public.admin_create_processing_job(jsonb,text,text,bigint) to authenticated;
grant execute on function public.admin_list_processing_jobs(integer) to authenticated;
grant execute on function public.admin_retry_processing_job(uuid) to authenticated;
grant execute on function public.processing_claim_jobs(integer,integer) to service_role;
grant execute on function public.resolve_processing_source(uuid,text) to anon, authenticated;
grant execute on function public.processing_commit_result(uuid,jsonb) to service_role;
grant execute on function public.install_video_processing_cron(text,text) to service_role;

comment on table public.processing_jobs is 'Durable Eastudy cloud video processing state; direct table access is disabled by RLS.';
