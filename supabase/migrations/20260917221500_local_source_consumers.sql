-- Local source namespaces must never turn into cloud originals in maintenance or deletion.
begin;

create or replace function private.processing_input_descriptor_v1(p_job_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_job public.processing_jobs%rowtype; v_parent public.processing_jobs%rowtype;
  v_input private.processing_local_inputs%rowtype; v_seen uuid[]:=array[]::uuid[];
begin
  select * into strict v_job from public.processing_jobs where id=p_job_id;
  loop
    if v_job.id=any(v_seen) or cardinality(v_seen)>=32 then raise exception 'SOURCE_DECLARATION_CONFLICT'; end if;
    v_seen:=array_append(v_seen,v_job.id);
    select * into v_input from private.processing_local_inputs where job_id=v_job.id;
    if found then
      return jsonb_build_object('kind','local_file','protocolVersion',1,'sourceId',v_input.source_id,
        'jobId',v_input.job_id,'workerId',v_input.worker_id,'name',v_input.source_name,
        'size',v_input.source_size,'sha256',v_input.expected_sha256,'coverSha256',v_input.cover_sha256);
    end if;
    if v_job.input->'localInputV1'='true'::jsonb then raise exception 'LOCAL_SOURCE_MISSING'; end if;
    if v_job.input->>'kind' is distinct from 'MEDIA_REENCODE' then
      -- The sidecar remains authoritative even if a malformed descendant lost its marker.
      if exists(select 1 from private.processing_local_inputs li join public.processing_jobs original on original.id=li.job_id
        where original.source_key=v_job.source_key) then raise exception 'SOURCE_DECLARATION_CONFLICT'; end if;
      return jsonb_build_object('kind','cloud_r2','key',v_job.source_key);
    end if;
    select * into v_parent from public.processing_jobs where id::text=v_job.input->>'originalJobId';
    if not found or v_parent.video_id is distinct from v_job.video_id
      or v_parent.source_key is distinct from v_job.source_key
      or v_parent.requested_by is distinct from v_job.requested_by then raise exception 'SOURCE_DECLARATION_CONFLICT'; end if;
    v_job:=v_parent;
  end loop;
end $$;
revoke all on function private.processing_input_descriptor_v1(uuid) from public,anon,authenticated;

-- Preserve the complete fenced maintenance implementation and add its authoritative input.
do $migration$
declare v_def text; v_anchor text:='''token'',v_token,''previousDraftVideo'',v_draft,''previousPublishedVideo'',v_published);';
begin
  v_def:=pg_get_functiondef('public.service_begin_balanced_reencode(uuid)'::regprocedure);
  if (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)<>1 then
    raise exception 'LOCAL_REENCODE_PATCH_TARGET_MISMATCH'; end if;
  v_def:=replace(v_def,v_anchor,'''inputSource'',private.processing_input_descriptor_v1(j.id),''token'',v_token,''previousDraftVideo'',v_draft,''previousPublishedVideo'',v_published);');
  execute v_def;
end $migration$;

-- Filter only original-object candidates. Keep every job's all-run output prefixes and
-- every existing shared-reference guard from the deployed deletion planner unchanged.
do $migration$
declare v_def text; v_anchor text:=$anchor$where target.object_key~'^videos/[0-9a-f-]{36}/source\.(mp4|mov|webm|m4v)$'$anchor$;
begin
  v_def:=pg_get_functiondef('public.admin_plan_permanent_video_delete(text,bigint)'::regprocedure);
  if (length(v_def)-length(replace(v_def,v_anchor,'')))/length(v_anchor)<>2 then
    raise exception 'LOCAL_DELETION_PATCH_TARGET_MISMATCH'; end if;
  v_def:=replace(v_def,v_anchor,v_anchor||$filter$
    and not exists(select 1 from public.processing_jobs local_job
      where local_job.source_key=target.object_key and (
        local_job.input->'localInputV1'='true'::jsonb or exists(
          select 1 from private.processing_local_inputs li where li.job_id=local_job.id)))$filter$);
  execute v_def;
end $migration$;
notify pgrst,'reload schema';
commit;
