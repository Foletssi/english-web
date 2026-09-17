begin;
create table private.processing_feature_flags (
  name text primary key, enabled boolean not null default false
);
alter table private.processing_feature_flags enable row level security;
revoke all on private.processing_feature_flags from public,anon,authenticated;
insert into private.processing_feature_flags(name,enabled) values('local_input_v1',false);

create function public.admin_local_processing_capability_v1()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
  return jsonb_build_object('protocolVersion',1,'enabled',coalesce((select enabled from private.processing_feature_flags where name='local_input_v1'),false));
end $$;

-- Keep idempotent lookup/renewal available when new intake is disabled.
do $migration$
declare v_def text; v_anchor text:='if v_content.revision<>p_expected_revision then';
begin
  v_def:=pg_get_functiondef('public.admin_reserve_local_processing_job_v1(jsonb,jsonb,text,uuid,text,text,bigint)'::regprocedure);
  if strpos(v_def,v_anchor)=0 then raise exception 'LOCAL_FLAG_PATCH_TARGET_MISMATCH'; end if;
  v_def:=replace(v_def,v_anchor,$gate$if not coalesce((select enabled from private.processing_feature_flags where name='local_input_v1'),false) then raise exception 'LOCAL_INPUT_DISABLED'; end if;
    if v_content.revision<>p_expected_revision then$gate$);
  execute v_def;
end $migration$;

create function public.admin_get_local_processing_input_v1(p_job_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_input private.processing_local_inputs%rowtype;
begin
  if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_input from private.processing_local_inputs where job_id=p_job_id;
  if not found then return null; end if;
  return jsonb_build_object('state',v_input.intake_state,'inputSource',private.processing_input_descriptor_v1(p_job_id));
end $$;

create function public.processing_local_missing_v1(p_worker_id text,p_source_id uuid,p_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_input private.processing_local_inputs%rowtype; v_job public.processing_jobs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform 1 from private.content_snapshots where environment='production' for update;
  select j.* into v_job from public.processing_jobs j join private.processing_local_inputs i on i.job_id=j.id where i.source_id=p_source_id for update of j;
  if not found then raise exception 'LOCAL_INPUT_CANCELLED'; end if;
  select * into strict v_input from private.processing_local_inputs where source_id=p_source_id for update;
  if v_input.worker_id is distinct from p_worker_id or v_input.expected_sha256 is distinct from p_sha256 then raise exception 'SOURCE_DECLARATION_CONFLICT'; end if;
  if v_job.cancel_requested_at is not null or v_job.status='CANCELLED' or v_input.intake_state='CANCELLED'
    or exists(select 1 from private.content_video_trash where environment='production' and video_id=v_job.video_id and restored_at is null)
    then raise exception 'LOCAL_INPUT_CANCELLED'; end if;
  -- Finished video output remains valid even if its original is removed later.
  if v_job.status='REVIEW' then return jsonb_build_object('state','REVIEW','jobId',v_job.id); end if;
  perform private.assert_current_processing_job(v_job.id);
  update private.processing_job_runs set ended_at=now(),outcome='LEASE_LOST',
    error=jsonb_build_object('code','LOCAL_SOURCE_MISSING')
    where job_id=v_job.id and run_id=v_job.run_id and ended_at is null;
  update private.processing_local_inputs set intake_state='MISSING',updated_at=now() where job_id=v_job.id;
  update public.processing_jobs set status='WAITING',stage='LOCAL_DOWNLOAD',run_id=null,
    worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,source_token_expires_at=null,
    lease_token=null,lease_until=null,updated_at=now(),
    error=jsonb_build_object('code','LOCAL_SOURCE_MISSING','message','本机原视频不可用，请重新选择同一个原文件继续处理。'),
    work=jsonb_set(coalesce(work,'{}'::jsonb),'{telemetry}',coalesce(work->'telemetry','{}'::jsonb)||jsonb_build_object('substage','local_missing','sourceKind','local_file')) where id=v_job.id;
  return jsonb_build_object('state','MISSING','jobId',v_job.id);
end $$;

create function public.admin_recover_local_processing_input_v1(p_job_id uuid,p_source jsonb,p_worker_id text,p_challenge uuid,p_origin text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_input private.processing_local_inputs%rowtype; v_job public.processing_jobs%rowtype;
  v_ticket text:=encode(extensions.gen_random_bytes(32),'hex');
begin
  if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
  perform 1 from private.content_snapshots where environment='production' for update;
  select * into v_job from public.processing_jobs where id=p_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  perform private.assert_current_processing_job(p_job_id);
  select * into v_input from private.processing_local_inputs where job_id=p_job_id for update;
  if not found then raise exception 'LOCAL_INPUT_NOT_FOUND'; end if;
  if v_input.worker_id is distinct from p_worker_id then raise exception 'LOCAL_WORKER_MISMATCH'; end if;
  if v_input.expected_sha256 is distinct from p_source->>'sha256'
    or v_input.source_size::text is distinct from p_source->>'size'
    or v_input.cover_sha256 is distinct from p_source->>'coverSha256' then raise exception 'SOURCE_DECLARATION_CONFLICT'; end if;
  if v_input.origin is distinct from p_origin or not exists(select 1 from private.processing_local_challenges c join public.processing_workers w on w.worker_id=c.worker_id
    where c.challenge=p_challenge and c.worker_id=p_worker_id and c.origin=p_origin and c.expires_at>now()
      and w.last_seen_at>now()-interval '90 seconds' and w.capabilities->'localInputV1'='true'::jsonb)
    then raise exception 'LOCAL_CHALLENGE_EXPIRED'; end if;
  if v_job.cancel_requested_at is not null or v_job.status='CANCELLED' or v_input.intake_state='CANCELLED'
    or exists(select 1 from private.content_video_trash where environment='production' and video_id=v_job.video_id and restored_at is null)
    then raise exception 'LOCAL_INPUT_CANCELLED'; end if;
  if v_job.status='REVIEW' then raise exception 'JOB_ALREADY_COMPLETE'; end if;
  -- Do not interrupt an active healthy task. Renewal remains safe after READY.
  if v_input.intake_state='MISSING' then
    update public.processing_jobs set status='WAITING',stage='LOCAL_DOWNLOAD',run_id=null,error=null,
      worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,source_token_expires_at=null,
      lease_token=null,lease_until=null,updated_at=now(),
      work=jsonb_set(coalesce(work,'{}'::jsonb),'{telemetry}',coalesce(work->'telemetry','{}'::jsonb)||jsonb_build_object('substage','local_receive','current',0,'total',v_input.source_size,'unit','bytes'))
      where id=p_job_id returning * into v_job;
    update private.processing_local_inputs set intake_state='RECEIVING' where job_id=p_job_id;
  end if;
  update private.processing_local_inputs set ticket_hash=encode(extensions.digest(v_ticket,'sha256'),'hex'),
    ticket_expires_at=now()+interval '20 minutes',updated_at=now() where job_id=p_job_id;
  return jsonb_build_object('job',to_jsonb(v_job),'inputSource',private.processing_input_descriptor_v1(p_job_id),'intakeTicket',v_ticket,'expiresIn',1200);
end $$;

revoke all on function public.processing_local_missing_v1(text,uuid,text) from public,anon,authenticated;
grant execute on function public.processing_local_missing_v1(text,uuid,text) to service_role;
revoke all on function public.admin_local_processing_capability_v1(),public.admin_get_local_processing_input_v1(uuid),
  public.admin_recover_local_processing_input_v1(uuid,jsonb,text,uuid,text) from public,anon;
grant execute on function public.admin_local_processing_capability_v1(),public.admin_get_local_processing_input_v1(uuid),
  public.admin_recover_local_processing_input_v1(uuid,jsonb,text,uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
