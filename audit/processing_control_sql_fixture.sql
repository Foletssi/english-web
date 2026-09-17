-- Run only within BEGIN/ROLLBACK. No source downloads, AI calls or media deletion.
do $fixture$
declare
 v_admin uuid; v_job uuid:=gen_random_uuid(); v_old uuid:=gen_random_uuid();
 v_request uuid:=gen_random_uuid(); v_run uuid; v_new_run uuid; v_updated timestamptz;
 v_rev bigint; v_original jsonb; v_claim jsonb; v_result jsonb; v_group jsonb;
 v_video text:='900000000004'; v_worker text:='audit-control-'||gen_random_uuid();
 v_source text:='videos/'||gen_random_uuid()||'/source.mp4'; v_failed boolean;
begin
 select p.id into v_admin from public.profiles p where p.is_active is true and
  (lower(p.role)='admin' or exists(select 1 from private.admin_memberships m where m.user_id=p.id and m.status='active')) limit 1;
 if v_admin is null then raise exception 'FIXTURE_ADMIN_UNAVAILABLE'; end if;
 select c.revision,c.draft into v_rev,v_original from private.content_snapshots c where c.environment='production' for update;
 if v_original::text like '%'||v_video||'%' or exists(select 1 from public.processing_jobs where video_id=v_video)
  then raise exception 'FIXTURE_ID_COLLISION'; end if;
 insert into public.processing_workers(worker_id,capabilities)
  values(v_worker,'{"teachingVoiceV1":true,"learningRepairV5":true,"teachingSchemaVersion":3}');
 insert into public.processing_jobs(id,video_id,source_key,requested_by,idempotency_key,input_revision,status,stage,next_run_at)
  values(v_job,v_video,v_source,v_admin,'audit-'||v_job,v_rev,'QUEUED','LOCAL_DOWNLOAD','-infinity'),
        (v_old,v_video,v_source,v_admin,'audit-'||v_old,v_rev,'REVIEW','ENRICH',now());
 update public.processing_jobs set input='{"kind":"LEARNING_REPAIR"}' where id=v_job;
 update private.content_snapshots c set draft=jsonb_set(c.draft,'{videos}',
  coalesce(c.draft->'videos','[]'::jsonb)||jsonb_build_array(jsonb_build_object(
   'id',v_video::bigint,'title','Rollback control fixture','mediaKey',v_source,
   'processingJobId',v_old,'learningRepairJobId',v_job))) where c.environment='production';
 perform set_config('request.jwt.claim.role','service_role',true);
 v_claim:=public.processing_claim_local_job_v5(v_worker,repeat('a',64),180);
 if v_claim->>'id' is distinct from v_job::text then raise exception 'FIXTURE_CLAIM_FAILED'; end if;
 v_run:=(v_claim->>'run_id')::uuid;
 select updated_at into v_updated from public.processing_jobs where id=v_job;
 perform set_config('request.jwt.claim.role','authenticated',true);
 perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
 v_failed:=false;
 begin
  perform public.admin_control_processing_job_v1(v_job,v_run,v_updated,'cancel',v_request);
 exception when others then if sqlerrm<>'ADMIN_REQUIRED' then raise; end if; v_failed:=true; end;
 if not v_failed then raise exception 'ADMIN_GATE_FAILED'; end if;
 perform set_config('request.jwt.claim.sub',v_admin::text,true);
 v_failed:=false;
 begin
  perform public.admin_control_processing_job_v1(v_job,gen_random_uuid(),v_updated,'cancel',gen_random_uuid());
 exception when others then if sqlerrm<>'PROCESSING_STATE_CHANGED' then raise; end if; v_failed:=true; end;
 if not v_failed then raise exception 'RUN_FENCE_FAILED'; end if;
 v_result:=public.admin_control_processing_job_v1(v_job,v_run,v_updated,'cancel',v_request);
 if v_result->>'status' is distinct from 'CANCELLED' then raise exception 'CANCEL_FAILED'; end if;
 if exists(select 1 from public.processing_jobs where id=v_job and
  (lease_token is not null or lease_until is not null or worker_token_hash is not null or source_token_hash is not null))
  or not exists(select 1 from private.processing_job_runs where job_id=v_job and run_id=v_run and ended_at is not null and outcome='CANCELLED')
  then raise exception 'CANCEL_DID_NOT_REVOKE_LEASE'; end if;
 if public.admin_control_processing_job_v1(v_job,v_run,v_updated,'cancel',v_request) is distinct from v_result
  then raise exception 'IDEMPOTENT_RECEIPT_FAILED'; end if;
 v_failed:=false;
 begin
  perform public.admin_control_processing_job_v1(v_job,v_run,v_updated,'retry_failed_stage',v_request);
 exception when others then if sqlerrm<>'PROCESSING_COMMAND_CONFLICT' then raise; end if; v_failed:=true; end;
 if not v_failed then raise exception 'REQUEST_CONFLICT_FAILED'; end if;
 v_failed:=false;
 begin
  perform public.admin_control_processing_job_v1(v_job,v_run,v_updated,'retry_failed_stage',gen_random_uuid());
 exception when others then if sqlerrm<>'PROCESSING_STATE_CHANGED' then raise; end if; v_failed:=true; end;
 if not v_failed then raise exception 'UPDATED_FENCE_FAILED'; end if;
 select updated_at into v_updated from public.processing_jobs where id=v_job;
 v_request:=gen_random_uuid();
 v_result:=public.admin_control_processing_job_v1(v_job,v_run,v_updated,'retry_failed_stage',v_request);
 if not exists(select 1 from public.processing_jobs where id=v_job and status='QUEUED' and run_id is null and cancel_requested_at is null)
  then raise exception 'RETRY_NOT_REQUEUED'; end if;
 if public.admin_control_processing_job_v1(v_job,v_run,v_updated,'retry_failed_stage',v_request) is distinct from v_result
  then raise exception 'RETRY_RECEIPT_FAILED'; end if;
 update public.processing_jobs set next_run_at='-infinity' where id=v_job;
 perform set_config('request.jwt.claim.role','service_role',true);
 v_claim:=public.processing_claim_local_job_v5(v_worker,repeat('b',64),180);
 v_new_run:=(v_claim->>'run_id')::uuid;
 if v_claim->>'id' is distinct from v_job::text or v_new_run is null or v_new_run=v_run then raise exception 'NEW_RUN_FAILED'; end if;
 v_failed:=false;
 begin
  perform public.processing_report_job_v2(v_job,v_run,'stale-token',v_worker,1,'ENRICH',50,'stale','{}');
 exception when others then if sqlerrm<>'JOB_LEASE_LOST_OR_CANCELLED' then raise; end if; v_failed:=true; end;
 if not v_failed then raise exception 'STALE_WRITER_ACCEPTED'; end if;
 -- More than five historical jobs must not evict either current pointer.
 insert into public.processing_jobs(video_id,source_key,requested_by,idempotency_key,input_revision,status,stage,updated_at)
 select v_video,v_source,v_admin,'audit-'||gen_random_uuid(),v_rev,'REVIEW','ENRICH',clock_timestamp() from generate_series(1,7);
 perform set_config('request.jwt.claim.role','authenticated',true);
 select item into v_group from jsonb_array_elements(public.admin_list_processing_video_groups_v1(1,100)->'items') item
  where item->>'videoId'=v_video;
 if v_group is null or jsonb_array_length(v_group->'records')<>5
  or not exists(select 1 from jsonb_array_elements(v_group->'records') x where x->>'id'=v_job::text)
  or not exists(select 1 from jsonb_array_elements(v_group->'records') x where x->>'id'=v_old::text)
  then raise exception 'CURRENT_POINTERS_EVICTED'; end if;
 if has_function_privilege('anon','public.admin_control_processing_job_v1(uuid,uuid,timestamptz,text,uuid)','EXECUTE')
  or has_table_privilege('authenticated','private.processing_control_commands','SELECT') then raise exception 'PERMISSION_LEAK'; end if;
end $fixture$;
