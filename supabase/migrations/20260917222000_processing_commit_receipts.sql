begin;
-- Keep a token-bound receipt in the same transaction as the existing, fully
-- validated commit. A lost HTTP response must not run AI or commit twice.
create table private.processing_commit_receipts (
  job_id uuid not null references public.processing_jobs(id) on delete cascade,
  run_id uuid not null, worker_id text not null, token_hash text not null,
  request_hash text not null, result jsonb not null, created_at timestamptz not null default now(),
  primary key(job_id,run_id)
);
alter table private.processing_commit_receipts enable row level security;
revoke all on private.processing_commit_receipts from public,anon,authenticated;

alter function public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb)
  rename to processing_commit_leased_result_pre_receipt_v2;
alter function public.processing_commit_leased_result_pre_receipt_v2(uuid,uuid,text,text,jsonb,jsonb) set schema private;
revoke all on function private.processing_commit_leased_result_pre_receipt_v2(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated,service_role;

create function public.processing_commit_leased_result_v2(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_result jsonb,p_manifest jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_receipt private.processing_commit_receipts%rowtype; v_result jsonb;
  v_hash text:=encode(extensions.digest(jsonb_build_array(p_result,p_manifest)::text,'sha256'),'hex');
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  -- Preserve global content -> job lock ordering used by deletion and commit.
  perform 1 from private.content_snapshots where environment='production' for update;
  perform 1 from public.processing_jobs where id=p_job_id for update;
  select * into v_receipt from private.processing_commit_receipts where job_id=p_job_id and run_id=p_run_id;
  if found then
    if v_receipt.worker_id is distinct from p_worker_id
      or v_receipt.token_hash is distinct from encode(extensions.digest(p_token,'sha256'),'hex')
      or v_receipt.request_hash is distinct from v_hash then raise exception 'COMMIT_RECEIPT_CONFLICT'; end if;
    return v_receipt.result;
  end if;
  v_result:=private.processing_commit_leased_result_pre_receipt_v2(p_job_id,p_run_id,p_token,p_worker_id,p_result,p_manifest);
  insert into private.processing_commit_receipts(job_id,run_id,worker_id,token_hash,request_hash,result)
    values(p_job_id,p_run_id,p_worker_id,encode(extensions.digest(p_token,'sha256'),'hex'),v_hash,v_result);
  return v_result;
end $$;
revoke all on function public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
