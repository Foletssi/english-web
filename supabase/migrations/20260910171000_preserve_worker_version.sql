-- Job heartbeats do not carry a version argument; preserve the version announced by worker-claim.
create or replace function public.processing_worker_heartbeat(
  p_worker_id text, p_capabilities jsonb default '{}'::jsonb, p_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_worker public.processing_workers%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_worker_id is null or p_worker_id !~ '^[A-Za-z0-9._-]{3,80}$' then raise exception 'WORKER_ID_INVALID'; end if;
  if jsonb_typeof(coalesce(p_capabilities,'{}'::jsonb)) <> 'object' then raise exception 'WORKER_CAPABILITIES_INVALID'; end if;
  insert into public.processing_workers(worker_id,last_seen_at,capabilities,version,updated_at)
  values(p_worker_id,clock_timestamp(),coalesce(p_capabilities,'{}'::jsonb),left(p_version,80),clock_timestamp())
  on conflict(worker_id) do update set last_seen_at=clock_timestamp(),capabilities=excluded.capabilities,
    version=coalesce(excluded.version,public.processing_workers.version),updated_at=clock_timestamp()
  returning * into v_worker;
  return to_jsonb(v_worker);
end;
$$;

revoke all on function public.processing_worker_heartbeat(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.processing_worker_heartbeat(text,jsonb,text) to service_role;
