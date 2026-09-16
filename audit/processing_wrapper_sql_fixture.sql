-- Execute inside BEGIN/ROLLBACK only. Synthetic rows are never visible to workers.
-- Set eastudy.audit_expect_ambiguity=on to reproduce both pre-fix failures.
do $fixture$
declare
  v_admin uuid; v_job uuid:=gen_random_uuid(); v_claim jsonb; v_response jsonb;
  v_rev bigint; v_source text:='videos/'||gen_random_uuid()::text||'/source.mp4';
  v_worker text:='audit-'||gen_random_uuid()::text;
  v_video text:='900000000003'; v_original jsonb;
  v_expect_error boolean:=coalesce(current_setting('eastudy.audit_expect_ambiguity',true),'off')='on';
  v_failed boolean;
begin
  select p.id into v_admin from public.profiles p where p.is_active is true and
    (lower(p.role)='admin' or exists(select 1 from private.admin_memberships m where m.user_id=p.id and m.status='active')) limit 1;
  if v_admin is null then raise exception 'FIXTURE_ADMIN_UNAVAILABLE'; end if;
  select c.revision,c.draft into v_rev,v_original from private.content_snapshots c where c.environment='production' for update;
  if v_original::text like '%'||v_video||'%' or exists(select 1 from public.processing_jobs j where j.video_id=v_video)
    then raise exception 'FIXTURE_ID_COLLISION'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  insert into public.processing_workers(worker_id,capabilities) values(v_worker,'{"teachingVoiceV1":true,"learningRepairV5":true,"teachingSchemaVersion":3}');
  insert into public.processing_jobs(id,video_id,source_key,requested_by,idempotency_key,input_revision,status,stage,next_run_at)
    values(v_job,v_video,v_source,v_admin,'audit-'||v_job,v_rev,'QUEUED','LOCAL_DOWNLOAD','-infinity');

  -- Invoke the real public wrapper AND the real lease/claim implementation.
  v_failed:=false;
  begin
    v_claim:=public.processing_claim_local_job_v5(v_worker,repeat('a',64),180);
  exception when ambiguous_column then
    if not v_expect_error then raise; end if;
    v_failed:=true;
  end;
  if v_expect_error and not v_failed then raise exception 'EXPECTED_CLAIM_AMBIGUITY_MISSING'; end if;
  if not v_expect_error then
    if v_claim->>'id' is distinct from v_job::text or v_claim->>'status' is distinct from 'RUNNING'
      or v_claim#>'{input,teachingVoiceRequired}' is distinct from 'true'::jsonb
      or nullif(v_claim->>'run_id','') is null then raise exception 'CLAIM_CONTRACT_FAILED'; end if;
    if not exists(select 1 from public.processing_jobs j where j.id=v_job and j.input->'teachingVoiceRequired'='true'::jsonb)
      then raise exception 'VOICE_FLAG_NOT_PERSISTED'; end if;
    if not exists(select 1 from private.processing_job_runs r where r.job_id=v_job and r.run_id=(v_claim->>'run_id')::uuid)
      then raise exception 'CLAIM_RUN_MISSING'; end if;
  end if;
  update public.processing_jobs set status='REVIEW' where id=v_job;
  update public.processing_workers set capabilities='{}'::jsonb where worker_id=v_worker;
  if public.processing_claim_local_job_v5(v_worker,repeat('a',64),180) is not null then raise exception 'VOICE_GATE_FAILED'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  v_failed:=false;
  begin
    perform public.processing_claim_local_job_v5(v_worker,repeat('a',64),180);
  exception when others then
    if sqlerrm<>'SERVICE_ROLE_REQUIRED' then raise; end if;
    v_failed:=true;
  end;
  if not v_failed then raise exception 'SERVICE_ROLE_GATE_FAILED'; end if;

  perform set_config('request.jwt.claim.sub',v_admin::text,true);
  update private.content_snapshots c set draft=jsonb_set(jsonb_set(c.draft,'{videos}',
    coalesce(c.draft->'videos','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id',v_video::bigint,'title','Rollback fixture','mediaKey',v_source))),
    '{sentences}',coalesce(c.draft->'sentences','{}'::jsonb)||jsonb_build_object(v_video,
      jsonb_build_array(jsonb_build_object('id','audit-sentence','english','This is a rollback fixture.','chinese','测试句子'))))
    where c.environment='production';
  v_failed:=false;
  begin
    v_response:=public.admin_create_learning_repair_job_v5(v_video,v_rev,'reextract');
  exception when ambiguous_column then
    if not v_expect_error then raise; end if;
    v_failed:=true;
  end;
  if v_expect_error and not v_failed then raise exception 'EXPECTED_REPAIR_AMBIGUITY_MISSING'; end if;
  if not v_expect_error then
    if v_response#>>'{job,input,coverageScope}' is distinct from 'full-video'
      or v_response#>'{job,input,targetSentenceIds}' is distinct from '["audit-sentence"]'::jsonb
      or v_response#>>'{job,status}' is distinct from 'QUEUED' then raise exception 'REPAIR_CONTRACT_FAILED'; end if;
    -- The response revision must agree with the transaction's updated snapshot.
    select c.revision into v_rev from private.content_snapshots c where c.environment='production';
    if (v_response->>'revision')::bigint is distinct from v_rev then raise exception 'REPAIR_REVISION_FAILED'; end if;
  end if;
  if has_function_privilege('authenticated','public.processing_claim_local_job_v5(text,text,integer)','EXECUTE')
    or has_function_privilege('anon','public.admin_create_learning_repair_job_v5(text,bigint,text)','EXECUTE')
    then raise exception 'RPC_PERMISSION_LEAK'; end if;
end $fixture$;
