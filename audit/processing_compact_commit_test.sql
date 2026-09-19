-- Run after 20260920040000; all checks are read-only or rolled back.
begin;
do $$
declare doc jsonb; normalized jsonb; projected jsonb; original_result jsonb; compact_result jsonb;
  next_video jsonb:='{"id":2,"status":"REVIEW"}'; next_job jsonb:='{"id":"j2","status":"REVIEW"}';
begin
  doc:='{"collections":[{"id":"a","cover":"old","coverSource":{"type":"video","videoId":"2"}},{"id":"b","cover":"custom","coverSource":{"type":"asset"}}],"videos":[{"id":1,"status":"PUBLISHED","collectionIds":["a"],"cover":"first"},{"id":2,"status":"PUBLISHED","collectionIds":["a"],"cover":"second"},{"id":3,"status":"REVIEW","cover":"unrelated"}],"sentences":{"1":[{"id":"s1"}]},"jobs":[{"id":"j1"}],"unrelated":{"keep":true}}';
  doc:=jsonb_set(doc,'{videos,1,voiceManifest}',jsonb_build_object('items',repeat('payload',10000)));
  projected:=private.processing_cover_catalog_v1(doc->'videos');
  if projected#>'{1,voiceManifest}' is not null or projected#>>'{1,cover}'<>'second'
    or (projected->2) ? 'collectionIds' then raise exception 'COVER_PROJECTION_INVALID'; end if;
  normalized:=private.normalize_collection_covers(doc);
  if normalized#>>'{collections,0,cover}'<>'second' or normalized#>>'{collections,1,cover}'<>'custom'
    or normalized-'collections' is distinct from doc-'collections' then raise exception 'COVER_CHOICE_OR_PRESERVATION_INVALID'; end if;
  doc:=jsonb_set(doc,'{videos,1,deletedAt}','"deleted"');
  normalized:=private.normalize_collection_covers(doc);
  if normalized#>>'{collections,0,cover}'<>'first' then raise exception 'COVER_FALLBACK_ORDER_INVALID'; end if;
  doc:=jsonb_set(doc,'{videos,0,status}','"REVIEW"');
  normalized:=private.normalize_collection_covers(doc);
  if normalized#>>'{collections,0,cover}'<>'assets/images/video_cover_pending.svg' then raise exception 'COVER_PENDING_INVALID'; end if;

  original_result:=jsonb_set(doc,'{videos}',private.upsert_json_array_item(doc->'videos',next_video,'id'),true);
  original_result:=jsonb_set(original_result,'{sentences,2}','[{"id":"s2"}]',true);
  original_result:=jsonb_set(original_result,'{jobs}',private.upsert_json_array_item(original_result->'jobs',next_job,'id'),true);
  compact_result:=doc||jsonb_build_object('videos',private.upsert_json_array_item(doc->'videos',next_video,'id'),
    'sentences',(doc->'sentences')||jsonb_build_object('2','[{"id":"s2"}]'::jsonb),
    'jobs',private.upsert_json_array_item(doc->'jobs',next_job,'id'));
  if original_result is distinct from compact_result then raise exception 'COMPACT_DRAFT_SEMANTICS_CHANGED'; end if;
  if private.upsert_json_array_item('[{"id":2,"old":true},{"id":1},{"id":2}]','{"id":2,"new":true}','id')
    is distinct from '[{"id":1},{"id":2,"new":true}]'::jsonb
    or private.upsert_json_array_item('[{},{"id":null},{"id":1}]','{}','id') is distinct from '[{"id":1},{}]'::jsonb
    or private.upsert_json_array_item(null,'{}','id') is distinct from '[{}]'::jsonb
    then raise exception 'UPSERT_ORDER_OR_NULL_SEMANTICS_CHANGED'; end if;
  if has_function_privilege('anon','private.commit_processing_result_v3(uuid,jsonb,boolean)','execute')
    or has_function_privilege('authenticated','private.commit_processing_result_v3(uuid,jsonb,boolean)','execute')
    or has_function_privilege('service_role','private.commit_processing_result_v3(uuid,jsonb,boolean)','execute')
    then raise exception 'PRIVATE_COMMIT_EXPOSED'; end if;
end $$;
select 'PASS cover choice, fallback order, preserved content, equivalent draft and private privileges' as result;
rollback;
