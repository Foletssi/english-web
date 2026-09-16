begin;
do $$
declare actor uuid; current_revision bigint; source jsonb; catalog jsonb; vid text; detail record; projected jsonb;
begin
  if has_function_privilege('anon','public.get_published_catalog_if_changed_v2(bigint)','EXECUTE')
    or has_function_privilege('anon','public.get_published_video_teaching_v1(text,bigint)','EXECUTE')
    or has_function_privilege('authenticated','private.learner_catalog_projection_v2(jsonb)','EXECUTE') then
    raise exception 'LAZY_TEACHING_UNEXPECTED_GRANT';
  end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true);
  begin
    perform public.get_published_catalog_if_changed_v2(null);
    raise exception 'LAZY_CATALOG_UNAUTHORIZED_READ';
  exception when insufficient_privilege then null; end;
  begin
    perform public.get_published_video_teaching_v1('test',null);
    raise exception 'LAZY_DETAIL_UNAUTHORIZED_READ';
  exception when insufficient_privilege then null; end;
  projected:=private.learner_catalog_projection_v2('{"videos":[{"id":"v","voiceManifest":{"items":[]}}],"sentences":{"v":[{"id":"s","english":"hello","wordLookup":{"tokens":[]}}]}}');
  if projected#>'{videos,0,voiceManifest}' is not null or projected#>'{sentences,v,0,wordLookup}' is not null
    or projected#>>'{sentences,v,0,english}' <> 'hello' then raise exception 'LAZY_CATALOG_PROJECTION_FAILED'; end if;
  select id into actor from public.profiles where (private.learning_access_v2(id)->>'canEnterLearning')::boolean is true limit 1;
  if actor is null then raise exception 'NO_ELIGIBLE_VERIFICATION_ACCOUNT'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  select c.revision,c.published into current_revision,source from private.content_snapshots c where c.environment='production';
  select snapshot into catalog from public.get_published_catalog_if_changed_v2(current_revision);
  if catalog is not null then raise exception 'LAZY_UNCHANGED_CATALOG_PAYLOAD'; end if;
  select snapshot into catalog from public.get_published_catalog_if_changed_v2(null);
  if catalog is distinct from private.learner_catalog_projection_v2(source) then raise exception 'LAZY_WRONG_CATALOG'; end if;
  select value->>'id' into vid from jsonb_array_elements(source->'videos') where value->>'status'='PUBLISHED' limit 1;
  if vid is null then raise exception 'NO_PUBLISHED_VERIFICATION_VIDEO'; end if;
  select * into detail from public.get_published_video_teaching_v1(vid,null);
  if detail.video->>'id' is distinct from vid or detail.sentences is distinct from source->'sentences'->vid
    or detail.revision is distinct from current_revision then raise exception 'LAZY_WRONG_DETAIL'; end if;
  select * into detail from public.get_published_video_teaching_v1(vid,current_revision);
  if detail.video is not null or detail.sentences is not null then raise exception 'LAZY_UNCHANGED_DETAIL_PAYLOAD'; end if;
  begin
    perform public.get_published_video_teaching_v1('__missing_lazy_test__',current_revision);
    raise exception 'LAZY_MISSING_VIDEO_ACCEPTED';
  exception when invalid_parameter_value then null; end;
end;
$$;
rollback;
select 'lazy_teaching_transaction_passed_rolled_back' as result;
