-- Run with the official linked CLI. All preference changes are rolled back.
begin;
do $$
declare
  actor uuid; current_revision bigint; returned_snapshot jsonb; result jsonb;
begin
  if has_function_privilege('anon','public.patch_learning_preferences_v1(jsonb)','EXECUTE')
    or has_function_privilege('anon','public.get_published_content_if_changed_v1(bigint)','EXECUTE') then
    raise exception 'ANONYMOUS_GRANT';
  end if;
  if not has_function_privilege('authenticated','public.patch_learning_preferences_v1(jsonb)','EXECUTE') then
    raise exception 'AUTHENTICATED_GRANT_MISSING';
  end if;
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000000',true);
  begin
    perform public.patch_learning_preferences_v1('{}');
    raise exception 'UNAUTHORIZED_WRITE';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_published_content_if_changed_v1(null);
    raise exception 'UNAUTHORIZED_READ';
  exception when insufficient_privilege then null;
  end;
  select id into actor from public.profiles
    where (private.learning_access_v2(id)->>'canEnterLearning')::boolean is true limit 1;
  if actor is null then raise exception 'NO_ELIGIBLE_VERIFICATION_ACCOUNT'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  select revision into current_revision from private.content_snapshots where environment='production';
  select snapshot into returned_snapshot from public.get_published_content_if_changed_v1(current_revision);
  if returned_snapshot is not null then raise exception 'UNCHANGED_REVISION_SENT_PAYLOAD'; end if;
  select snapshot into returned_snapshot from public.get_published_content_if_changed_v1(null);
  if returned_snapshot is null then raise exception 'INITIAL_SNAPSHOT_MISSING'; end if;
  perform public.patch_learning_preferences_v1('{"font":24,"reviewedVideos":{"test-a":"yes","test-b":"yes"}}');
  result:=public.patch_learning_preferences_v1('{"gap":0.3,"reviewedVideos":{"test-a":null}}');
  if result->'settings'->>'font'<>'24' or result->'settings'->>'gap'<>'0.3'
    or result->'settings'->'reviewedVideos' ? 'test-a'
    or result->'settings'->'reviewedVideos'->>'test-b'<>'yes' then
    raise exception 'FIELD_MERGE_FAILED';
  end if;
  begin
    perform public.patch_learning_preferences_v1('{"reviewedVideos":[]}');
    raise exception 'INVALID_PATCH_ACCEPTED';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
rollback;
select 'mobile_sync_transaction_passed_rolled_back' as result;
