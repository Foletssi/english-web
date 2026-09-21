-- Make AI difficulty evidence authoritative for processing results, repair the
-- current draft catalog placeholders, and resume the known transient timeout
-- without creating another job or discarding checkpoints.
begin;
set local lock_timeout='2s';

create or replace function private.processing_finalize_ai_result_v1(p_result jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb:=p_result; video jsonb; difficulty jsonb; fallback_title text;
begin
  if jsonb_typeof(result) is distinct from 'object' or jsonb_typeof(result->'video') is distinct from 'object'
    then return result; end if;
  video:=result->'video';
  fallback_title:=nullif(trim(video->>'title'),'');
  if coalesce(trim(video->>'titleZh'),'') in ('','待生成','AI 正在生成') and fallback_title is not null then
    video:=jsonb_set(video,'{titleZh}',to_jsonb(fallback_title),true);
  end if;
  difficulty:=video->'difficulty';
  if jsonb_typeof(difficulty)='object' and nullif(difficulty->>'primaryTrack','') is not null then
    difficulty:=difficulty||jsonb_build_object(
      'source','ai','reviewStatus','approved','reviewedAt',to_jsonb(clock_timestamp()),
      'reviewBasis','ai-evidence');
    video:=jsonb_set(video,'{difficulty}',difficulty,true);
  end if;
  return jsonb_set(result,'{video}',video,true);
end $$;
revoke all on function private.processing_finalize_ai_result_v1(jsonb) from public,anon,authenticated,service_role;

do $migration$
declare definition text; original text;
begin
  definition:=pg_get_functiondef('private.processing_commit_leased_result_pre_receipt_v2(uuid,uuid,text,text,jsonb,jsonb)'::regprocedure);
  original:='return private.commit_processing_result_v3(p_job_id,p_result,true);';
  if position(original in definition)=0 then raise exception 'AI_FINALIZE_COMMIT_DRIFT'; end if;
  execute replace(definition,original,
    'return private.commit_processing_result_v3(p_job_id,private.processing_finalize_ai_result_v1(p_result),true);');

  definition:=pg_get_functiondef('private.commit_result_before_20260917(uuid,jsonb)'::regprocedure);
  original:='return private.commit_processing_result_v3(p_job_id,p_result,false);';
  if position(original in definition)=0 then raise exception 'AI_FINALIZE_LEGACY_DRIFT'; end if;
  execute replace(definition,original,
    'return private.commit_processing_result_v3(p_job_id,private.processing_finalize_ai_result_v1(p_result),false);');
end $migration$;

create or replace function private.processing_finalize_existing_video_v1(p_video jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb:=p_video; difficulty jsonb; fallback_title text;
begin
  if nullif(result->>'processingJobId','') is null then return result; end if;
  fallback_title:=nullif(trim(result->>'title'),'');
  if coalesce(trim(result->>'titleZh'),'') in ('','待生成','AI 正在生成') and fallback_title is not null then
    result:=jsonb_set(result,'{titleZh}',to_jsonb(fallback_title),true);
  end if;
  difficulty:=result->'difficulty';
  if jsonb_typeof(difficulty)='object' and difficulty->>'source'='ai'
    and difficulty->>'reviewStatus'='review' and nullif(difficulty->>'primaryTrack','') is not null then
    result:=jsonb_set(result,'{difficulty}',difficulty||jsonb_build_object(
      'reviewStatus','approved','reviewedAt',to_jsonb(clock_timestamp()),'reviewBasis','ai-evidence'),true);
  end if;
  return result;
end $$;
revoke all on function private.processing_finalize_existing_video_v1(jsonb) from public,anon,authenticated,service_role;

do $backfill$
declare c private.content_snapshots%rowtype; repaired jsonb;
begin
  select * into c from private.content_snapshots where environment='production' for update;
  select coalesce(jsonb_agg(private.processing_finalize_existing_video_v1(v) order by n),'[]'::jsonb)
    into repaired from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) with ordinality t(v,n);
  if repaired is distinct from c.draft->'videos' then
    c.draft:=jsonb_set(c.draft,'{videos}',repaired,true);
    perform private.validate_content_snapshot(c.draft);
    update private.content_snapshots set draft=c.draft,revision=revision+1,updated_at=clock_timestamp()
      where environment='production';
  end if;
end $backfill$;

do $resume$
declare jid uuid:='dd0164a4-132f-49a7-962a-7c98b4b323b7'; previous public.processing_jobs%rowtype; current_job public.processing_jobs%rowtype;
begin
  select * into previous from public.processing_jobs where id=jid for update;
  if found and previous.status='ERROR' and coalesce(previous.error->>'code','')='DB_STATEMENT_TIMEOUT' then
    perform private.assert_current_processing_job(jid);
    if previous.attempt>=20 then raise exception 'RETRY_LIMIT_REACHED'; end if;
    insert into private.processing_job_events(job_id,run_id,kind,stage,details)
      values(jid,previous.run_id,'RETRY',previous.stage,
        jsonb_build_object('previousError',previous.error,'source','migration-transient-recovery'));
    update public.processing_jobs set status='QUEUED',automatic_recovery_count=0,attempt=attempt+1,
      stage=previous.stage,progress=least(99,greatest(0,previous.progress)),
      cancel_requested_at=null,error=null,lease_token=null,lease_until=null,next_run_at=clock_timestamp(),
      worker_id=null,worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,
      source_token_expires_at=null,completed_at=null,run_id=null,telemetry_seq=0,
      attempt_started_at=null,stage_started_at=null,last_heartbeat_at=null,last_progress_at=null,
      metrics_reported_at=null,updated_at=clock_timestamp(),
      work=(coalesce(work,'{}'::jsonb)-'telemetry')||jsonb_build_object(
        'message','数据库瞬时超时已恢复；正在校验原任务断点并复用有效成品',
        'resumePosition',jsonb_build_object('verified',false,'phase','validating','stage',previous.stage,
          'progress',previous.progress,'runId',previous.run_id))
      where id=jid returning * into current_job;
    perform private.sync_processing_retry_snapshot_v1(current_job);
  end if;
end $resume$;

notify pgrst,'reload schema';
commit;
