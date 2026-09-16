-- Run only inside the rollback transaction assembled with the two migrations.
-- No R2 requests, cron changes, real account edits, or persistent fixture data.
create function pg_temp.expect_error(statement text, expected text)
returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    if position(expected in sqlerrm)>0 then return; end if;
    raise;
  end;
  raise exception 'EXPECTED_ERROR_NOT_RAISED: %',expected;
end $$;

do $fixture$
declare
  admin_id uuid; current_job uuid:=gen_random_uuid(); old_job uuid:=gen_random_uuid();
  run uuid:=gen_random_uuid(); deletion uuid; lease uuid:=gen_random_uuid(); receipt uuid;
  source text:='videos/'||gen_random_uuid()::text||'/source.mp4';
  reserved text:='videos/'||gen_random_uuid()::text||'/source.mp4';
  shared text:='videos/'||gen_random_uuid()::text||'/source.mp4';
  rev bigint; result jsonb; scope jsonb; prior_draft jsonb; item jsonb;
begin
  select p.id into admin_id from public.profiles p where p.is_active is true and
    (lower(p.role)='admin' or exists(select 1 from private.admin_memberships m where m.user_id=p.id and m.status='active')) limit 1;
  if admin_id is null then raise exception 'FIXTURE_ADMIN_UNAVAILABLE'; end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  if not public.is_admin() then raise exception 'FIXTURE_ADMIN_CONTEXT_FAILED'; end if;
  if exists(select 1 from public.processing_jobs where video_id in ('900000000001','900000000002')) then raise exception 'FIXTURE_ID_COLLISION'; end if;
  select revision,draft into rev,prior_draft from private.content_snapshots where environment='production' for update;
  if prior_draft::text like '%900000000001%' or prior_draft::text like '%900000000002%' then raise exception 'FIXTURE_CONTENT_COLLISION'; end if;

  insert into public.processing_jobs(id,video_id,source_key,requested_by,idempotency_key,input_revision,status,stage,automatic_recovery_count)
  values(current_job,'900000000001',source,admin_id,'rollback-'||current_job,rev,'ERROR','ENRICH',3),
        (old_job,'900000000001',source,admin_id,'rollback-'||old_job,rev,'ERROR','ENRICH',3);
  item:=jsonb_build_object('id',900000000001,'title','Rollback fixture','mediaKey',source,'processingJobId',current_job);
  update private.content_snapshots set draft=jsonb_set(draft,'{videos}',coalesce(draft->'videos','[]'::jsonb)||jsonb_build_array(item)) where environment='production';
  result:=public.admin_retry_processing_job(current_job);
  if result->>'status'<>'QUEUED' or (result->>'attempt')::int<>2 or (result->>'automatic_recovery_count')::int<>0 then raise exception 'RETRY_BUDGET_FAILED'; end if;
  perform pg_temp.expect_error(format('select public.admin_retry_processing_job(%L)',current_job),'JOB_NOT_RETRYABLE');
  perform pg_temp.expect_error(format('select public.admin_retry_processing_job(%L)',old_job),'JOB_SUPERSEDED');

  perform set_config('request.jwt.claim.role','service_role',true);
  perform pg_temp.expect_error(format('select public.processing_commit_result(%L,%L::jsonb)',old_job,'{}'),'JOB_SUPERSEDED');
  perform pg_temp.expect_error(format('select public.processing_commit_learning_repair_v5(%L,%L,%L,%L,%L::jsonb)',old_job,run,'token','fixture','{}'),'JOB_SUPERSEDED');
  perform pg_temp.expect_error(format('select public.processing_commit_learning_repair_v4(%L,%L,%L,%L,%L::jsonb)',old_job,run,'token','fixture','{}'),'JOB_SUPERSEDED');
  update public.processing_jobs set status='RUNNING',run_id=run,worker_token_hash=encode(extensions.digest('fixture-token','sha256'),'hex'),worker_token_expires_at=now()+interval '10 minutes' where id=current_job;
  result:=public.begin_processing_output_write(current_job,run,'fixture-token','cover.webp','rollback-upload-'||current_job);
  receipt:=(result->>'write_id')::uuid;
  if result->>'object_key' not like '%/runs/'||run::text||'/cover.webp' then raise exception 'OUTPUT_KEY_FAILED'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform pg_temp.expect_error(format('select public.finish_processing_output_write(%L)',receipt),'SERVICE_ROLE_REQUIRED');
  if has_function_privilege('authenticated','public.begin_processing_output_write(uuid,uuid,text,text,text)','EXECUTE') or
     has_function_privilege('anon','public.finish_processing_output_write(uuid)','EXECUTE') or
     has_function_privilege('authenticated','public.deletion_pending_output_writes(uuid,uuid)','EXECUTE') then raise exception 'RPC_PERMISSION_LEAK'; end if;

  insert into private.content_video_trash(environment,video_id,payload,deleted_by)
  values('production','900000000002',jsonb_build_object('draft',jsonb_build_object('video',jsonb_build_object('id',900000000002,'title','Rollback trash','mediaKey',reserved))),admin_id);
  result:=public.admin_plan_permanent_video_delete('900000000002',rev);
  deletion:=(result->>'planId')::uuid;
  perform pg_temp.expect_error(format('select public.admin_retry_video_deletion(%L)',deletion),'PERMANENT_DELETE_CONFIRMATION_REQUIRED');
  -- A changed revision forces recomputation of the exact source scope.
  update private.content_video_trash set payload=jsonb_set(payload,'{draft,video,mediaKey}',to_jsonb(shared)) where video_id='900000000002' and restored_at is null;
  update private.content_snapshots set revision=revision+1 where environment='production';
  result:=public.admin_plan_permanent_video_delete('900000000002',rev+1);
  select source_keys into scope from private.video_deletion_jobs where id=deletion;
  if result->>'planId'<>deletion::text or not(scope ? shared) or scope ? reserved then raise exception 'PLAN_SCOPE_NOT_REFRESHED'; end if;
  -- Seed a synthetic confirmed deletion; never call a cleanup endpoint.
  update private.video_deletion_jobs set state='NEEDS_ATTENTION',confirmed_at=now(),source_keys=jsonb_build_array(reserved),job_ids=array[current_job],deleted_objects=2,attempt=5 where id=deletion;
  result:=public.admin_retry_video_deletion(deletion);
  if result->>'state'<>'QUEUED' or (result->>'deletedObjects')::int<>2 then raise exception 'DELETION_RETRY_LOST_PROGRESS'; end if;
  if (select attempt from private.video_deletion_jobs where id=deletion)<>0 then raise exception 'DELETION_RETRY_BUDGET_FAILED'; end if;
  perform public.admin_retry_video_deletion(deletion);
  perform pg_temp.expect_error(format('select public.admin_create_processing_job(%L::jsonb,%L,%L,%s)',jsonb_build_object('id',900000000003,'title','Fixture'),reserved,'rollback-fenced',rev+1),'SOURCE_PERMANENT_DELETION_STARTED');

  foreach item in array array[jsonb_build_object('id',900000000003,'mediaKey',reserved)] loop
    perform pg_temp.expect_error(format('update private.content_snapshots set draft=jsonb_set(draft,%L,coalesce(draft->%L,%L::jsonb)||%L::jsonb) where environment=%L','{videos}','videos','[]',jsonb_build_array(item),'production'),'SOURCE_PERMANENT_DELETION_STARTED');
    perform pg_temp.expect_error(format('update private.content_snapshots set published=jsonb_set(published,%L,coalesce(published->%L,%L::jsonb)||%L::jsonb) where environment=%L','{videos}','videos','[]',jsonb_build_array(item),'production'),'SOURCE_PERMANENT_DELETION_STARTED');
  end loop;
  -- Unchanged references/unrelated edits, shared sources and removals remain valid.
  update private.content_snapshots set draft=draft||'{"fixtureNote":"unchanged references"}'::jsonb where environment='production';
  update private.content_snapshots set draft=jsonb_set(draft,'{videos}',draft->'videos'||jsonb_build_array(jsonb_build_object('id',900000000004,'mediaKey',shared))) where environment='production';
  update private.content_snapshots set draft=prior_draft where environment='production';

  perform set_config('request.jwt.claim.role','service_role',true);
  update private.video_deletion_jobs set state='DELETING',lease_token=lease,lease_until=clock_timestamp()+interval '5 minutes' where id=deletion;
  result:=public.deletion_pending_output_writes(deletion,lease);
  if jsonb_array_length(result)<>1 or result->0->>'id'<>receipt::text then raise exception 'PENDING_WRITE_SCOPE_FAILED'; end if;
  perform pg_temp.expect_error(format('select public.deletion_pending_output_writes(%L,%L)',deletion,gen_random_uuid()),'DELETION_LEASE_LOST');
  perform pg_temp.expect_error(format('select public.deletion_assert_lease(%L,%L)',deletion,lease),'DELETION_OUTPUT_WRITES_PENDING');
  perform pg_temp.expect_error(format('select public.begin_processing_output_write(%L,%L,%L,%L,%L)',current_job,run,'fixture-token','cover.webp','late-fixture'),'VIDEO_PERMANENT_DELETION_STARTED');
  perform public.finish_processing_output_write(receipt);
  perform public.finish_processing_output_write(receipt);
  perform public.deletion_assert_lease(deletion,lease);
  update private.video_deletion_jobs set state='DONE' where id=deletion;
  perform pg_temp.expect_error(format('update private.content_snapshots set draft=jsonb_set(draft,%L,coalesce(draft->%L,%L::jsonb)||%L::jsonb) where environment=%L','{videos}','videos','[]',jsonb_build_array(jsonb_build_object('id',900000000003,'mediaKey',reserved)),'production'),'SOURCE_PERMANENT_DELETION_STARTED');
end $fixture$;
select 'deletion_processing_recovery_fixture: PASS (transaction will roll back)' as result;
