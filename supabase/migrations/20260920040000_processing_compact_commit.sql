-- Keep one validated commit implementation and avoid materializing a catalog
-- snapshot just to discard it at the worker receipt boundary.
begin;
do $migration$
declare definition text; original text; replacement text;
begin
  definition:=pg_get_functiondef('private.commit_result_before_20260917(uuid,jsonb)'::regprocedure);
  definition:=replace(definition,E'\r\n',E'\n');
  original:='CREATE OR REPLACE FUNCTION private.commit_result_before_20260917(p_job_id uuid, p_result jsonb)';
  if position(original in definition)=0 then raise exception 'COMPACT_COMMIT_SIGNATURE_DRIFT'; end if;
  definition:=replace(definition,original,'CREATE OR REPLACE FUNCTION private.commit_processing_result_v3(p_job_id uuid, p_result jsonb, p_compact boolean)');
  original:=$old$  v_draft := jsonb_set(v_content.draft,'{videos}',private.upsert_json_array_item(v_content.draft->'videos',v_video,'id'),true);
  v_draft := jsonb_set(v_draft,array['sentences',v_job.video_id],p_result->'sentences',true);
  v_draft := jsonb_set(v_draft,'{jobs}',private.upsert_json_array_item(v_draft->'jobs',v_display,'id'),true);$old$;
  replacement:=$new$  -- Build changed top-level fields once instead of copying the full catalog three times.
  if jsonb_typeof(v_content.draft->'sentences')='object' then
  v_draft := v_content.draft || jsonb_build_object(
    'videos',private.upsert_json_array_item(v_content.draft->'videos',v_video,'id'),
    'sentences',(v_content.draft->'sentences') || jsonb_build_object(v_job.video_id,p_result->'sentences'),
    'jobs',private.upsert_json_array_item(v_content.draft->'jobs',v_display,'id'));
  else
  v_draft := jsonb_set(v_content.draft,'{videos}',private.upsert_json_array_item(v_content.draft->'videos',v_video,'id'),true);
  v_draft := jsonb_set(v_draft,array['sentences',v_job.video_id],p_result->'sentences',true);
  v_draft := jsonb_set(v_draft,'{jobs}',private.upsert_json_array_item(v_draft->'jobs',v_display,'id'),true);
  end if;$new$;
  original:=replace(original,E'\r','');
  if position(original in definition)=0 then raise exception 'COMPACT_COMMIT_DRAFT_DRIFT'; end if;
  definition:=replace(definition,original,replacement);
  original:='if jsonb_typeof(p_result->''sentences'') <> ''array''';
  if position(original in definition)=0 then raise exception 'COMPACT_COMMIT_VALIDATION_DRIFT'; end if;
  definition:=replace(definition,original,'if jsonb_typeof(p_result->''sentences'') is distinct from ''array''');
  original:='  select value into v_video from jsonb_array_elements(v_content.draft->''videos'') value';
  if position(original in definition)=0 then raise exception 'COMPACT_COMMIT_VIDEO_DRIFT'; end if;
  definition:=replace(definition,original,E'  if p_result ? ''video'' and jsonb_typeof(p_result->''video'') is distinct from ''object'' then\n    raise exception ''PROCESSING_RESULT_VIDEO_INVALID'';\n  end if;\n'||original);
  original:='  return jsonb_build_object(''status'',''REVIEW'',''snapshot'',v_draft,''revision'',v_content.revision+1);';
  if position(original in definition)=0 then raise exception 'COMPACT_COMMIT_RESULT_DRIFT'; end if;
  definition:=replace(definition,original,E'  if p_compact then\n    return jsonb_build_object(''status'',''REVIEW'',''revision'',v_content.revision+1);\n  end if;\n'||original);
  execute definition;

  definition:=pg_get_functiondef('private.processing_commit_leased_result_pre_receipt_v2(uuid,uuid,text,text,jsonb,jsonb)'::regprocedure);
  original:='return public.processing_commit_result(p_job_id,p_result);';
  if position(original in definition)=0 then raise exception 'COMPACT_COMMIT_CALL_DRIFT'; end if;
  definition:=replace(definition,original,E'perform private.assert_current_processing_job(p_job_id);\n     return private.commit_processing_result_v3(p_job_id,p_result,true);');
  -- This layer only checks existence/locks; it never consumes the snapshot body.
  original:='select * into v_content from private.content_snapshots where environment=''production'' for update;';
  if position(original in definition)=0 then raise exception 'COMPACT_COMMIT_LOCK_DRIFT'; end if;
  definition:=replace(definition,original,'perform 1 from private.content_snapshots where environment=''production'' for update;');
  execute definition;
end $migration$;

create or replace function private.commit_result_before_20260917(p_job_id uuid,p_result jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  -- Legacy/admin consumers retain their complete snapshot response.
  return private.commit_processing_result_v3(p_job_id,p_result,false);
end $$;
revoke all on function private.commit_processing_result_v3(uuid,jsonb,boolean) from public,anon,authenticated,service_role;
revoke all on function private.commit_result_before_20260917(uuid,jsonb) from public,anon,authenticated,service_role;
-- Catalog cover selection must not carry multi-megabyte voice manifests through
-- every collection/member scan. Preserve array order and missing-vs-null inputs.
create function private.processing_cover_catalog_v1(p_videos jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',v->'id','status',v->'status','deletedAt',v->'deletedAt','cover',v->'cover') ||
    case when v ? 'collectionIds' then jsonb_build_object('collectionIds',v->'collectionIds') else '{}'::jsonb end
    order by n),'[]'::jsonb)
  from jsonb_array_elements(coalesce(p_videos,'[]'::jsonb)) with ordinality a(v,n);
$$;
revoke all on function private.processing_cover_catalog_v1(jsonb) from public,anon,authenticated,service_role;

do $migration$
declare definition text; original text;
begin
  definition:=pg_get_functiondef('private.normalize_collection_covers(jsonb)'::regprocedure);
  original:='declare collection jsonb;';
  if position(original in definition)=0 then raise exception 'COVER_CATALOG_DECLARE_DRIFT'; end if;
  definition:=replace(definition,original,'declare videos jsonb; collection jsonb;');
  original:='if p_snapshot is null then return p_snapshot; end if;';
  if position(original in definition)=0 then raise exception 'COVER_CATALOG_INPUT_DRIFT'; end if;
  definition:=replace(definition,original,original||E'\n  videos:=private.processing_cover_catalog_v1(p_snapshot->''videos'');');
  original:='coalesce(p_snapshot->''videos'',''[]''::jsonb)';
  if position(original in definition)=0 then raise exception 'COVER_CATALOG_SCAN_DRIFT'; end if;
  execute replace(definition,original,'videos');
end $migration$;

create or replace function private.normalize_snapshot_covers()
returns trigger language plpgsql security definer set search_path='' as $$
declare field text; doc jsonb; previous jsonb; inputs jsonb; prior_inputs jsonb; covers jsonb;
begin
  foreach field in array array['draft','published'] loop
    doc:=case when field='draft' then new.draft else new.published end;
    previous:=case when tg_op='UPDATE' then case when field='draft' then old.draft else old.published end else null end;
    if doc is null then continue; end if;
    inputs:=jsonb_build_object('collections',coalesce(doc->'collections','[]'::jsonb),
      'videos',private.processing_cover_catalog_v1(doc->'videos'));
    prior_inputs:=jsonb_build_object('collections',coalesce(previous->'collections','[]'::jsonb),
      'videos',private.processing_cover_catalog_v1(previous->'videos'));
    if tg_op='INSERT' or inputs is distinct from prior_inputs then
      covers:=private.normalize_collection_covers(inputs)->'collections';
      -- No full-snapshot rewrite when the inferred covers are already correct.
      if covers is distinct from doc->'collections' then
        if field='draft' then new.draft:=jsonb_set(doc,'{collections}',covers);
        else new.published:=jsonb_set(doc,'{collections}',covers); end if;
      end if;
    end if;
  end loop;
  return new;
end $$;

-- Extract the comparison key once: a replacement video can itself contain
-- thousands of voice entries. Keep remove-all-duplicates then append semantics.
create or replace function private.upsert_json_array_item(p_array jsonb,p_item jsonb,p_id_key text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare item_id text:=p_item->>p_id_key; remaining jsonb;
begin
  select coalesce(jsonb_agg(value order by n),'[]'::jsonb) into remaining
  from jsonb_array_elements(coalesce(p_array,'[]'::jsonb)) with ordinality a(value,n)
  where value->>p_id_key is distinct from item_id;
  return remaining||jsonb_build_array(p_item);
end $$;

do $migration$
declare definition text; original text;
begin
  definition:=pg_get_functiondef('private.assert_current_processing_job(uuid)'::regprocedure);
  original:='select value into v from jsonb_array_elements(c.draft->''videos'') where value->>''id''=j.video_id;';
  if position(original in definition)=0 then raise exception 'COMMIT_OWNER_PROJECTION_DRIFT'; end if;
  execute replace(definition,original,'select jsonb_build_object(''processingJobId'',value->''processingJobId'',''learningRepairJobId'',value->''learningRepairJobId'') into v from jsonb_array_elements(c.draft->''videos'') where value->>''id''=j.video_id;');
end $migration$;

notify pgrst,'reload schema';
commit;
