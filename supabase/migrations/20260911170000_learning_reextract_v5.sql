-- Teaching selection v5: professional expression schema and text-only re-extraction.
-- Additive migration. It does not reprocess media or mutate existing learning rows by itself.

create or replace function private.merge_learning_sentence_v5(p_current jsonb,p_patch jsonb,p_mode text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_revision integer:=greatest(1,coalesce((p_current->>'textRevision')::integer,1));
  v_next jsonb;
  v_expression jsonb;
  v_expressions jsonb:='[]'::jsonb;
begin
  if p_mode<>'reextract' or lower(coalesce(p_current->>'selectionLocked','false'))='true' then
    return private.merge_learning_sentence_v4(p_current,p_patch)||jsonb_build_object(
      'selectionSource',case when lower(coalesce(p_current->>'selectionLocked','false'))='true' then 'manual' else coalesce(p_current->>'selectionSource','ai') end,
      'selectionLocked',lower(coalesce(p_current->>'selectionLocked','false'))='true',
      'learningContractVersion',5
    );
  end if;
  for v_expression in select value from jsonb_array_elements(coalesce(p_patch->'expressions','[]'::jsonb)) loop
    v_expressions:=v_expressions||jsonb_build_array(v_expression||jsonb_build_object(
      'reviewStatus','REVIEW','source','ai','sourceTextRevision',v_revision
    ));
  end loop;
  v_next:=p_current||jsonb_build_object(
    'chinese',case when nullif(trim(p_current->>'chinese'),'') is null then p_patch->>'chinese' else p_current->>'chinese' end,
    'grammar',coalesce(p_patch->>'grammar',''),
    'keyWords',coalesce(p_patch->'keyWords','[]'::jsonb),
    'expressions',v_expressions,
    'reviewStatus','REVIEW','learningState','REVIEW','learningContractVersion',5,
    'selectionSource','ai','selectionLocked',false,'textRevision',v_revision
  );
  return v_next;
end $$;

create or replace function private.learning_sentence_issues_v5(p_sentence jsonb,p_for_publish boolean default false)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_issues jsonb:=private.learning_sentence_issues_v4(p_sentence,p_for_publish);
  v_expression jsonb;
  v_type text;
begin
  if jsonb_typeof(p_sentence->'expressions') is distinct from 'array' then return v_issues; end if;
  for v_expression in select value from jsonb_array_elements(p_sentence->'expressions') loop
    v_type:=coalesce(v_expression->>'expressionType','');
    if v_type not in ('word','phrasal_verb','collocation','idiom','pattern') then
      v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','EXPRESSION_TYPE_INVALID','surface',v_expression->>'surface'));
    end if;
    if nullif(trim(v_expression->>'lemma'),'') is null
       or nullif(trim(v_expression->>'selectionReasonZh'),'') is null
       or jsonb_typeof(v_expression->'needsReview') is distinct from 'boolean' then
      v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','EXPRESSION_TEACHING_FIELDS_MISSING','surface',v_expression->>'surface'));
    end if;
  end loop;
  return v_issues;
end $$;

create or replace function public.admin_create_learning_repair_job_v5(
  p_video_id text,p_expected_revision bigint,p_mode text default 'fill_missing'
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c private.content_snapshots%rowtype;
  v_video jsonb;
  v_targets jsonb;
  v_source_key text;
  v_job public.processing_jobs%rowtype;
  v_key text;
  v_display jsonb;
  v_draft jsonb;
  v_message text;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_video_id!~'^[0-9]+$' then raise exception 'VIDEO_ID_INVALID'; end if;
  if p_mode not in ('fill_missing','reextract') then raise exception 'LEARNING_REPAIR_MODE_INVALID'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if not found or c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select value into v_video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) where value->>'id'=p_video_id limit 1;
  if v_video is null then raise exception 'VIDEO_NOT_FOUND'; end if;
  if exists(select 1 from private.content_video_trash where environment='production' and video_id=p_video_id and restored_at is null) then raise exception 'VIDEO_IN_TRASH'; end if;
  select coalesce(jsonb_agg(value order by ord),'[]'::jsonb) into v_targets
  from jsonb_array_elements(coalesce(c.draft->'sentences'->p_video_id,'[]'::jsonb)) with ordinality rows(value,ord)
  where p_mode='reextract' or jsonb_array_length(private.learning_sentence_issues_v4(value,false))>0;
  if jsonb_array_length(v_targets)=0 then raise exception 'NO_LEARNING_REPAIR_REQUIRED'; end if;
  v_source_key:=coalesce(nullif(v_video->>'mediaKey',''),(select source_key from public.processing_jobs where video_id=p_video_id order by created_at desc limit 1));
  if v_source_key is null or v_source_key!~'^videos/[0-9a-f-]{36}/source\.(mp4|mov|webm|m4v)$' then raise exception 'LEARNING_REPAIR_SOURCE_MISSING'; end if;
  v_key:='learning-repair-v5:'||p_mode||':'||p_video_id||':'||c.revision;
  select * into v_job from public.processing_jobs where requested_by=auth.uid() and idempotency_key=v_key;
  if not found then
    insert into public.processing_jobs(video_id,source_key,input,requested_by,idempotency_key,status,stage,progress,provider,input_revision)
    values(p_video_id,v_source_key,jsonb_build_object('kind','LEARNING_REPAIR','mode',p_mode,'contractVersion',5,'teachingSchemaVersion',3,'sentences',v_targets),auth.uid(),v_key,'QUEUED','ENRICH',70,'local-worker',c.revision)
    returning * into v_job;
  end if;
  v_message:=case when p_mode='reextract' then '等待重新分析重点表达' else '等待补齐缺失翻译与释义' end;
  v_display:=jsonb_build_object('id',v_job.id,'videoId',p_video_id::bigint,'type','LEARNING_REPAIR','mode',p_mode,'status',v_job.status,'currentStep','enrich','progress',v_job.progress,'message',v_message,'steps',jsonb_build_array(jsonb_build_array('enrich','WAITING'),jsonb_build_array('review','WAITING')),'createdAt',v_job.created_at,'updatedAt',v_job.updated_at);
  v_draft:=jsonb_set(c.draft,'{jobs}',private.upsert_json_array_item(c.draft->'jobs',v_display,'id'),true);
  v_video:=v_video||jsonb_build_object('learningState','QUEUED','learningRepairJobId',v_job.id,'updatedAt',to_jsonb(now()));
  v_draft:=jsonb_set(v_draft,'{videos}',private.upsert_json_array_item(v_draft->'videos',v_video,'id'),true);
  perform private.validate_content_snapshot(v_draft);
  update private.content_snapshots set draft=v_draft,revision=revision+1,updated_by=auth.uid(),updated_at=now() where environment='production';
  return jsonb_build_object('ok',true,'snapshot',v_draft,'revision',c.revision+1,'job',to_jsonb(v_job));
end $$;

create or replace function public.processing_commit_learning_repair_v5(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_result jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c private.content_snapshots%rowtype;
  j public.processing_jobs%rowtype;
  v_mode text;
  v_current_rows jsonb;
  v_next_rows jsonb:='[]'::jsonb;
  v_current jsonb;
  v_expected jsonb;
  v_patch jsonb;
  v_next jsonb;
  v_video jsonb;
  v_draft jsonb;
  v_display jsonb;
begin
  select * into c from private.content_snapshots where environment='production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;
  select * into j from private.processing_lock_run(p_job_id,p_run_id,p_token,p_worker_id);
  if coalesce(j.input->>'kind','')<>'LEARNING_REPAIR' then raise exception 'LEARNING_REPAIR_JOB_REQUIRED'; end if;
  if coalesce((j.input->>'contractVersion')::integer,0)<5 or coalesce((j.input->>'teachingSchemaVersion')::integer,0)<3 then raise exception 'LEARNING_REPAIR_CONTRACT_INVALID'; end if;
  if coalesce((p_result->>'teachingSchemaVersion')::integer,0)<3 then raise exception 'LEARNING_REPAIR_RESULT_SCHEMA_INVALID'; end if;
  v_mode:=coalesce(j.input->>'mode','fill_missing');
  if v_mode not in ('fill_missing','reextract') then raise exception 'LEARNING_REPAIR_MODE_INVALID'; end if;
  if jsonb_typeof(p_result->'sentences')<>'array' or jsonb_array_length(p_result->'sentences')<>jsonb_array_length(j.input->'sentences') then raise exception 'LEARNING_REPAIR_RESULT_INVALID'; end if;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_result->'sentences'))<>jsonb_array_length(j.input->'sentences') then raise exception 'LEARNING_REPAIR_RESULT_INVALID'; end if;
  v_current_rows:=coalesce(c.draft->'sentences'->(j.video_id::text),'[]'::jsonb);
  if exists(select 1 from jsonb_array_elements(j.input->'sentences') expected where not exists(
    select 1 from jsonb_array_elements(v_current_rows) current where current->>'id'=expected->>'id'
  )) then raise exception 'LEARNING_SOURCE_CHANGED'; end if;
  for v_current in select value from jsonb_array_elements(v_current_rows) loop
    select value into v_expected from jsonb_array_elements(j.input->'sentences') where value->>'id'=v_current->>'id' limit 1;
    if v_expected is null then v_next_rows:=v_next_rows||jsonb_build_array(v_current); continue; end if;
    if v_current->>'english' is distinct from v_expected->>'english' then raise exception 'LEARNING_SOURCE_CHANGED'; end if;
    if coalesce(v_current->>'textRevision','1') is distinct from coalesce(v_expected->>'textRevision','1')
       or coalesce(v_current->>'selectionRevision','0') is distinct from coalesce(v_expected->>'selectionRevision','0')
       or coalesce(v_current->>'reviewRevision','0') is distinct from coalesce(v_expected->>'reviewRevision','0')
       or coalesce(v_current->>'reviewStatus','') is distinct from coalesce(v_expected->>'reviewStatus','')
       then raise exception 'LEARNING_SOURCE_CHANGED'; end if;
    if (v_mode='fill_missing' or lower(coalesce(v_current->>'selectionLocked','false'))='true') and coalesce(v_current->'keyWords','[]'::jsonb) is distinct from coalesce(v_expected->'keyWords','[]'::jsonb) then raise exception 'LEARNING_SOURCE_CHANGED'; end if;
    select value into v_patch from jsonb_array_elements(p_result->'sentences') where value->>'id'=v_current->>'id' limit 1;
    if v_patch is null or jsonb_array_length(private.learning_sentence_issues_v5(v_patch,false))>0 then raise exception 'LEARNING_REPAIR_PATCH_INVALID'; end if;
    v_next:=private.merge_learning_sentence_v5(v_current,v_patch,v_mode);
    if jsonb_array_length(private.learning_sentence_issues_v5(v_next,false))>0 then raise exception 'LEARNING_REPAIR_MERGE_INVALID'; end if;
    v_next_rows:=v_next_rows||jsonb_build_array(v_next);
  end loop;
  select value into v_video from jsonb_array_elements(c.draft->'videos') where value->>'id'=j.video_id::text limit 1;
  if v_video is null then raise exception 'VIDEO_NOT_FOUND'; end if;
  if exists(select 1 from private.content_video_trash where environment='production' and video_id=j.video_id::text and restored_at is null) then raise exception 'VIDEO_IN_TRASH'; end if;
  v_video:=v_video||jsonb_build_object('learningState','REVIEW','learningContractVersion',5,'updatedAt',to_jsonb(now()));
  v_display:=jsonb_build_object('id',j.id,'videoId',j.video_id::bigint,'type','LEARNING_REPAIR','mode',v_mode,'status','REVIEW','currentStep','review','progress',100,'message',case when v_mode='reextract' then '重点表达重新分析完成，等待人工确认' else '释义补全完成，等待人工确认' end,'steps',jsonb_build_array(jsonb_build_array('enrich','SUCCESS'),jsonb_build_array('review','WAITING')),'updatedAt',to_jsonb(now()));
  v_draft:=jsonb_set(c.draft,array['sentences',j.video_id::text],v_next_rows,true);
  v_draft:=jsonb_set(v_draft,'{videos}',private.upsert_json_array_item(v_draft->'videos',v_video,'id'),true);
  v_draft:=jsonb_set(v_draft,'{jobs}',private.upsert_json_array_item(v_draft->'jobs',v_display,'id'),true);
  perform private.validate_content_snapshot(v_draft);
  update private.content_snapshots set draft=v_draft,revision=revision+1,updated_at=now() where environment='production';
  update public.processing_jobs set status='REVIEW',stage='REVIEW',progress=100,result=p_result,worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,source_token_expires_at=null,lease_token=null,lease_until=null,completed_at=now(),updated_at=now() where id=p_job_id;
  update private.processing_job_runs set ended_at=now(),outcome='REVIEW' where job_id=p_job_id and run_id=p_run_id;
  insert into private.processing_job_events(job_id,run_id,kind,stage,details) values(p_job_id,p_run_id,'REVIEW','REVIEW',jsonb_build_object('kind','LEARNING_REPAIR','mode',v_mode,'sentenceCount',jsonb_array_length(v_next_rows)));
  return jsonb_build_object('status','REVIEW','snapshot',v_draft,'revision',c.revision+1);
end $$;

-- v5 claims are capability-aware.  Older workers keep their existing claim
-- endpoint but the new Edge function uses this one for every claim.
create or replace function public.processing_claim_local_job_v5(
  p_worker_id text,p_token_hash text,p_lease_seconds integer default 180
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_job public.processing_jobs%rowtype;
  v_run_id uuid:=extensions.gen_random_uuid();
  v_recovery boolean:=false;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_worker_id is null or p_worker_id!~'^[A-Za-z0-9._-]{3,80}$' then raise exception 'WORKER_ID_INVALID'; end if;
  if p_token_hash is null or p_token_hash!~'^[0-9a-f]{64}$'
    or p_lease_seconds is null or p_lease_seconds<60 or p_lease_seconds>600
    then raise exception 'PROCESSING_CLAIM_ARGUMENT_INVALID'; end if;

  with exhausted as (
    update public.processing_jobs j set status='ERROR',
      error=jsonb_build_object('code','AUTOMATIC_RECOVERY_EXHAUSTED','message','处理节点多次失联，已停止自动恢复，请人工检查后重试','retryable',true),
      completed_at=clock_timestamp(),updated_at=clock_timestamp()
    where j.status='RUNNING' and j.cancel_requested_at is null and j.lease_until<clock_timestamp()
      and j.automatic_recovery_count>=j.max_automatic_recoveries
    returning j.id,j.run_id,j.stage
  )
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
  select id,run_id,'ERROR',stage,jsonb_build_object('code','AUTOMATIC_RECOVERY_EXHAUSTED') from exhausted;

  select * into v_job from public.processing_jobs j
  where j.cancel_requested_at is null and j.status in ('QUEUED','RUNNING','WAITING')
    and j.stage in ('LOCAL_DOWNLOAD','PROBE','TRANSCODE','ASR','ENRICH','LOCAL_UPLOAD')
    and j.next_run_at<=clock_timestamp() and (j.lease_until is null or j.lease_until<clock_timestamp())
    and (coalesce(j.input->>'kind','')<>'LEARNING_REPAIR' or coalesce(j.input->>'contractVersion','4')<>'5'
      or exists(select 1 from public.processing_workers w where w.worker_id=p_worker_id
        and coalesce((w.capabilities->>'learningRepairV5')::boolean,false)
        and coalesce((w.capabilities->>'teachingSchemaVersion')::integer,0)>=3))
  order by j.next_run_at,j.created_at for update skip locked limit 1;
  if not found then return null; end if;

  v_recovery:=v_job.status='RUNNING' and v_job.run_id is not null;
  if v_recovery then
    update private.processing_job_runs set ended_at=coalesce(ended_at,clock_timestamp()),outcome=coalesce(outcome,'LEASE_LOST')
      where job_id=v_job.id and run_id=v_job.run_id;
    insert into private.processing_job_events(job_id,run_id,kind,stage,details)
      values(v_job.id,v_job.run_id,'LEASE_LOST',v_job.stage,jsonb_build_object('replacedByWorkerId',p_worker_id,'automaticRecoveryCount',v_job.automatic_recovery_count+1));
  end if;
  update public.processing_jobs set status='RUNNING',provider='local-worker',worker_id=p_worker_id,
    run_id=v_run_id,telemetry_seq=0,attempt_started_at=clock_timestamp(),stage_started_at=clock_timestamp(),
    last_heartbeat_at=clock_timestamp(),last_progress_at=clock_timestamp(),metrics_reported_at=null,
    automatic_recovery_count=automatic_recovery_count+case when v_recovery then 1 else 0 end,
    worker_token_hash=p_token_hash,worker_token_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    source_token_hash=p_token_hash,source_token_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    lease_token=extensions.gen_random_uuid(),lease_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=clock_timestamp()
  where id=v_job.id returning * into v_job;
  insert into private.processing_job_runs(job_id,run_id,worker_id) values(v_job.id,v_run_id,p_worker_id);
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
    values(v_job.id,v_run_id,'CLAIMED',v_job.stage,jsonb_build_object('attempt',v_job.attempt,'automaticRecovery',v_recovery));
  return to_jsonb(v_job);
end $$;

revoke all on function public.admin_create_learning_repair_job_v5(text,bigint,text) from public,anon;
revoke all on function public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.processing_claim_local_job_v5(text,text,integer) from public,anon,authenticated;
grant execute on function public.admin_create_learning_repair_job_v5(text,bigint,text) to authenticated;
grant execute on function public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) to service_role;
grant execute on function public.processing_claim_local_job_v5(text,text,integer) to service_role;

comment on function public.admin_create_learning_repair_job_v5(text,bigint,text) is 'Queues fill-missing or text-only teaching re-extraction without media processing.';
comment on function public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) is 'Commits v5 learning repair with manual selection locks and optimistic source checks.';
