-- Forward-only: preserve the established processing/teaching validators.
begin;

create function private.assert_current_processing_job(p_job_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare c private.content_snapshots%rowtype; j public.processing_jobs%rowtype; v jsonb; pointer text;
begin
  select * into c from private.content_snapshots where environment='production' for update;
  select * into j from public.processing_jobs where id=p_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  if exists(select 1 from private.content_video_trash where environment='production' and video_id=j.video_id and restored_at is null)
    then raise exception 'VIDEO_IN_TRASH'; end if;
  select value into v from jsonb_array_elements(c.draft->'videos') where value->>'id'=j.video_id;
  if v is null then raise exception 'VIDEO_NOT_FOUND'; end if;
  pointer:=case when j.input->>'kind'='LEARNING_REPAIR' then 'learningRepairJobId' else 'processingJobId' end;
  if v->>pointer is distinct from j.id::text then raise exception 'JOB_SUPERSEDED'; end if;
end $$;
revoke all on function private.assert_current_processing_job(uuid) from public,anon,authenticated;

alter function public.admin_retry_processing_job(uuid) set schema private;
alter function private.admin_retry_processing_job(uuid) rename to retry_processing_before_20260917;
revoke all on function private.retry_processing_before_20260917(uuid) from public,anon,authenticated,service_role;
create function public.admin_retry_processing_job(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.processing_jobs%rowtype;
begin
  if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
  perform private.assert_current_processing_job(p_job_id);
  perform private.retry_processing_before_20260917(p_job_id);
  update public.processing_jobs set automatic_recovery_count=0,attempt=attempt+1
    where id=p_job_id returning * into j;
  return to_jsonb(j);
end $$;
revoke all on function public.admin_retry_processing_job(uuid) from public,anon;
grant execute on function public.admin_retry_processing_job(uuid) to authenticated;

alter function public.processing_commit_result(uuid,jsonb) set schema private;
alter function private.processing_commit_result(uuid,jsonb) rename to commit_result_before_20260917;
revoke all on function private.commit_result_before_20260917(uuid,jsonb) from public,anon,authenticated,service_role;
create function public.processing_commit_result(p_job_id uuid,p_result jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform private.assert_current_processing_job(p_job_id);
  return private.commit_result_before_20260917(p_job_id,p_result);
end $$;
revoke all on function public.processing_commit_result(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.processing_commit_result(uuid,jsonb) to service_role;

alter function public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) set schema private;
alter function private.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) rename to commit_learning_before_20260917;
revoke all on function private.commit_learning_before_20260917(uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.processing_commit_learning_repair_v5(p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_result jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform private.assert_current_processing_job(p_job_id);
  return private.commit_learning_before_20260917(p_job_id,p_run_id,p_token,p_worker_id,p_result);
end $$;
revoke all on function public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) to service_role;

-- Older workers still have a supported v4 endpoint; apply the same ownership
-- check without bypassing its existing contract-version and lease validators.
alter function public.processing_commit_learning_repair_v4(uuid,uuid,text,text,jsonb) set schema private;
alter function private.processing_commit_learning_repair_v4(uuid,uuid,text,text,jsonb) rename to commit_learning_v4_before_20260917;
revoke all on function private.commit_learning_v4_before_20260917(uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.processing_commit_learning_repair_v4(p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_result jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform private.assert_current_processing_job(p_job_id);
  return private.commit_learning_v4_before_20260917(p_job_id,p_run_id,p_token,p_worker_id,p_result);
end $$;
revoke all on function public.processing_commit_learning_repair_v4(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.processing_commit_learning_repair_v4(uuid,uuid,text,text,jsonb) to service_role;

-- R2 multipart uploads can be durably aborted before deleting their objects.
-- A timeout alone is never evidence that an output write stopped.
create table private.processing_output_writes (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.processing_jobs(id),
  object_key text not null,
  upload_id text not null unique check(length(upload_id) between 1 and 2048),
  created_at timestamptz not null default clock_timestamp()
);
create index processing_output_writes_job on private.processing_output_writes(job_id);
revoke all on private.processing_output_writes from public,anon,authenticated;

create function public.begin_processing_output_write(p_job_id uuid,p_run_id uuid,p_token text,p_path text,p_upload_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare k text; receipt uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  -- Confirmation uses the same snapshot -> job order and invalidates tokens.
  perform 1 from private.content_snapshots where environment='production' for update;
  perform 1 from public.processing_jobs where id=p_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  if exists(select 1 from private.video_deletion_jobs where confirmed_at is not null and p_job_id=any(job_ids))
    then raise exception 'VIDEO_PERMANENT_DELETION_STARTED'; end if;
  if p_run_id is null then
    select object_key into k from public.resolve_processing_output(p_job_id,p_token,p_path);
  else
    select object_key into k from public.resolve_processing_output_v2(p_job_id,p_run_id,p_token,p_path);
  end if;
  if k is null then raise exception 'OUTPUT_NOT_ALLOWED'; end if;
  insert into private.processing_output_writes(job_id,object_key,upload_id) values(p_job_id,k,p_upload_id) returning id into receipt;
  return jsonb_build_object('object_key',k,'write_id',receipt);
end $$;

create function public.finish_processing_output_write(p_write_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  -- Only the Pages server may acknowledge a completed or aborted upload.
  delete from private.processing_output_writes where id=p_write_id;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.begin_processing_output_write(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.finish_processing_output_write(uuid) from public,anon,authenticated;
grant execute on function public.begin_processing_output_write(uuid,uuid,text,text,text) to service_role;
grant execute on function public.finish_processing_output_write(uuid) to service_role;

create function public.deletion_pending_output_writes(p_deletion_id uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d private.video_deletion_jobs%rowtype; writes jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into d from private.video_deletion_jobs where id=p_deletion_id and lease_token=p_token
    and state='DELETING' and lease_until>clock_timestamp();
  if not found then raise exception 'DELETION_LEASE_LOST'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'objectKey',object_key,'uploadId',upload_id)),'[]'::jsonb)
    into writes from private.processing_output_writes where job_id=any(d.job_ids);
  return writes;
end $$;
revoke all on function public.deletion_pending_output_writes(uuid,uuid) from public,anon,authenticated;
grant execute on function public.deletion_pending_output_writes(uuid,uuid) to service_role;

create or replace function public.deletion_assert_lease(p_deletion_id uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d private.video_deletion_jobs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into d from private.video_deletion_jobs where id=p_deletion_id and lease_token=p_token
    and state='DELETING' and lease_until>clock_timestamp();
  if not found then raise exception 'DELETION_LEASE_LOST'; end if;
  if exists(select 1 from private.processing_output_writes where job_id=any(d.job_ids))
    then raise exception 'DELETION_OUTPUT_WRITES_PENDING'; end if;
  return jsonb_build_object('ok',true);
end $$;

-- The FK also prevents finalize bypassing this guard while writes are pending.
notify pgrst, 'reload schema';
commit;
