-- Forward-only correction: processing_jobs.result must not shadow RPC locals.
begin;

create or replace function public.processing_claim_local_job_v5(p_worker_id text,p_token_hash text,p_lease_seconds integer default 180)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_claim jsonb; v_updated_input jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not exists(select 1 from public.processing_workers w where w.worker_id=p_worker_id
    and w.capabilities->'teachingVoiceV1'='true'::jsonb and w.last_seen_at>clock_timestamp()-interval '90 seconds')
    then return null; end if;
  v_claim:=private.processing_claim_local_job_pre_voice_v5(p_worker_id,p_token_hash,p_lease_seconds);
  if v_claim is null then return null; end if;
  update public.processing_jobs as j set input=j.input||jsonb_build_object('teachingVoiceRequired',true)
    where j.id=(v_claim->>'id')::uuid returning j.input into v_updated_input;
  return jsonb_set(v_claim,'{input}',v_updated_input);
end $$;

create or replace function public.admin_create_learning_repair_job_v5(p_video_id text,p_expected_revision bigint,p_mode text default 'fill_missing')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_response jsonb; v_job public.processing_jobs%rowtype; v_all_rows jsonb;
begin
  v_response:=private.admin_create_learning_repair_job_base_v5(p_video_id,p_expected_revision,p_mode);
  select j.* into v_job from public.processing_jobs j where j.id=(v_response->'job'->>'id')::uuid for update;
  if v_job.status='QUEUED' and v_job.run_id is null then
    select c.draft->'sentences'->p_video_id into v_all_rows from private.content_snapshots c where c.environment='production';
    update public.processing_jobs as j set input=j.input||jsonb_build_object(
      'sentences',v_all_rows,'coverageScope','full-video','teachingDetailsVersion',1,
      'targetSentenceIds',coalesce(j.input->'targetSentenceIds',(select jsonb_agg(r->'id') from jsonb_array_elements(j.input->'sentences') r)))
      where j.id=v_job.id returning j.* into v_job;
    v_response:=jsonb_set(v_response,'{job}',to_jsonb(v_job));
  end if;
  return v_response;
end $$;

revoke all on function public.processing_claim_local_job_v5(text,text,integer) from public,anon,authenticated;
grant execute on function public.processing_claim_local_job_v5(text,text,integer) to service_role;
revoke all on function public.admin_create_learning_repair_job_v5(text,bigint,text) from public,anon;
grant execute on function public.admin_create_learning_repair_job_v5(text,bigint,text) to authenticated;
commit;
