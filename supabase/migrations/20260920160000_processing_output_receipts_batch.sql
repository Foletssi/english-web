-- Register one validated upload batch with one run lock and one transaction.
begin;

create function public.processing_record_outputs_v3(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_receipts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_job public.processing_jobs%rowtype; item jsonb; saved jsonb:='[]'::jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if jsonb_typeof(p_receipts) is distinct from 'array' or jsonb_array_length(p_receipts) not between 1 and 32
    or (select count(distinct value->>'path') from jsonb_array_elements(p_receipts))<>jsonb_array_length(p_receipts)
  then raise exception 'OUTPUT_RECEIPTS_INVALID'; end if;
  select * into v_job from private.processing_lock_run(p_job_id,p_run_id,p_token,p_worker_id);
  for item in select value from jsonb_array_elements(p_receipts) loop
    if jsonb_typeof(item) is distinct from 'object'
      or coalesce(item->>'path','')!~'^(voice/[0-9a-f]{64}\.mp3|master\.m3u8|cover\.webp|cover-(320|640|960)\.webp|[0-9]{3,4}p/(index\.m3u8|segment_[0-9]{5}\.ts))$'
      or coalesce(item->>'size','')!~'^[1-9][0-9]{0,7}$'
      or (item->>'size')::bigint>15728640
      or ((item->>'path') like 'voice/%' and (item->>'size')::bigint>1048576)
      or coalesce(item->>'sha256','')!~'^[0-9a-f]{64}$'
      or coalesce(length(item->>'etag'),0) not between 1 and 200
    then raise exception 'OUTPUT_RECEIPT_INVALID'; end if;
    insert into private.processing_output_receipts(job_id,run_id,path,size,sha256,etag)
    values(p_job_id,p_run_id,item->>'path',(item->>'size')::bigint,item->>'sha256',item->>'etag')
    on conflict(job_id,run_id,path) do update set size=excluded.size,sha256=excluded.sha256,
      etag=excluded.etag,confirmed_at=now()
    where private.processing_output_receipts.sha256=excluded.sha256
      and private.processing_output_receipts.size=excluded.size;
    if not found then raise exception 'OUTPUT_RECEIPT_CONFLICT'; end if;
    saved:=saved||jsonb_build_array(jsonb_build_object('path',item->>'path','size',(item->>'size')::bigint,
      'sha256',item->>'sha256'));
  end loop;
  return jsonb_build_object('ok',true,'receipts',saved);
end;
$$;

revoke all on function public.processing_record_outputs_v3(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.processing_record_outputs_v3(uuid,uuid,text,text,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
