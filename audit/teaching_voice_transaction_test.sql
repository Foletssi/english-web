-- Execute with 125000 + 126000 inside one caller-owned rollback transaction.
-- Uses only synthetic receipts. Never writes or deletes an R2 object.
do $$
declare c private.content_snapshots%rowtype; j public.processing_jobs%rowtype; repair public.processing_jobs%rowtype;
  row_value jsonb; rows jsonb; manifest jsonb; receipts jsonb; item jsonb; lease jsonb; result jsonb;
  registered jsonb; actor uuid; i integer; path text; prefix text; backup_count integer;
begin
  select * into c from private.content_snapshots where environment='production' for update;
  select * into j from public.processing_jobs where id=(select (v->>'processingJobId')::uuid
    from jsonb_array_elements(c.published->'videos') v where v->>'status'='PUBLISHED' limit 1);
  select id into actor from public.profiles where (private.learning_access_v2(id)->>'canPlay')::boolean is true limit 1;
  if j.output_run_id is null or actor is null then raise exception 'Published output and VIP fixture required'; end if;
  row_value:='{"id":"voice-s1","english":"Go, go!","chinese":"快走吧！","textRevision":2,"startTime":0,"endTime":2,"keyWords":[],"expressions":[],"reviewStatus":"APPROVED",
    "teachingAnalysis":{"status":"completed","promptVersion":"adult-vlog-v9-20260916","reviewVersion":"adult-selection-review-v1-20260916","sourceTextRevision":2},
    "wordLookup":{"schemaVersion":1,"sourceEnglish":"Go, go!","sourceTextRevision":2,"tokens":[{"tokenId":"t0","surface":"Go","start":0,"end":2,"coreMeaningZh":"走","pronunciationHint":"/ɡoʊ/"},{"tokenId":"t1","surface":"go","start":4,"end":6,"coreMeaningZh":"快走","pronunciationHint":"/ɡoʊ/"}]},
    "translationAnalysis":{"status":"completed","promptVersion":"context-lookup-v2-20260916","reviewVersion":"context-lookup-review-v2-20260916","sourceTextRevision":2,"sourceConcerns":[]},
    "coverageAnalysis":{"schemaVersion":1,"status":"completed","promptVersion":"adjacent-coverage-v1-20260916","reviewVersion":"adult-selection-review-v1-20260916","sourceTextRevision":2,"pairs":[]}}'::jsonb;
  rows:=jsonb_build_array(row_value);
  update private.content_snapshots set published=pg_temp.snapshot_with_fixture_rows(published,j.video_id,rows),
    draft=pg_temp.snapshot_with_fixture_rows(draft,j.video_id,rows) where environment='production';
  manifest:=jsonb_build_object('schemaVersion',1,'status','complete','videoId',j.video_id,'contentRevision','rollback-voice','items','[]'::jsonb);
  receipts:='[]'::jsonb;
  for i in 0..1 loop
    path:='voice/'||repeat((i+1)::text,64)||'.mp3';
    item:=jsonb_build_object('videoId',j.video_id,'contentRevision','rollback-voice','sentenceId','voice-s1','sourceTextRevision',2,
      'kind','token','tokenId','t'||i,'itemId',repeat((i+3)::text,64),'fingerprint',repeat((i+1)::text,64),'storagePath',path,
      'text',row_value#>>array['wordLookup','tokens',i::text,'surface'],'status','ready','bytes',1000,'contentHash',repeat('a',64));
    manifest:=jsonb_set(manifest,'{items}',manifest->'items'||jsonb_build_array(item));
    receipts:=receipts||jsonb_build_array(jsonb_build_object('path',path,'size',1000,'sha256',repeat('a',64),'etag','rollback-only'));
  end loop;
  path:=manifest#>>'{items,0,storagePath}';
  perform set_config('request.jwt.claim.role','service_role',true);
  if public.processing_claim_local_job_v5('rollback-no-voice-worker',repeat('a',64),180) is not null
    then raise exception 'Worker without voice capability claimed a job'; end if;
  if has_function_privilege('service_role','private.processing_claim_local_job_pre_voice_v5(text,text,integer)','EXECUTE')
    then raise exception 'Voice claim gate can be bypassed'; end if;
  update public.processing_jobs set input=input||'{"teachingVoiceRequired":true}'::jsonb where id=j.id;
  perform pg_temp.expect_failure(format('select public.processing_commit_learning_repair_v5(%L,%L,%L,%L,%L)',
    j.id,j.output_run_id,'rollback-token','rollback-worker','{}'),'VOICE_MANIFEST_REQUIRED');
  update public.processing_jobs set input=j.input where id=j.id;
  perform pg_temp.expect_failure(format('select public.service_begin_voice_refresh(%L,%s)',j.id,c.revision+1),'CONTENT_REVISION_CONFLICT');
  lease:=public.service_begin_voice_refresh(j.id,c.revision);
  prefix:='videos/'||substring(j.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||j.id||'/runs/'||j.output_run_id||'/';
  if (select object_key from public.resolve_processing_output_v2(j.id,j.output_run_id,lease->>'token',path)) is distinct from prefix||path
    then raise exception 'Voice maintenance prefix incorrect'; end if;
  if exists(select 1 from public.resolve_processing_output_v2(j.id,j.output_run_id,'wrong',path))
    or exists(select 1 from public.resolve_processing_output_v2(j.id,j.output_run_id,lease->>'token','video.mp4'))
    or exists(select 1 from public.resolve_processing_output_v2(j.id,gen_random_uuid(),lease->>'token',path))
    then raise exception 'Maintenance lease escaped exact voice scope'; end if;
  perform pg_temp.expect_failure(format('select private.register_teaching_voice_v1(%L,%L,%L,%L,%L,%L)',
    j.id,j.output_run_id,j.id,j.video_id,rows,manifest),'VOICE_RECEIPT_MISSING');
  perform pg_temp.expect_failure(format('select public.service_commit_voice_refresh(%L,%s,%L,%L)',
    j.id,c.revision,jsonb_set(manifest,'{items}',jsonb_build_array(manifest#>'{items,0}')),receipts),'VOICE_MANIFEST_INCOMPLETE');
  perform pg_temp.expect_failure(format('select public.service_commit_voice_refresh(%L,%s,%L,%L)',
    j.id,c.revision,jsonb_set(manifest,'{items,1,tokenId}','"t0"'),receipts),'VOICE_MANIFEST_INCOMPLETE');
  perform pg_temp.expect_failure(format('select public.service_commit_voice_refresh(%L,%s,%L,%L)',
    j.id,c.revision,jsonb_set(manifest,'{items,0,sourceTextRevision}','1'),receipts),'VOICE_SOURCE_STALE');
  perform pg_temp.expect_failure(format('select public.service_commit_voice_refresh(%L,%s,%L,%L)',
    j.id,c.revision,jsonb_set(manifest,'{items,0,contentHash}',to_jsonb(repeat('b',64))),receipts),'VOICE_RECEIPT_MISSING');
  select count(*) into backup_count from private.catalog_field_backups;
  result:=public.service_commit_voice_refresh(j.id,c.revision,manifest,receipts);
  if (result->>'revision')::bigint<>c.revision+1 or (select count(*) from private.catalog_field_backups)<>backup_count+1
    or exists(select 1 from private.voice_refresh_leases where job_id=j.id)
    then raise exception 'Voice commit revision/backup/lease mismatch'; end if;
  registered:=result->'voiceManifest';
  if registered#>>'{items,0,url}' is distinct from '/api/processing/media/'||j.id||'/'||path
    then raise exception 'Voice client URL incorrect'; end if;
  result:=public.service_resolve_playback_access_v2(actor,j.id,path);
  if result->>'objectKey' is distinct from prefix||path or result->>'canPlay'<>'true' then raise exception 'Registered voice unavailable'; end if;
  if public.service_resolve_playback_access_v2(gen_random_uuid(),j.id,path)->>'canPlay'='true'
    or public.service_resolve_playback_access_v2(actor,j.id,'voice/'||repeat('f',64)||'.mp3')->>'canPlay'='true'
    then raise exception 'Unauthorized or unregistered voice allowed'; end if;
  lease:=public.service_begin_voice_refresh(j.id,c.revision+1);
  if exists(select 1 from public.resolve_processing_output_v2(j.id,j.output_run_id,lease->>'token',path))
    then raise exception 'Registered voice allowed overwrite'; end if;
  update private.content_snapshots set published=jsonb_set(published,array['sentences',j.video_id,'0','wordLookup','tokens','0','coreMeaningZh'],'"新语境"') where environment='production';
  if public.service_resolve_playback_access_v2(actor,j.id,path)->>'canPlay'='true' then raise exception 'Stale meaning voice allowed'; end if;
  update private.content_snapshots set published=jsonb_set(published,array['sentences',j.video_id],rows) where environment='production';
  update public.processing_jobs set cancel_requested_at=now() where id=j.id;
  if public.service_resolve_playback_access_v2(actor,j.id,path)->>'canPlay'='true' then raise exception 'Cancelled voice allowed'; end if;
  update public.processing_jobs set cancel_requested_at=null where id=j.id;
  insert into private.content_video_trash(video_id,payload,deleted_by) values(j.video_id,'{}',j.requested_by);
  if public.service_resolve_playback_access_v2(actor,j.id,path)->>'canPlay'='true' then raise exception 'Trashed voice allowed'; end if;
  update private.content_video_trash set restored_at=now() where video_id=j.video_id and restored_at is null;

  -- Repair audio belongs to the repair job's source/run, not the video media run.
  insert into public.processing_jobs(video_id,source_key,input,requested_by,idempotency_key,status,stage,progress,input_revision,output_run_id)
    values(j.video_id,'videos/00000000-1111-2222-3333-444444444444/source.mp4','{"kind":"LEARNING_REPAIR"}',j.requested_by,
      'rollback-voice-'||gen_random_uuid(),'REVIEW','REVIEW',100,c.revision,gen_random_uuid()) returning * into repair;
  insert into private.processing_job_runs(job_id,run_id,worker_id,outcome) values(repair.id,repair.output_run_id,'rollback-test','REVIEW');
  insert into private.processing_output_receipts(job_id,run_id,path,size,sha256,etag)
    select repair.id,repair.output_run_id,r->>'path',(r->>'size')::bigint,r->>'sha256',r->>'etag' from jsonb_array_elements(receipts) r;
  registered:=private.register_teaching_voice_v1(repair.id,repair.output_run_id,j.id,j.video_id,rows,manifest);
  update private.content_snapshots set published=jsonb_set(published,'{videos}',(select jsonb_agg(case when v->>'id'=j.video_id then
    v||jsonb_build_object('voiceManifest',registered) else v end order by n) from jsonb_array_elements(published->'videos') with ordinality t(v,n))) where environment='production';
  result:=public.service_resolve_playback_access_v2(actor,j.id,path);
  if result->>'objectKey' is distinct from 'videos/00000000-1111-2222-3333-444444444444/processed/'||repair.id||'/runs/'||repair.output_run_id||'/'||path
    then raise exception 'Repair voice resolved wrong owner prefix'; end if;
  if has_function_privilege('authenticated','public.service_commit_voice_refresh(uuid,bigint,jsonb,jsonb)','execute')
    or has_function_privilege('anon','public.service_begin_voice_refresh(uuid,bigint)','execute')
    or has_function_privilege('service_role','private.service_resolve_playback_pre_voice_v2(uuid,uuid,text)','execute')
    or has_function_privilege('service_role','private.processing_commit_learning_repair_pre_voice_v5(uuid,uuid,text,text,jsonb)','execute')
    then raise exception 'Voice grant leaked'; end if;
  update private.content_snapshots set published=c.published,draft=c.draft,revision=c.revision,updated_at=c.updated_at where environment='production';
end $$;
