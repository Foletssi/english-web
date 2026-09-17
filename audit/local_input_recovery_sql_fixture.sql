-- Run only within BEGIN/ROLLBACK. Synthetic rows; no AI calls or media deletion.
do $fixture$
declare
 v_admin uuid; v_job uuid:=gen_random_uuid(); v_source uuid:=gen_random_uuid(); v_run uuid:=gen_random_uuid();
 v_challenge uuid:=gen_random_uuid(); v_rev bigint; v_original jsonb; v_result jsonb; v_descriptor jsonb;
 v_video text:='900000000005'; v_worker text:='audit-local-'||gen_random_uuid(); v_failed boolean; v_new uuid; v_reserved jsonb;
 v_sha text:=repeat('c',64); v_origin text:='https://english-web-lce.pages.dev'; v_input jsonb;
begin
 select p.id into v_admin from public.profiles p where p.is_active is true and
  (lower(p.role)='admin' or exists(select 1 from private.admin_memberships m where m.user_id=p.id and m.status='active')) limit 1;
 if v_admin is null then raise exception 'FIXTURE_ADMIN_UNAVAILABLE'; end if;
 select revision,draft into v_rev,v_original from private.content_snapshots where environment='production' for update;
 if v_original::text like '%'||v_video||'%' or exists(select 1 from public.processing_jobs where video_id=v_video)
  then raise exception 'FIXTURE_ID_COLLISION'; end if;
 insert into public.processing_workers(worker_id,capabilities,last_seen_at)
  values(v_worker,'{"localInputV1":true,"teachingVoiceV1":true,"learningRepairV5":true,"teachingSchemaVersion":3}',now());
 insert into public.processing_jobs(id,video_id,source_key,requested_by,idempotency_key,input_revision,status,stage,run_id,worker_id,
  worker_token_hash,worker_token_expires_at,source_token_hash,source_token_expires_at,lease_until)
  values(v_job,v_video,'videos/'||v_job||'/source.mp4',v_admin,'audit-'||v_job,v_rev,'RUNNING','LOCAL_DOWNLOAD',v_run,v_worker,
   repeat('a',64),now()+interval '5 minutes',repeat('b',64),now()+interval '5 minutes',now()+interval '5 minutes');
 insert into private.processing_job_runs(job_id,run_id,worker_id) values(v_job,v_run,v_worker);
 insert into private.processing_local_inputs(job_id,source_id,worker_id,intake_state,source_name,source_size,expected_sha256,
  source_sha256,ready_at,reservation,origin,ticket_hash,ticket_expires_at)
  values(v_job,v_source,v_worker,'READY','fixture.mp4',10,v_sha,v_sha,now(),'{}',v_origin,repeat('d',64),now()+interval '5 minutes');
 update private.content_snapshots c set draft=jsonb_set(c.draft,'{videos}',coalesce(c.draft->'videos','[]'::jsonb)||
  jsonb_build_array(jsonb_build_object('id',v_video::bigint,'title','Rollback local input fixture','processingJobId',v_job)))
  where environment='production';
 v_descriptor:=private.processing_input_descriptor_v1(v_job);
 perform set_config('request.jwt.claim.role','service_role',true);
 perform public.processing_local_challenge_v1(v_worker,v_challenge,v_origin);
 v_failed:=false;
 begin perform public.processing_local_missing_v1(v_worker,v_source,repeat('f',64));
 exception when others then if sqlerrm<>'SOURCE_DECLARATION_CONFLICT' then raise; end if; v_failed:=true; end;
 if not v_failed then raise exception 'MISSING_SHA_GATE_FAILED'; end if;
 perform public.processing_local_missing_v1(v_worker,v_source,v_sha);
 if not exists(select 1 from private.processing_local_inputs where job_id=v_job and intake_state='MISSING')
  or not exists(select 1 from public.processing_jobs where id=v_job and status='WAITING' and run_id is null
   and worker_token_hash is null and source_token_hash is null and lease_until is null)
  or not exists(select 1 from private.processing_job_runs where job_id=v_job and run_id=v_run and ended_at is not null and outcome='LEASE_LOST')
  then raise exception 'MISSING_DID_NOT_REVOKE_RUN'; end if;
 v_failed:=false;
 begin perform public.processing_report_job_v2(v_job,v_run,'stale-token',v_worker,1,'ENRICH',50,'stale','{}');
 exception when others then if sqlerrm<>'JOB_LEASE_LOST_OR_CANCELLED' then raise; end if; v_failed:=true; end;
 if not v_failed then raise exception 'STALE_RUN_ACCEPTED'; end if;
 update private.processing_feature_flags set enabled=false where name='local_input_v1';
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claim.sub',v_admin::text,true);
 if public.admin_local_processing_capability_v1()->>'enabled'<>'false' then raise exception 'FEATURE_FLAG_FAILED'; end if;
 v_input:=jsonb_build_object('name','renamed.mp4','size',10,'sha256',v_sha);
 v_failed:=false;
 begin perform public.admin_reserve_local_processing_job_v1('{}',v_input,v_worker,v_challenge,v_origin,'new-'||v_job,v_rev);
 exception when others then if sqlerrm<>'LOCAL_INPUT_DISABLED' then raise; end if; v_failed:=true; end;
 if not v_failed then raise exception 'DISABLED_RESERVATION_ALLOWED'; end if;
 v_failed:=false;
 begin perform public.admin_recover_local_processing_input_v1(v_job,v_input,'another-worker',v_challenge,v_origin);
 exception when others then if sqlerrm<>'LOCAL_WORKER_MISMATCH' then raise; end if; v_failed:=true; end;
 if not v_failed then raise exception 'RECOVERY_WORKER_GATE_FAILED'; end if;
 v_failed:=false;
 begin perform public.admin_recover_local_processing_input_v1(v_job,v_input||jsonb_build_object('sha256',repeat('f',64)),v_worker,v_challenge,v_origin);
 exception when others then if sqlerrm<>'SOURCE_DECLARATION_CONFLICT' then raise; end if; v_failed:=true; end;
 if not v_failed then raise exception 'RECOVERY_SHA_GATE_FAILED'; end if;
 v_result:=public.admin_recover_local_processing_input_v1(v_job,v_input,v_worker,v_challenge,v_origin);
 if v_result->'inputSource' is distinct from v_descriptor or v_result->'job'->>'id'<>v_job::text
  or not exists(select 1 from private.processing_local_inputs where job_id=v_job and intake_state='RECEIVING')
  or (select count(*) from public.processing_jobs where video_id=v_video)<>1 then raise exception 'RECOVERY_IDENTITY_CHANGED'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 perform public.processing_local_ready_v1(v_worker,v_source,v_sha);
 if not exists(select 1 from public.processing_jobs where id=v_job and status='QUEUED' and run_id is null)
  then raise exception 'RECOVERY_NOT_REQUEUED'; end if;
 update public.processing_jobs set status='CANCELLED',cancel_requested_at=now() where id=v_job;
 perform set_config('request.jwt.claim.role','authenticated',true);
 v_failed:=false;
 begin perform public.admin_recover_local_processing_input_v1(v_job,v_input,v_worker,v_challenge,v_origin);
 exception when others then if sqlerrm<>'LOCAL_INPUT_CANCELLED' then raise; end if; v_failed:=true; end;
 if not v_failed then raise exception 'CANCELLED_RECOVERY_ALLOWED'; end if;
 if has_function_privilege('anon','public.admin_recover_local_processing_input_v1(uuid,jsonb,text,uuid,text)','EXECUTE')
  or has_function_privilege('authenticated','public.processing_local_missing_v1(text,uuid,text)','EXECUTE')
  or has_table_privilege('authenticated','private.processing_feature_flags','SELECT') then raise exception 'PERMISSION_LEAK'; end if;
 -- Exercise the actual new-intake transaction and a lost-response replay.
 update private.processing_feature_flags set enabled=true where name='local_input_v1';
 select revision into v_rev from private.content_snapshots where environment='production';
 v_reserved:=public.admin_reserve_local_processing_job_v1('{"title":"Rollback new intake"}',v_input,v_worker,v_challenge,v_origin,'new-'||v_job,v_rev);
 v_new:=(v_reserved->'job'->>'id')::uuid;
 if v_new is null or v_reserved->'job'->>'status'<>'WAITING'
  or v_reserved->'inputSource'->>'kind'<>'local_file' then raise exception 'NEW_INTAKE_NOT_WAITING'; end if;
 update private.processing_feature_flags set enabled=false where name='local_input_v1';
 v_result:=public.admin_reserve_local_processing_job_v1('{"title":"Rollback new intake"}',v_input,v_worker,v_challenge,v_origin,'new-'||v_job,v_rev);
 if v_result->'inputSource' is distinct from v_reserved->'inputSource'
  or v_result->'job'->>'id'<>v_new::text then raise exception 'RESERVATION_REPLAY_CHANGED_IDENTITY'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 if public.processing_claim_local_input_v1(v_worker,repeat('a',64),180) is not null then raise exception 'INCOMPLETE_INPUT_CLAIMED'; end if;
 perform public.processing_local_ready_v1(v_worker,(v_reserved->'inputSource'->>'sourceId')::uuid,v_sha);
 v_result:=public.processing_claim_local_input_v1(v_worker,repeat('a',64),180);
 if v_result->>'id' is distinct from v_new::text or v_result->'inputSource' is distinct from v_reserved->'inputSource'
  then raise exception 'READY_INPUT_NOT_CLAIMED'; end if;
 update public.processing_jobs set status='CANCELLED',cancel_requested_at=now(),lease_until=null where id=v_new;
 if public.processing_local_cleanup_status_v1(v_worker,v_source)->>'allowed'<>'false'
  then raise exception 'CLEANUP_INCOMPLETE_ALLOWED'; end if;
 update public.processing_jobs set status='REVIEW',cancel_requested_at=null where id=v_job;
 if public.processing_local_cleanup_status_v1(v_worker,v_source)->>'allowed'<>'true'
  or public.processing_local_cleanup_status_v1('different-worker',v_source)->>'allowed'<>'false'
  then raise exception 'CLEANUP_COMPLETION_WORKER_GATE'; end if;
 update public.processing_jobs set source_key=(select source_key from public.processing_jobs where id=v_job) where id=v_new;
 if public.processing_local_cleanup_status_v1(v_worker,v_source)->>'allowed'<>'false'
  then raise exception 'CLEANUP_CONSUMER_GATE'; end if;
 if has_function_privilege('authenticated','public.processing_local_cleanup_status_v1(text,uuid)','EXECUTE')
  or has_function_privilege('anon','public.processing_local_cleanup_status_v1(text,uuid)','EXECUTE')
  then raise exception 'CLEANUP_PERMISSION_LEAK'; end if;
end $fixture$;
