-- Local originals are durable inputs, not R2 objects. Existing jobs stay cloud-backed.
begin;
create table private.processing_local_challenges (
  challenge uuid primary key, worker_id text not null, origin text not null,
  expires_at timestamptz not null
);
create table private.processing_local_inputs (
  job_id uuid primary key references public.processing_jobs(id) on delete cascade,
  protocol_version integer not null default 1 check(protocol_version=1),
  source_id uuid unique not null default extensions.gen_random_uuid(),
  worker_id text not null check(worker_id ~ '^[A-Za-z0-9._-]{3,80}$'),
  intake_state text not null default 'RECEIVING' check(intake_state in ('RECEIVING','READY','MISSING','CANCELLED')),
  source_name text not null check(length(source_name) between 1 and 255),
  source_size bigint not null check(source_size between 1 and 2147483648),
  expected_sha256 text not null check(expected_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text, cover_sha256 text check(cover_sha256 ~ '^[0-9a-f]{64}$'),
  reservation jsonb not null, origin text not null,
  ticket_hash text not null, ticket_expires_at timestamptz not null,
  ready_at timestamptz, updated_at timestamptz not null default now(),
  check(intake_state <> 'READY' or (source_sha256 is not null and source_sha256=expected_sha256 and ready_at is not null))
);
alter table private.processing_local_challenges enable row level security;
alter table private.processing_local_inputs enable row level security;
revoke all on private.processing_local_challenges,private.processing_local_inputs from public,anon,authenticated;

create function public.processing_local_challenge_v1(p_worker_id text,p_challenge uuid,p_origin text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_origin not in ('https://english-web-lce.pages.dev','http://localhost:8080','http://127.0.0.1:8080')
    or p_origin is null then raise exception 'ORIGIN_INVALID'; end if;
  if not exists(select 1 from public.processing_workers w where w.worker_id=p_worker_id
    and w.last_seen_at>now()-interval '90 seconds' and w.capabilities->'localInputV1'='true'::jsonb)
    then raise exception 'LOCAL_WORKER_NOT_READY'; end if;
  delete from private.processing_local_challenges where expires_at<now();
  insert into private.processing_local_challenges values(p_challenge,p_worker_id,p_origin,now()+interval '5 minutes');
  return jsonb_build_object('challenge',p_challenge,'expiresIn',300);
end $$;

create function private.processing_input_descriptor_v1(p_job_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_input private.processing_local_inputs%rowtype; v_key text;
begin
  select * into v_input from private.processing_local_inputs where job_id=p_job_id;
  if found then
    return jsonb_build_object('kind','local_file','protocolVersion',1,'sourceId',v_input.source_id,
      'jobId',v_input.job_id,'workerId',v_input.worker_id,'name',v_input.source_name,
      'size',v_input.source_size,'sha256',v_input.expected_sha256,'coverSha256',v_input.cover_sha256);
  end if;
  select source_key into strict v_key from public.processing_jobs where id=p_job_id;
  return jsonb_build_object('kind','cloud_r2','key',v_key);
end $$;

create function public.admin_reserve_local_processing_job_v1(p_video jsonb,p_source jsonb,
  p_worker_id text,p_challenge uuid,p_origin text,p_request_id text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_content private.content_snapshots%rowtype; v_job public.processing_jobs%rowtype;
  v_local private.processing_local_inputs%rowtype; v_result jsonb; v_video jsonb; v_id text;
  v_key text; v_ticket text:=encode(extensions.gen_random_bytes(32),'hex'); v_binding jsonb;
begin
  if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
  if p_request_id is null or length(p_request_id) not between 1 and 128 then raise exception 'IDEMPOTENCY_KEY_INVALID'; end if;
  if p_source->>'sha256' is null or (p_source->>'sha256')!~'^[a-f0-9]{64}$'
    or jsonb_typeof(p_source->'size') is distinct from 'number'
    or (p_source->>'size')!~'^[0-9]+$' or (p_source->>'size')::bigint not between 1 and 2147483648
    or length(coalesce(p_source->>'name','')) not between 1 and 255
    or (p_source->>'coverSha256' is not null and (p_source->>'coverSha256')!~'^[a-f0-9]{64}$')
    then raise exception 'SOURCE_DECLARATION_INVALID'; end if;
  if not exists(select 1 from private.processing_local_challenges c join public.processing_workers w on w.worker_id=c.worker_id
    where c.challenge=p_challenge and c.worker_id=p_worker_id and c.origin=p_origin and c.expires_at>now()
      and w.last_seen_at>now()-interval '90 seconds' and w.capabilities->'localInputV1'='true'::jsonb)
    then raise exception 'LOCAL_CHALLENGE_EXPIRED'; end if;
  v_binding:=jsonb_build_object('video',p_video,'source',p_source,'workerId',p_worker_id,'origin',p_origin);
  select * into strict v_content from private.content_snapshots where environment='production' for update;
  select * into v_job from public.processing_jobs where requested_by=auth.uid() and idempotency_key=p_request_id for update;
  if found then
    select * into v_local from private.processing_local_inputs where job_id=v_job.id for update;
    if not found or v_local.reservation<>v_binding then raise exception 'LOCAL_RESERVATION_CONFLICT'; end if;
    if v_job.cancel_requested_at is not null or v_local.intake_state='CANCELLED' then raise exception 'LOCAL_INPUT_CANCELLED'; end if;
    if exists(select 1 from private.content_video_trash where environment='production' and video_id=v_job.video_id and restored_at is null)
      then raise exception 'VIDEO_IN_TRASH'; end if;
  else
    if v_content.revision<>p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
    v_id:=nullif(p_video->>'id','');
    if v_id is null then
      loop
        v_id:=(floor(extract(epoch from clock_timestamp())*1000)::bigint*100+floor(random()*100)::bigint)::text;
        exit when not exists(select 1 from jsonb_array_elements(v_content.draft->'videos') x where x->>'id'=v_id);
      end loop;
    elsif not exists(select 1 from jsonb_array_elements(v_content.draft->'videos') x where x->>'id'=v_id) then
      raise exception 'VIDEO_NOT_FOUND';
    end if;
    if exists(select 1 from public.processing_jobs j where j.video_id=v_id and j.status in ('QUEUED','WAITING','RUNNING') and j.cancel_requested_at is null)
      then raise exception 'VIDEO_PROCESSING_ACTIVE'; end if;
    v_key:='videos/'||extensions.gen_random_uuid()::text||'/source.mp4';
    v_video:=p_video||jsonb_build_object('id',v_id::bigint);
    v_result:=public.admin_create_processing_job(v_video,v_key,p_request_id,p_expected_revision);
    select * into strict v_job from public.processing_jobs where id=(v_result->'job'->>'id')::uuid for update;
    insert into private.processing_local_inputs(job_id,worker_id,source_name,source_size,expected_sha256,
      cover_sha256,reservation,origin,ticket_hash,ticket_expires_at)
    values(v_job.id,p_worker_id,p_source->>'name',(p_source->>'size')::bigint,p_source->>'sha256',
      p_source->>'coverSha256',v_binding,p_origin,encode(extensions.digest(v_ticket,'sha256'),'hex'),now()+interval '20 minutes') returning * into v_local;
    update public.processing_jobs set status='WAITING',stage='LOCAL_DOWNLOAD',provider='local-worker',
      input=input||jsonb_build_object('localInputV1',true,'teachingVoiceRequired',true),
      metrics=jsonb_build_object('substage','local_receive','sourceKind','local_file','current',0,'total',v_local.source_size,'unit','bytes')
      where id=v_job.id returning * into v_job;
    select * into strict v_content from private.content_snapshots where environment='production';
    select x into v_video from jsonb_array_elements(v_content.draft->'videos') x where x->>'id'=v_id;
    v_video:=(v_video-'mediaUrl'-'playback'-'coverImages'-'voiceManifest')||jsonb_build_object('mediaUrl','','pipelineStatus','WAITING');
    v_content.draft:=jsonb_set(v_content.draft,'{videos}',private.upsert_json_array_item(v_content.draft->'videos',v_video,'id'));
    update private.content_snapshots set draft=v_content.draft where environment='production';
  end if;
  update private.processing_local_inputs set ticket_hash=encode(extensions.digest(v_ticket,'sha256'),'hex'),
    ticket_expires_at=now()+interval '20 minutes',updated_at=now() where job_id=v_job.id;
  return jsonb_build_object('snapshot',v_content.draft,'revision',v_content.revision,'job',to_jsonb(v_job),
    'inputSource',private.processing_input_descriptor_v1(v_job.id),'intakeTicket',v_ticket,'expiresIn',1200);
end $$;

create function public.processing_local_ticket_v1(p_worker_id text,p_ticket text,p_origin text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_local private.processing_local_inputs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select i.* into v_local from private.processing_local_inputs i join public.processing_jobs j on j.id=i.job_id
    where i.worker_id=p_worker_id and i.ticket_hash=encode(extensions.digest(p_ticket,'sha256'),'hex')
      and i.origin=p_origin and i.ticket_expires_at>now() and i.intake_state<>'CANCELLED'
      and j.cancel_requested_at is null and j.status <> 'CANCELLED'
      and not exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null);
  if not found then raise exception 'INTAKE_TICKET_INVALID'; end if;
  return jsonb_build_object('source',private.processing_input_descriptor_v1(v_local.job_id),'expiresAt',v_local.ticket_expires_at);
end $$;

create function public.processing_local_ready_v1(p_worker_id text,p_source_id uuid,p_sha256 text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_local private.processing_local_inputs%rowtype; v_job public.processing_jobs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform 1 from private.content_snapshots where environment='production' for update;
  select j.* into v_job from public.processing_jobs j join private.processing_local_inputs i on i.job_id=j.id where i.source_id=p_source_id for update of j;
  if not found then raise exception 'LOCAL_INPUT_CANCELLED'; end if;
  select * into strict v_local from private.processing_local_inputs where source_id=p_source_id for update;
  if v_local.worker_id is distinct from p_worker_id or v_local.expected_sha256 is distinct from p_sha256 then raise exception 'SOURCE_DECLARATION_CONFLICT'; end if;
  if v_job.cancel_requested_at is not null or v_job.status='CANCELLED' or v_local.intake_state='CANCELLED'
    or exists(select 1 from private.content_video_trash where environment='production' and video_id=v_job.video_id and restored_at is null)
    then raise exception 'LOCAL_INPUT_CANCELLED'; end if;
  update private.processing_local_inputs set intake_state='READY',source_sha256=p_sha256,ready_at=coalesce(ready_at,now()),updated_at=now() where job_id=v_job.id;
  if v_job.status='WAITING' and v_job.run_id is null then
    update public.processing_jobs set status='QUEUED',next_run_at=now(),updated_at=now(),
      metrics=metrics||jsonb_build_object('substage','local_ready','current',v_local.source_size) where id=v_job.id;
  end if;
  return jsonb_build_object('state','READY');
end $$;

-- Clone the existing fenced run-claim implementation, changing only input eligibility.
-- Assert anchors so an unexpected deployed definition aborts this entire migration.
do $migration$
declare v_def text; v_local text; v_signature text; v_anchor text; v_filter text;
begin
  v_def:=pg_get_functiondef('private.processing_claim_local_job_pre_voice_v5(text,text,integer)'::regprocedure);
  v_local:=replace(v_def,'private.processing_claim_local_job_pre_voice_v5(', 'private.processing_claim_local_input_v1(');
  v_anchor:='where j.cancel_requested_at is null and j.status in';
  if strpos(v_local,v_anchor)=0 then raise exception 'LOCAL_CLAIM_PATCH_TARGET_MISMATCH'; end if;
  v_filter:=$filter$where exists(select 1 from private.processing_local_inputs li where li.job_id=j.id and li.worker_id=p_worker_id and li.intake_state='READY') and j.cancel_requested_at is null and j.status in$filter$;
  v_local:=replace(v_local,v_anchor,v_filter);
  v_local:=replace(v_local,'where j.status=''RUNNING''','where exists(select 1 from private.processing_local_inputs li where li.job_id=j.id and li.worker_id=p_worker_id and li.intake_state=''READY'') and j.status=''RUNNING''');
  execute v_local;
  foreach v_signature in array array['private.processing_claim_local_job_pre_voice_v5(text,text,integer)',
    'public.processing_claim_local_job(text,text,integer)','public.processing_claim_jobs(integer,integer)'] loop
    v_def:=pg_get_functiondef(v_signature::regprocedure);
    v_anchor:='where j.cancel_requested_at is null';
    if strpos(v_def,v_anchor)=0 then raise exception 'LEGACY_CLAIM_PATCH_TARGET_MISMATCH %',v_signature; end if;
    v_def:=replace(v_def,v_anchor,'where not exists(select 1 from private.processing_local_inputs li where li.job_id=j.id) and j.cancel_requested_at is null');
    v_def:=replace(v_def,'where j.status=''RUNNING''','where not exists(select 1 from private.processing_local_inputs li where li.job_id=j.id) and j.status=''RUNNING''');
    execute v_def;
  end loop;
end $migration$;

create function public.processing_claim_local_input_v1(p_worker_id text,p_token_hash text,p_lease_seconds integer default 240)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not exists(select 1 from public.processing_workers w where w.worker_id=p_worker_id and w.last_seen_at>now()-interval '90 seconds'
    and w.capabilities->'localInputV1'='true'::jsonb and w.capabilities->'teachingVoiceV1'='true'::jsonb) then return null; end if;
  v_job:=private.processing_claim_local_input_v1(p_worker_id,p_token_hash,p_lease_seconds);
  if v_job is null then return null; end if;
  return v_job||jsonb_build_object('inputSource',private.processing_input_descriptor_v1((v_job->>'id')::uuid));
end $$;

-- No signed cloud-source URL can resolve an absent local original.
create or replace function public.resolve_processing_source(p_job_id uuid,p_token text)
returns table(source_key text) language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.processing_jobs j where j.id=p_job_id and j.status in ('QUEUED','RUNNING','WAITING')
    and j.cancel_requested_at is null and j.source_token_expires_at>now()
    and encode(extensions.digest(p_token,'sha256'),'hex')=j.source_token_hash) then return; end if;
  if (private.processing_input_descriptor_v1(p_job_id)->>'kind')='local_file' then raise exception 'SOURCE_LOCAL_ONLY'; end if;
  return query select j.source_key from public.processing_jobs j where j.id=p_job_id;
end $$;

revoke all on function private.processing_input_descriptor_v1(uuid),private.processing_claim_local_input_v1(text,text,integer) from public,anon,authenticated;
revoke all on function public.processing_local_challenge_v1(text,uuid,text),public.processing_local_ticket_v1(text,text,text),
  public.processing_local_ready_v1(text,uuid,text),public.processing_claim_local_input_v1(text,text,integer) from public,anon,authenticated;
grant execute on function public.processing_local_challenge_v1(text,uuid,text),public.processing_local_ticket_v1(text,text,text),
  public.processing_local_ready_v1(text,uuid,text),public.processing_claim_local_input_v1(text,text,integer) to service_role;
revoke all on function public.admin_reserve_local_processing_job_v1(jsonb,jsonb,text,uuid,text,text,bigint) from public,anon;
grant execute on function public.admin_reserve_local_processing_job_v1(jsonb,jsonb,text,uuid,text,text,bigint) to authenticated;
notify pgrst,'reload schema';
commit;
