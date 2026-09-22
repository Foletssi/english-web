-- Execute only inside the rollback transaction assembled by test-local-inputs.
-- Synthetic jobs and receipts remain invisible outside this transaction.
do $fixture$
declare
  v_admin uuid; v_job uuid:=gen_random_uuid(); v_run uuid:=gen_random_uuid();
  v_worker text:='audit-commit-'||gen_random_uuid()::text;
  v_video text:='900000000009';
  v_token text:=repeat('receipt-token-',4); v_rev bigint; v_failed boolean;
  v_result jsonb:='{"video":{"title":"Rollback receipt fixture"}}';
  v_manifest jsonb:='[]'; v_saved jsonb:='{"status":"REVIEW","fixture":"commit-receipt"}';
  v_case jsonb; v_role text;
begin
  select p.id into v_admin from public.profiles p where p.is_active is true and
    (lower(p.role)='admin' or exists(select 1 from private.admin_memberships m where m.user_id=p.id and m.status='active')) limit 1;
  if v_admin is null then raise exception 'FIXTURE_ADMIN_UNAVAILABLE'; end if;
  select c.revision into v_rev from private.content_snapshots c where c.environment='production' for update;
  if v_rev is null then raise exception 'FIXTURE_CONTENT_UNAVAILABLE'; end if;
  if exists(select 1 from public.processing_jobs where video_id=v_video)
    or exists(select 1 from private.content_snapshots where environment='production' and draft::text like '%'||v_video||'%')
    then raise exception 'FIXTURE_ID_COLLISION'; end if;
  insert into public.processing_jobs(id,video_id,source_key,requested_by,idempotency_key,input_revision,
    status,stage,run_id,worker_id,lease_until,worker_token_expires_at,worker_token_hash)
  values(v_job,v_video,'videos/'||gen_random_uuid()||'/source.mp4',v_admin,'audit-'||v_job,v_rev,
    'RUNNING','LOCAL_UPLOAD',v_run,v_worker,now()+interval '5 minutes',now()+interval '5 minutes',
    encode(extensions.digest(v_token,'sha256'),'hex'));
  insert into private.processing_job_runs(job_id,run_id,worker_id) values(v_job,v_run,v_worker);
  perform set_config('request.jwt.claim.role','service_role',true);

  -- Exercise the real pre-receipt commit validation, not a stub. An invalid
  -- manifest must retain its exact error and roll back without a receipt.
  v_failed:=false;
  begin
    perform public.processing_commit_leased_result_v3(v_job,v_run,v_token,v_worker,v_result,v_manifest);
  exception when others then
    if sqlerrm<>'OUTPUT_MANIFEST_INCOMPLETE' then raise; end if;
    v_failed:=true;
  end;
  if not v_failed then raise exception 'INVALID_MANIFEST_ACCEPTED'; end if;
  if exists(select 1 from private.processing_commit_receipts where job_id=v_job)
    or not exists(select 1 from public.processing_jobs where id=v_job and status='RUNNING' and
      worker_token_hash=encode(extensions.digest(v_token,'sha256'),'hex') and output_run_id is null)
    or exists(select 1 from private.processing_job_runs where job_id=v_job and ended_at is not null)
    then raise exception 'FAILED_COMMIT_LEFT_SIDE_EFFECTS'; end if;
  v_failed:=false;
  begin
    perform public.processing_commit_leased_result_v3(v_job,v_run,repeat('wrong-token-',4),v_worker,v_result,v_manifest);
  exception when others then
    if sqlerrm<>'JOB_LEASE_LOST_OR_CANCELLED' then raise; end if;
    v_failed:=true;
  end;
  if not v_failed or exists(select 1 from private.processing_commit_receipts where job_id=v_job)
    then raise exception 'LEASE_VALIDATION_BYPASSED'; end if;

  -- Seed the durable successful result to isolate replay behavior from the
  -- large teaching/voice payload contract, covered by its own validators.
  insert into private.processing_commit_receipts(job_id,run_id,worker_id,token_hash,request_hash,result)
  values(v_job,v_run,v_worker,encode(extensions.digest(v_token,'sha256'),'hex'),
    encode(extensions.digest(jsonb_build_array(v_result,v_manifest)::text,'sha256'),'hex'),v_saved);
  update public.processing_jobs set status='REVIEW',worker_token_hash=null,worker_token_expires_at=null,
    lease_until=null,output_run_id=v_run where id=v_job;
  if public.processing_commit_leased_result_v3(v_job,v_run,v_token,v_worker,v_result,v_manifest) is distinct from v_saved
    or public.processing_commit_leased_result_v3(v_job,v_run,v_token,v_worker,v_result,v_manifest) is distinct from v_saved
    then raise exception 'COMMIT_REPLAY_FAILED'; end if;

  for v_case in select value from jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('worker',v_worker||'-other','token',v_token,'result',v_result,'manifest',v_manifest),
    jsonb_build_object('worker',v_worker,'token',repeat('wrong-token-',4),'result',v_result,'manifest',v_manifest),
    jsonb_build_object('worker',v_worker,'token',null,'result',v_result,'manifest',v_manifest),
    jsonb_build_object('worker',v_worker,'token',v_token,'result',v_result||'{"changed":true}'::jsonb,'manifest',v_manifest),
    jsonb_build_object('worker',v_worker,'token',v_token,'result',v_result,'manifest','[{"changed":true}]'::jsonb)))
  loop
    v_failed:=false;
    begin
      perform public.processing_commit_leased_result_v3(v_job,v_run,v_case->>'token',v_case->>'worker',v_case->'result',v_case->'manifest');
    exception when others then
      if sqlerrm<>'COMMIT_RECEIPT_CONFLICT' then raise; end if;
      v_failed:=true;
    end;
    if not v_failed then raise exception 'CONFLICTING_REPLAY_ACCEPTED'; end if;
  end loop;
  if (select count(*) from private.processing_commit_receipts where job_id=v_job)<>1
    or (select result from private.processing_commit_receipts where job_id=v_job) is distinct from v_saved
    then raise exception 'COMMIT_RECEIPT_CHANGED'; end if;

  foreach v_role in array array['anon','authenticated',''] loop
    perform set_config('request.jwt.claim.role',v_role,true);
    v_failed:=false;
    begin
      perform public.processing_commit_leased_result_v3(v_job,v_run,v_token,v_worker,v_result,v_manifest);
    exception when others then
      if sqlerrm<>'SERVICE_ROLE_REQUIRED' then raise; end if;
      v_failed:=true;
    end;
    if not v_failed then raise exception 'COMMIT_REPLAY_ROLE_GATE_FAILED'; end if;
  end loop;
  if has_function_privilege('anon','public.processing_commit_leased_result_v3(uuid,uuid,text,text,jsonb,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.processing_commit_leased_result_v3(uuid,uuid,text,text,jsonb,jsonb)','EXECUTE')
    or not has_function_privilege('service_role','public.processing_commit_leased_result_v3(uuid,uuid,text,text,jsonb,jsonb)','EXECUTE')
    or has_function_privilege('service_role','private.processing_commit_leased_result_core(uuid,uuid,text,text,jsonb,jsonb)','EXECUTE')
    or has_table_privilege('anon','private.processing_commit_receipts','SELECT')
    or has_table_privilege('authenticated','private.processing_commit_receipts','INSERT')
    then raise exception 'COMMIT_RECEIPT_PERMISSION_LEAK'; end if;
end $fixture$;
