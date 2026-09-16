-- Executed inside a rollback transaction, before or after migration installation.
create function pg_temp.expect_failure(sql_text text, expected text)
returns void language plpgsql as $$
begin
  begin execute sql_text;
  exception when others then
    if position(expected in sqlerrm)>0 then return; end if;
    raise;
  end;
  raise exception 'Expected failure did not occur: %',expected;
end $$;

do $$
declare c private.content_snapshots%rowtype; after_doc private.content_snapshots%rowtype;
  j public.processing_jobs%rowtype; lease jsonb; manifest jsonb; d jsonb; result jsonb; actor uuid;
begin
  select * into c from private.content_snapshots where environment='production';
  select * into j from public.processing_jobs where id=(select (v->>'processingJobId')::uuid
    from jsonb_array_elements(c.published->'videos') v where v->>'id'='1788926081632');
  if j.id is null then raise exception 'Verification video missing'; end if;
  if has_function_privilege('anon','public.service_begin_cover_refresh(uuid,bigint)','EXECUTE')
    or has_function_privilege('authenticated','public.service_commit_cover_refresh(uuid,bigint,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.service_commit_video_difficulty(text,uuid,bigint,jsonb)','EXECUTE')
    then raise exception 'Maintenance grant leaked'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform pg_temp.expect_failure(format('select public.service_begin_cover_refresh(%L,%s)',j.id,c.revision),'SERVICE_ROLE_REQUIRED');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform pg_temp.expect_failure(format('select public.service_begin_cover_refresh(%L,%s)',j.id,c.revision-1),'CONTENT_REVISION_CONFLICT');
  lease:=public.service_begin_cover_refresh(j.id,c.revision);
  if not exists(select 1 from public.resolve_processing_output_v2(j.id,j.output_run_id,lease->>'token','cover-320.webp'))
    then raise exception 'Valid scoped upload refused'; end if;
  if exists(select 1 from public.resolve_processing_output_v2(j.id,j.output_run_id,lease->>'token','540p/segment_00000.ts'))
    or exists(select 1 from public.resolve_processing_output_v2(j.id,j.output_run_id,'invalid','cover-320.webp'))
    then raise exception 'Upload lease escaped scope'; end if;
  perform pg_temp.expect_failure(format('select public.service_commit_cover_refresh(%L,%s,null)',j.id,c.revision),'COVER_MANIFEST_INVALID');
  manifest:=(select jsonb_agg(jsonb_build_object('path','cover-'||w||'.webp','width',w,'height',180,
    'bytes',100,'size',100,'etag','rollback-only','sha256',repeat('0',64))) from unnest(array[320,640,960]) w);
  perform pg_temp.expect_failure(format('select private.verified_cover_images(%L,%L,%L::jsonb)',j.id,j.output_run_id,manifest),'COVER_IMAGE_UNVERIFIED');
  result:=public.service_commit_cover_refresh(j.id,c.revision,manifest);
  select * into after_doc from private.content_snapshots where environment='production';
  if after_doc.revision<>c.revision+1 or after_doc.draft->'sentences'<>c.draft->'sentences'
    or after_doc.published->'sentences'<>c.published->'sentences' then raise exception 'Cover changed teaching'; end if;
  if exists(select 1 from jsonb_array_elements(after_doc.published->'videos') a
    join jsonb_array_elements(c.published->'videos') b on a->>'id'=b->>'id'
    where a-'coverImages'<>b-'coverImages') then raise exception 'Cover changed other video fields'; end if;
  if exists(select 1 from public.resolve_processing_output_v2(j.id,j.output_run_id,lease->>'token','cover-320.webp'))
    then raise exception 'Consumed lease remained usable'; end if;
  d:=jsonb_build_object('schemaVersion',1,'source','ai','reviewStatus','approved','primaryTrack','cet6','targetTracks',jsonb_build_array('cet6'),
    'evidence',jsonb_build_array(jsonb_build_object('sentenceIds',jsonb_build_array(c.published#>>array['sentences',j.video_id,'0','id']),'reasonZh','Rollback verification')));
  perform pg_temp.expect_failure(format('select public.service_commit_video_difficulty(%L,%L,%s,%L::jsonb)',j.video_id,j.id,c.revision,d),'CONTENT_REVISION_CONFLICT');
  perform pg_temp.expect_failure(format('select private.validate_video_difficulty(%L::jsonb,%L::jsonb)',jsonb_set(d,'{evidence,0,reasonZh}','null'),c.published->'sentences'->j.video_id),'DIFFICULTY_EVIDENCE_INVALID');
  perform pg_temp.expect_failure(format('select private.validate_video_difficulty(%L::jsonb,%L::jsonb)',jsonb_set(d,'{evidence,0,sentenceIds}','["nonexistent"]'),c.published->'sentences'->j.video_id),'DIFFICULTY_SENTENCE_MISSING');
  perform pg_temp.expect_failure(format('select private.validate_video_difficulty(%L::jsonb,%L::jsonb)',jsonb_set(d,'{targetTracks}','["cet6",null]'),c.published->'sentences'->j.video_id),'DIFFICULTY_TRACK_INVALID');
  result:=public.service_commit_video_difficulty(j.video_id,j.id,after_doc.revision,d);
  select * into after_doc from private.content_snapshots where environment='production';
  if after_doc.draft->'sentences'<>c.draft->'sentences' or after_doc.published->'sentences'<>c.published->'sentences'
    then raise exception 'Difficulty published teaching draft'; end if;
  if exists(select 1 from jsonb_array_elements(after_doc.published->'videos') a
    join jsonb_array_elements(c.published->'videos') b on a->>'id'=b->>'id'
    where a-'coverImages'-'difficulty'<>b-'coverImages'-'difficulty') then raise exception 'Difficulty changed other fields'; end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true);
  if exists(select 1 from public.resolve_processing_media(j.id,'cover-320.webp')) then raise exception 'VIP check bypassed'; end if;
  select id into actor from public.profiles where (private.learning_access_v2(id)->>'canPlay')::boolean is true limit 1;
  if actor is null then raise exception 'Eligible verification account missing'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  if not exists(select 1 from public.resolve_processing_media(j.id,'cover-320.webp')) then raise exception 'VIP cover unavailable'; end if;
  update public.processing_jobs set cancel_requested_at=now() where id=j.id;
  perform pg_temp.expect_failure(format('select public.service_begin_cover_refresh(%L,%s)',j.id,after_doc.revision),'CURRENT_PUBLISHED_VIDEO_REQUIRED');
end $$;
