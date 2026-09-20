-- Authorize and fence one bounded output batch without per-file RPC round trips.
begin;

create function public.resolve_processing_outputs_v3(
  p_job_id uuid,p_run_id uuid,p_token text,p_paths jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare path text; object_key text; outputs jsonb:='[]'::jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if jsonb_typeof(p_paths) is distinct from 'array' or jsonb_array_length(p_paths) not between 1 and 32
    or (select count(distinct value) from jsonb_array_elements_text(p_paths))<>jsonb_array_length(p_paths)
  then raise exception 'OUTPUT_PATHS_INVALID'; end if;
  for path in select value from jsonb_array_elements_text(p_paths) loop
    select r.object_key into object_key from public.resolve_processing_output_v2(
      p_job_id,p_run_id,p_token,path) r;
    if object_key is null then raise exception 'OUTPUT_NOT_ALLOWED'; end if;
    outputs:=outputs||jsonb_build_array(jsonb_build_object('path',path,'object_key',object_key));
  end loop;
  return jsonb_build_object('outputs',outputs);
end $$;

create function public.begin_processing_output_writes_v3(
  p_job_id uuid,p_run_id uuid,p_token text,p_items jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item jsonb; object_key text; receipt private.processing_output_writes%rowtype; writes jsonb:='[]'::jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 32
    or (select count(distinct value->>'path') from jsonb_array_elements(p_items))<>jsonb_array_length(p_items)
    or (select count(distinct value->>'uploadId') from jsonb_array_elements(p_items))<>jsonb_array_length(p_items)
  then raise exception 'OUTPUT_WRITES_INVALID'; end if;
  perform 1 from private.content_snapshots where environment='production' for update;
  perform 1 from public.processing_jobs where id=p_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  if exists(select 1 from private.video_deletion_jobs where confirmed_at is not null and p_job_id=any(job_ids))
    then raise exception 'VIDEO_PERMANENT_DELETION_STARTED'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if coalesce(length(item->>'uploadId'),0) not between 1 and 2048 then raise exception 'OUTPUT_WRITE_INVALID'; end if;
    select r.object_key into object_key from public.resolve_processing_output_v2(
      p_job_id,p_run_id,p_token,item->>'path') r;
    if object_key is null then raise exception 'OUTPUT_NOT_ALLOWED'; end if;
    insert into private.processing_output_writes(job_id,object_key,upload_id)
      values(p_job_id,object_key,item->>'uploadId') on conflict(upload_id) do nothing;
    select * into receipt from private.processing_output_writes where upload_id=item->>'uploadId';
    if receipt.id is null or receipt.job_id<>p_job_id or receipt.object_key<>object_key
      then raise exception 'OUTPUT_WRITE_CONFLICT'; end if;
    writes:=writes||jsonb_build_array(jsonb_build_object('path',item->>'path',
      'object_key',object_key,'write_id',receipt.id));
  end loop;
  return jsonb_build_object('writes',writes);
end $$;

create function public.finish_processing_output_writes_v3(p_write_ids jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare removed integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if jsonb_typeof(p_write_ids) is distinct from 'array' or jsonb_array_length(p_write_ids) not between 1 and 32
    or exists(select 1 from jsonb_array_elements_text(p_write_ids) value
      where value!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  then raise exception 'OUTPUT_WRITE_IDS_INVALID'; end if;
  delete from private.processing_output_writes where id in (
    select value::uuid from jsonb_array_elements_text(p_write_ids));
  get diagnostics removed=row_count;
  return jsonb_build_object('ok',true,'removed',removed);
end $$;

revoke all on function public.resolve_processing_outputs_v3(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.begin_processing_output_writes_v3(uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.finish_processing_output_writes_v3(jsonb) from public,anon,authenticated;
grant execute on function public.resolve_processing_outputs_v3(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.begin_processing_output_writes_v3(uuid,uuid,text,jsonb) to service_role;
grant execute on function public.finish_processing_output_writes_v3(jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
