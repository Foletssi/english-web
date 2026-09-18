-- Caller owns BEGIN/ROLLBACK. Only synthetic jobs are changed; never claim work.
do $fixture$
declare
  actor uuid; j public.processing_jobs%rowtype; old_run uuid:=gen_random_uuid();
  vid text:='900000000019'; source text:='videos/'||gen_random_uuid()::text||'/source.mp4';
  rev bigint; original jsonb; video jsonb; response jsonb; summary jsonb;
begin
  select p.id into actor from public.profiles p where p.is_active is true and
    (lower(p.role)='admin' or exists(select 1 from private.admin_memberships m where m.user_id=p.id and m.status='active')) limit 1;
  if actor is null then raise exception 'FIXTURE_ADMIN_UNAVAILABLE'; end if;
  select c.revision,c.draft into rev,original from private.content_snapshots c where c.environment='production' for update;
  if original::text like '%'||vid||'%' or exists(select 1 from public.processing_jobs where video_id=vid)
    then raise exception 'FIXTURE_ID_COLLISION'; end if;
  insert into public.processing_jobs(video_id,source_key,requested_by,idempotency_key,input_revision,status,stage,progress,run_id,input,attempt,automatic_recovery_count,work)
    values(vid,source,actor,'audit-recovery-'||gen_random_uuid(),rev,'ERROR','LOCAL_UPLOAD',97,old_run,
      '{"kind":"CLOUD_PIPELINE"}',3,2,'{"telemetry":{"stages":{"teaching":{"state":"DONE"}}}}') returning * into j;
  insert into private.processing_job_runs(job_id,run_id,worker_id,outcome) values(j.id,old_run,'rollback-recovery','ERROR');
  video:=jsonb_build_object('id',vid::bigint,'title','Rollback recovery fixture','processingJobId',j.id);
  update private.content_snapshots set draft=jsonb_set(original,'{videos}',coalesce(original->'videos','[]'::jsonb)||jsonb_build_array(video)) where environment='production';
  insert into private.processing_output_receipts(job_id,run_id,path,size,sha256,etag,confirmed_at)
    values(j.id,old_run,'cover-320.webp',1000,repeat('a',64),'rollback-only',now()),
      (j.id,old_run,'cover.webp',2000,repeat('b',64),'rollback-only',now());
  if (select path from private.processing_admin_cover_preview_v1(j.id,old_run,null)) is distinct from 'cover-320.webp'
    then raise exception 'COVER_PRIORITY_FAILED'; end if;
  if exists(select 1 from private.processing_admin_cover_preview_v1(j.id,gen_random_uuid(),null))
    or exists(select 1 from private.processing_admin_cover_preview_v1(j.id,old_run,'../cover.webp'))
    then raise exception 'COVER_RUN_OR_PATH_FENCE_FAILED'; end if;
  delete from private.processing_output_receipts where job_id=j.id and path='cover-320.webp';
  if exists(select 1 from private.processing_admin_cover_preview_v1(j.id,old_run,'cover-320.webp')) then raise exception 'UNCONFIRMED_COVER_ACCEPTED'; end if;
  insert into private.processing_output_receipts(job_id,run_id,path,size,sha256,etag,confirmed_at)
    values(j.id,old_run,'cover-320.webp',1000,repeat('a',64),'rollback-only',now());
  update public.processing_jobs set cancel_requested_at=now() where id=j.id;
  if exists(select 1 from private.processing_admin_cover_preview_v1(j.id,old_run,null)) then raise exception 'CANCELLED_COVER_ACCEPTED'; end if;
  update public.processing_jobs set cancel_requested_at=null where id=j.id;
  update private.content_snapshots set draft=original where environment='production';
  if exists(select 1 from private.processing_admin_cover_preview_v1(j.id,old_run,null)) then raise exception 'ORPHAN_COVER_ACCEPTED'; end if;
  update private.content_snapshots set draft=jsonb_set(original,'{videos}',coalesce(original->'videos','[]'::jsonb)||jsonb_build_array(video)) where environment='production';
  perform set_config('request.jwt.claim.role','service_role',true);
  response:=public.service_resolve_admin_cover_preview_v1(actor,j.id,old_run,'cover-320.webp');
  if response->>'canPreview' is distinct from 'true' then raise exception 'ADMIN_COVER_DENIED'; end if;
  response:=public.service_resolve_admin_cover_preview_v1(gen_random_uuid(),j.id,old_run,'cover-320.webp');
  if response->>'canPreview' is distinct from 'false' then raise exception 'NONADMIN_COVER_ACCEPTED'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform pg_temp.expect_failure(format('select public.service_resolve_admin_cover_preview_v1(%L,%L,%L,%L)',actor,j.id,old_run,'cover.webp'),'SERVICE_ROLE_REQUIRED');
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  perform pg_temp.expect_failure(format('select public.admin_retry_processing_job(%L)',j.id),'ADMIN_REQUIRED');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  response:=public.admin_retry_processing_job(j.id);
  if response->>'status' is distinct from 'QUEUED' or response->>'stage' is distinct from 'LOCAL_UPLOAD'
    or response->>'progress' is distinct from '97' or response->>'attempt' is distinct from '4'
    or response->>'automatic_recovery_count' is distinct from '0'
    or response#>>'{work,resumePosition,verified}' is distinct from 'false'
    or response#>>'{work,resumePosition,runId}' is distinct from old_run::text
    or response#>'{work,telemetry}' is not null or response->>'run_id' is not null
    or response->>'lease_token' is not null or response->>'worker_token_hash' is not null
    then raise exception 'RETRY_RESUME_CONTRACT_FAILED'; end if;
  select * into j from public.processing_jobs where id=j.id;
  summary:=private.processing_job_admin_summary_v1(j,video);
  if summary#>>'{resumePosition,verified}' is distinct from 'false' or summary->>'previewCover' is not null
    then raise exception 'RETRY_SUMMARY_FAILED'; end if;
  perform pg_temp.expect_failure(format('select public.admin_retry_processing_job(%L)',j.id),'JOB_NOT_RETRYABLE');
  if (select count(*) from private.processing_job_events where job_id=j.id and kind='RETRY')<>1 then raise exception 'DUPLICATE_RETRY_EVENT'; end if;
  update public.processing_jobs set status='ERROR',input='{"kind":"LEARNING_REPAIR"}',stage='LOCAL_UPLOAD',progress=97 where id=j.id;
  video:=video||jsonb_build_object('learningRepairJobId',j.id);
  update private.content_snapshots set draft=jsonb_set(original,'{videos}',coalesce(original->'videos','[]'::jsonb)||jsonb_build_array(video)) where environment='production';
  response:=public.admin_retry_processing_job(j.id);
  if response->>'stage' is distinct from 'ENRICH' or response->>'progress' is distinct from '70'
    or response->>'attempt' is distinct from '5' then raise exception 'REPAIR_RETRY_COMPATIBILITY_FAILED'; end if;
  if has_function_privilege('authenticated','public.service_resolve_admin_cover_preview_v1(uuid,uuid,uuid,text)','EXECUTE')
    or has_function_privilege('anon','public.admin_retry_processing_job(uuid)','EXECUTE') then raise exception 'RECOVERY_RPC_PERMISSION_LEAK'; end if;
end $fixture$;
