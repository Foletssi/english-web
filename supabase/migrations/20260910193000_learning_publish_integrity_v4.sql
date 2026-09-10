-- Learning-content integrity, targeted repair jobs, and atomic per-video publication.
-- Additive only: no snapshot rows or R2 objects are deleted.

create or replace function private.learning_normalize_surface_v4(p_value text)
returns text language sql immutable set search_path = '' as $$
  select trim(regexp_replace(regexp_replace(lower(translate(coalesce(p_value,''),'’‘‐‑–—',chr(39)||chr(39)||'----')),
    '[^a-z''-]+',' ','g'),'\s+',' ','g'));
$$;

create or replace function private.learning_sentence_issues_v4(p_sentence jsonb,p_for_publish boolean default false)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_issues jsonb:='[]'::jsonb;
  v_id text:=coalesce(p_sentence->>'id','');
  v_source text:=' '||private.learning_normalize_surface_v4(p_sentence->>'english')||' ';
  v_keyword jsonb;
  v_key text;
  v_expression jsonb;
  v_count integer;
begin
  if v_id='' then v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','SENTENCE_ID_MISSING','message','句子缺少稳定编号')); end if;
  if nullif(trim(p_sentence->>'english'),'') is null then v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','ENGLISH_MISSING','sentenceId',v_id,'message','缺少英文字幕')); end if;
  if nullif(trim(p_sentence->>'chinese'),'') is null then v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','TRANSLATION_MISSING','sentenceId',v_id,'message','缺少中文翻译')); end if;
  if jsonb_typeof(p_sentence->'keyWords') is distinct from 'array' then
    return v_issues||jsonb_build_array(jsonb_build_object('code','KEYWORDS_INVALID','sentenceId',v_id,'message','重点表达格式不正确'));
  end if;
  if jsonb_typeof(p_sentence->'expressions') is distinct from 'array' then
    return v_issues||jsonb_build_array(jsonb_build_object('code','EXPRESSIONS_INVALID','sentenceId',v_id,'message','释义格式不正确'));
  end if;
  for v_keyword in select value from jsonb_array_elements(p_sentence->'keyWords') loop
    v_key:=private.learning_normalize_surface_v4(v_keyword#>>'{}');
    if v_key='' or position(' '||v_key||' ' in v_source)=0 then
      v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','KEYWORD_NOT_IN_SENTENCE','sentenceId',v_id,'message','重点表达不在原句中','surface',v_key));
      continue;
    end if;
    select count(*),(jsonb_agg(value)->0) into v_count,v_expression
    from jsonb_array_elements(p_sentence->'expressions')
    where private.learning_normalize_surface_v4(value->>'surface')=v_key;
    if v_count<>1 then
      v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','EXPRESSION_MATCH','sentenceId',v_id,'message','重点表达缺少唯一对应释义','surface',v_key));
      continue;
    end if;
    if nullif(trim(v_expression->>'coreMeaningZh'),'') is null or (v_expression->>'coreMeaningZh')~'释义待生成|尚未生成|等待生成|待补充' then
      v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','CORE_MEANING_MISSING','sentenceId',v_id,'message','缺少核心释义','surface',v_key));
    end if;
    if nullif(trim(v_expression->>'contextMeaningZh'),'') is null or (v_expression->>'contextMeaningZh')~'释义待生成|尚未生成|等待生成|待补充' then
      v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','CONTEXT_MEANING_MISSING','sentenceId',v_id,'message','缺少本句语境释义','surface',v_key));
    end if;
    if p_for_publish and coalesce(v_expression->>'reviewStatus','')<>'APPROVED' and lower(coalesce(v_expression->>'approved','false'))<>'true' then
      v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','EXPRESSION_REVIEW_REQUIRED','sentenceId',v_id,'message','重点表达释义尚未确认','surface',v_key));
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(p_sentence->'expressions') e
    where not exists(select 1 from jsonb_array_elements(p_sentence->'keyWords') k
      where private.learning_normalize_surface_v4(k#>>'{}')=private.learning_normalize_surface_v4(e->>'surface'))) then
    v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','EXPRESSION_ORPHAN','sentenceId',v_id,'message','存在没有对应重点表达的释义'));
  end if;
  if p_for_publish and coalesce(p_sentence->>'reviewStatus','')<>'APPROVED' then
    v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','SENTENCE_REVIEW_REQUIRED','sentenceId',v_id,'message','句子尚未确认'));
  end if;
  return v_issues;
end $$;

create or replace function private.video_publish_issues_v4(p_snapshot jsonb,p_video_id text)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_issues jsonb:='[]'::jsonb;
  v_video jsonb;
  v_rows jsonb;
  v_row jsonb;
  v_tag jsonb;
  v_tag_id text;
  v_approved integer:=0;
  v_evidence jsonb;
  v_allowed text[]:=array['daily-life','spoken-english','friendship','workplace','travel-scene','food-culture','study-skills','culture','conversation'];
begin
  select value into v_video from jsonb_array_elements(coalesce(p_snapshot->'videos','[]'::jsonb)) where value->>'id'=p_video_id limit 1;
  if v_video is null then return jsonb_build_array(jsonb_build_object('code','VIDEO_NOT_FOUND','message','视频不存在')); end if;
  v_rows:=coalesce(p_snapshot->'sentences'->p_video_id,'[]'::jsonb);
  if nullif(trim(v_video->>'mediaUrl'),'') is null then v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','PUBLISHED_MEDIA_MISSING','message','缺少可播放视频')); end if;
  if jsonb_typeof(v_rows)<>'array' or jsonb_array_length(v_rows)=0 then
    v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','PUBLISHED_SUBTITLES_MISSING','message','缺少学习字幕'));
  else
    for v_row in select value from jsonb_array_elements(v_rows) loop
      v_issues:=v_issues||private.learning_sentence_issues_v4(v_row,true);
    end loop;
  end if;
  if coalesce(v_video->>'pipelineStatus','READY') not in ('READY','SUCCESS') then v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','PIPELINE_NOT_READY','message','自动处理尚未完成')); end if;
  if nullif(v_video->>'creatorId','') is null or not exists(select 1 from jsonb_array_elements(coalesce(p_snapshot->'creators','[]'::jsonb)) c where c->>'id'=v_video->>'creatorId' and coalesce(c->>'status','ACTIVE')<>'DELETED') then
    v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','VIDEO_CREATOR_MISSING','message','视频缺少有效创作者关联'));
  end if;
  if jsonb_typeof(v_video->'tagAssignments')='array' then
    for v_tag in select value from jsonb_array_elements(v_video->'tagAssignments') loop
      if coalesce(v_tag->>'reviewStatus','')<>'APPROVED' and lower(coalesce(v_tag->>'approved','false'))<>'true' then continue; end if;
      v_approved:=v_approved+1;
      v_tag_id:=coalesce(v_tag->>'tagId',v_tag->>'id','');
      if not(v_tag_id=any(v_allowed)) then v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','TAG_UNKNOWN','message','标签不在受控大类中','tagId',v_tag_id)); end if;
      if nullif(trim(coalesce(v_tag->>'reasonZh',v_tag->>'reason',v_tag->>'evidence')),'') is null then v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','TAG_REASON_MISSING','message','标签缺少选择理由','tagId',v_tag_id)); end if;
      v_evidence:=v_tag->'sentenceIds';
      if jsonb_typeof(v_evidence)<>'array' or jsonb_array_length(v_evidence)=0 or exists(select 1 from jsonb_array_elements_text(v_evidence) e where not exists(select 1 from jsonb_array_elements(v_rows) s where s->>'id'=e)) then
        v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','TAG_EVIDENCE_INVALID','message','标签缺少有效字幕依据','tagId',v_tag_id));
      end if;
    end loop;
  end if;
  if v_approved=0 then v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','PUBLISHED_TAGS_MISSING','message','请确认至少一个内容标签')); end if;
  return v_issues;
end $$;

create or replace function public.admin_set_video_publication_v4(p_video_id text,p_status text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c private.content_snapshots%rowtype;
  v_video jsonb;
  v_rows jsonb;
  v_issues jsonb;
  v_draft jsonb;
  v_published jsonb;
  v_tags jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_video_id!~'^[0-9]+$' or p_status not in ('PUBLISHED','ARCHIVED') then raise exception 'VIDEO_PUBLICATION_ARGUMENT_INVALID'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if not found or c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select value into v_video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) where value->>'id'=p_video_id limit 1;
  if v_video is null then raise exception 'VIDEO_NOT_FOUND'; end if;
  if exists(select 1 from private.content_video_trash where environment='production' and video_id=p_video_id and restored_at is null) then raise exception 'VIDEO_IN_TRASH'; end if;
  v_rows:=coalesce(c.draft->'sentences'->p_video_id,'[]'::jsonb);
  if p_status='PUBLISHED' then
    v_issues:=private.video_publish_issues_v4(c.draft,p_video_id);
    if jsonb_array_length(v_issues)>0 then return jsonb_build_object('ok',false,'code','PUBLISH_BLOCKED','issues',v_issues,'revision',c.revision); end if;
    select coalesce(jsonb_agg(coalesce(value->>'tagId',value->>'id') order by ord),'[]'::jsonb) into v_tags
    from jsonb_array_elements(v_video->'tagAssignments') with ordinality tags(value,ord)
    where coalesce(value->>'reviewStatus','')='APPROVED' or lower(coalesce(value->>'approved','false'))='true';
    v_video:=v_video||jsonb_build_object('status','PUBLISHED','publishedAt',coalesce(v_video->'publishedAt',to_jsonb(now())),'tagIds',v_tags,'updatedAt',to_jsonb(now()));
    v_draft:=jsonb_set(c.draft,'{videos}',private.upsert_json_array_item(c.draft->'videos',v_video,'id'),true);
    v_published:=jsonb_set(c.published,'{videos}',private.upsert_json_array_item(c.published->'videos',v_video,'id'),true);
    v_published:=jsonb_set(v_published,array['sentences',p_video_id],v_rows,true);
  else
    v_video:=v_video||jsonb_build_object('status','ARCHIVED','updatedAt',to_jsonb(now()));
    v_draft:=jsonb_set(c.draft,'{videos}',private.upsert_json_array_item(c.draft->'videos',v_video,'id'),true);
    v_published:=jsonb_set(c.published,'{videos}',coalesce((select jsonb_agg(value order by ord) from jsonb_array_elements(coalesce(c.published->'videos','[]'::jsonb)) with ordinality rows(value,ord) where value->>'id'<>p_video_id),'[]'::jsonb),true);
    v_published:=jsonb_set(v_published,'{sentences}',coalesce(v_published->'sentences','{}'::jsonb)-p_video_id,true);
  end if;
  perform private.validate_content_snapshot(v_draft);
  perform private.validate_content_snapshot(v_published);
  perform private.assert_no_implicit_video_removal(c.draft,v_draft);
  update private.content_snapshots set draft=v_draft,published=v_published,revision=revision+1,updated_by=auth.uid(),updated_at=now(),published_at=case when p_status='PUBLISHED' then now() else published_at end where environment='production';
  return jsonb_build_object('ok',true,'videoId',p_video_id,'status',p_status,'snapshot',v_draft,'revision',c.revision+1);
end $$;

create or replace function public.admin_create_learning_repair_job_v4(p_video_id text,p_expected_revision bigint)
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
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_video_id!~'^[0-9]+$' then raise exception 'VIDEO_ID_INVALID'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if not found or c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select value into v_video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) where value->>'id'=p_video_id limit 1;
  if v_video is null then raise exception 'VIDEO_NOT_FOUND'; end if;
  if exists(select 1 from private.content_video_trash where environment='production' and video_id=p_video_id and restored_at is null) then raise exception 'VIDEO_IN_TRASH'; end if;
  select coalesce(jsonb_agg(value order by ord),'[]'::jsonb) into v_targets
  from jsonb_array_elements(coalesce(c.draft->'sentences'->p_video_id,'[]'::jsonb)) with ordinality rows(value,ord)
  where jsonb_array_length(private.learning_sentence_issues_v4(value,false))>0;
  if jsonb_array_length(v_targets)=0 then raise exception 'NO_LEARNING_REPAIR_REQUIRED'; end if;
  v_source_key:=coalesce(nullif(v_video->>'mediaKey',''),(select source_key from public.processing_jobs where video_id=p_video_id order by created_at desc limit 1));
  if v_source_key is null or v_source_key!~'^videos/[0-9a-f-]{36}/source\.(mp4|mov|webm|m4v)$' then raise exception 'LEARNING_REPAIR_SOURCE_MISSING'; end if;
  v_key:='learning-repair-v4:'||p_video_id||':'||c.revision;
  select * into v_job from public.processing_jobs where requested_by=auth.uid() and idempotency_key=v_key;
  if not found then
    insert into public.processing_jobs(video_id,source_key,input,requested_by,idempotency_key,status,stage,progress,provider,input_revision)
    values(p_video_id,v_source_key,jsonb_build_object('kind','LEARNING_REPAIR','contractVersion',4,'sentences',v_targets),auth.uid(),v_key,'QUEUED','ENRICH',70,'local-worker',c.revision)
    returning * into v_job;
  end if;
  v_display:=jsonb_build_object('id',v_job.id,'videoId',p_video_id::bigint,'type','LEARNING_REPAIR','status',v_job.status,'currentStep','enrich','progress',v_job.progress,'message','等待补齐缺失翻译与释义','steps',jsonb_build_array(jsonb_build_array('enrich','WAITING'),jsonb_build_array('review','WAITING')),'createdAt',v_job.created_at,'updatedAt',v_job.updated_at);
  v_draft:=jsonb_set(c.draft,'{jobs}',private.upsert_json_array_item(c.draft->'jobs',v_display,'id'),true);
  v_video:=v_video||jsonb_build_object('learningState','QUEUED','learningRepairJobId',v_job.id,'updatedAt',to_jsonb(now()));
  v_draft:=jsonb_set(v_draft,'{videos}',private.upsert_json_array_item(v_draft->'videos',v_video,'id'),true);
  perform private.validate_content_snapshot(v_draft);
  update private.content_snapshots set draft=v_draft,revision=revision+1,updated_by=auth.uid(),updated_at=now() where environment='production';
  return jsonb_build_object('ok',true,'snapshot',v_draft,'revision',c.revision+1,'job',to_jsonb(v_job));
end $$;

create or replace function private.merge_learning_sentence_v4(p_current jsonb,p_patch jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_keys jsonb:=case when jsonb_typeof(p_current->'keyWords')='array' and jsonb_array_length(p_current->'keyWords')>0 then p_current->'keyWords' else p_patch->'keyWords' end;
  v_expressions jsonb:='[]'::jsonb;
  v_keyword jsonb;
  v_key text;
  v_existing jsonb;
  v_generated jsonb;
  v_revision integer:=greatest(1,coalesce((p_current->>'textRevision')::integer,1));
begin
  for v_keyword in select value from jsonb_array_elements(v_keys) loop
    v_key:=private.learning_normalize_surface_v4(v_keyword#>>'{}');
    select value into v_existing from jsonb_array_elements(coalesce(p_current->'expressions','[]'::jsonb)) where private.learning_normalize_surface_v4(value->>'surface')=v_key limit 1;
    if v_existing is not null and coalesce(v_existing->>'reviewStatus','')='APPROVED' and nullif(trim(v_existing->>'coreMeaningZh'),'') is not null and nullif(trim(v_existing->>'contextMeaningZh'),'') is not null then
      v_expressions:=v_expressions||jsonb_build_array(v_existing);
    else
      select value into v_generated from jsonb_array_elements(coalesce(p_patch->'expressions','[]'::jsonb)) where private.learning_normalize_surface_v4(value->>'surface')=v_key limit 1;
      if v_generated is null then raise exception 'LEARNING_REPAIR_EXPRESSION_MISSING:%',v_key; end if;
      v_expressions:=v_expressions||jsonb_build_array(v_generated||jsonb_build_object('reviewStatus','REVIEW','source','ai','sourceTextRevision',v_revision));
    end if;
  end loop;
  return p_current||jsonb_build_object(
    'chinese',case when nullif(trim(p_current->>'chinese'),'') is null then p_patch->>'chinese' else p_current->>'chinese' end,
    'grammar',case when nullif(trim(coalesce(p_current->>'grammar',p_current->>'grammarNote')),'') is null then p_patch->>'grammar' else coalesce(p_current->>'grammar',p_current->>'grammarNote') end,
    'keyWords',v_keys,'expressions',v_expressions,'reviewStatus','REVIEW','learningState','REVIEW','learningContractVersion',4,'textRevision',v_revision
  );
end $$;

create or replace function public.processing_commit_learning_repair_v4(p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c private.content_snapshots%rowtype;
  j public.processing_jobs%rowtype;
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
  if jsonb_typeof(p_result->'sentences')<>'array' or jsonb_array_length(p_result->'sentences')<>jsonb_array_length(j.input->'sentences') then raise exception 'LEARNING_REPAIR_RESULT_INVALID'; end if;
  v_current_rows:=coalesce(c.draft->'sentences'->(j.video_id::text),'[]'::jsonb);
  for v_current in select value from jsonb_array_elements(v_current_rows) loop
    select value into v_expected from jsonb_array_elements(j.input->'sentences') where value->>'id'=v_current->>'id' limit 1;
    if v_expected is null then v_next_rows:=v_next_rows||jsonb_build_array(v_current); continue; end if;
    if v_current->>'english' is distinct from v_expected->>'english' or coalesce(v_current->'keyWords','[]'::jsonb) is distinct from coalesce(v_expected->'keyWords','[]'::jsonb) then raise exception 'LEARNING_SOURCE_CHANGED'; end if;
    select value into v_patch from jsonb_array_elements(p_result->'sentences') where value->>'id'=v_current->>'id' limit 1;
    if v_patch is null or jsonb_array_length(private.learning_sentence_issues_v4(v_patch,false))>0 then raise exception 'LEARNING_REPAIR_PATCH_INVALID'; end if;
    v_next:=private.merge_learning_sentence_v4(v_current,v_patch);
    if jsonb_array_length(private.learning_sentence_issues_v4(v_next,false))>0 then raise exception 'LEARNING_REPAIR_MERGE_INVALID'; end if;
    v_next_rows:=v_next_rows||jsonb_build_array(v_next);
  end loop;
  select value into v_video from jsonb_array_elements(c.draft->'videos') where value->>'id'=j.video_id::text limit 1;
  if v_video is null then raise exception 'VIDEO_NOT_FOUND'; end if;
  v_video:=v_video||jsonb_build_object('learningState','REVIEW','updatedAt',to_jsonb(now()));
  v_display:=jsonb_build_object('id',j.id,'videoId',j.video_id::bigint,'type','LEARNING_REPAIR','status','REVIEW','currentStep','review','progress',100,'message','释义补全完成，等待人工确认','steps',jsonb_build_array(jsonb_build_array('enrich','SUCCESS'),jsonb_build_array('review','WAITING')),'updatedAt',to_jsonb(now()));
  v_draft:=jsonb_set(c.draft,array['sentences',j.video_id::text],v_next_rows,true);
  v_draft:=jsonb_set(v_draft,'{videos}',private.upsert_json_array_item(v_draft->'videos',v_video,'id'),true);
  v_draft:=jsonb_set(v_draft,'{jobs}',private.upsert_json_array_item(v_draft->'jobs',v_display,'id'),true);
  perform private.validate_content_snapshot(v_draft);
  update private.content_snapshots set draft=v_draft,revision=revision+1,updated_at=now() where environment='production';
  update public.processing_jobs set status='REVIEW',stage='REVIEW',progress=100,result=p_result,worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,source_token_expires_at=null,lease_token=null,lease_until=null,completed_at=now(),updated_at=now() where id=p_job_id;
  update private.processing_job_runs set ended_at=now(),outcome='REVIEW' where job_id=p_job_id and run_id=p_run_id;
  insert into private.processing_job_events(job_id,run_id,kind,stage,details) values(p_job_id,p_run_id,'REVIEW','REVIEW',jsonb_build_object('kind','LEARNING_REPAIR','sentenceCount',jsonb_array_length(v_next_rows)));
  return jsonb_build_object('status','REVIEW','snapshot',v_draft,'revision',c.revision+1);
end $$;

create or replace function public.admin_retry_processing_job(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_job public.processing_jobs%rowtype;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_job from public.processing_jobs where id=p_job_id for update;
  if not found then raise exception 'JOB_NOT_FOUND'; end if;
  if v_job.status not in ('ERROR','CANCELLED') then raise exception 'JOB_NOT_RETRYABLE'; end if;
  if v_job.attempt>=20 then raise exception 'RETRY_LIMIT_REACHED'; end if;
  if exists(select 1 from private.content_video_trash where environment='production' and video_id=v_job.video_id and restored_at is null) then raise exception 'VIDEO_IN_TRASH'; end if;
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
    values(v_job.id,v_job.run_id,'RETRY',v_job.stage,jsonb_build_object('previousError',v_job.error,'jobKind',coalesce(v_job.input->>'kind','CLOUD_PIPELINE')));
  update public.processing_jobs set status='QUEUED',
    stage=case when input->>'kind'='LEARNING_REPAIR' then 'ENRICH' else 'LOCAL_DOWNLOAD' end,
    progress=case when input->>'kind'='LEARNING_REPAIR' then 70 else 0 end,
    cancel_requested_at=null,error=null,lease_token=null,lease_until=null,next_run_at=now(),
    worker_id=null,worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,
    source_token_expires_at=null,completed_at=null,run_id=null,telemetry_seq=0,
    attempt_started_at=null,stage_started_at=null,last_heartbeat_at=null,last_progress_at=null,
    metrics_reported_at=null,updated_at=now() where id=p_job_id returning * into v_job;
  return to_jsonb(v_job);
end $$;

create or replace function public.admin_list_processing_jobs(p_limit integer default 50)
returns table(job jsonb) language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query
  select jsonb_build_object(
    'id',j.id,'videoId',j.video_id,'type',coalesce(j.input->>'kind','CLOUD_PIPELINE'),
    'title',coalesce(v.video->>'title',v.video->>'titleZh',t.video->>'title',t.video->>'titleZh',j.input->>'title',j.input->>'titleZh',j.result->'video'->>'title'),
    'inputTitle',coalesce(j.input->>'title',j.input->>'titleZh'),
    'cover',coalesce(v.video->>'cover',t.video->>'cover',j.input->>'cover',j.result->'video'->>'cover'),
    'videoState',case when v.video is not null then 'ACTIVE' when t.video is not null then 'TRASHED' else 'MISSING' end,
    'canOpenVideo',v.video is not null,'canRetry',j.status='ERROR' and v.video is not null,
    'resultSentenceCount',case when jsonb_typeof(j.result->'sentences')='array' then jsonb_array_length(j.result->'sentences') else 0 end,
    'outputReceiptCount',(select count(*) from private.processing_output_receipts r where r.job_id=j.id),
    'status',j.status,'stage',j.stage,'progress',j.progress,'attempt',j.attempt,
    'provider',j.provider,'error',j.error,'runId',j.run_id,'message',j.work->>'message',
    'telemetry',j.work->'telemetry','attemptStartedAt',j.attempt_started_at,'stageStartedAt',j.stage_started_at,
    'lastHeartbeatAt',j.last_heartbeat_at,'lastProgressAt',j.last_progress_at,'metricsReportedAt',j.metrics_reported_at,
    'leaseUntil',j.lease_until,'nextRunAt',j.next_run_at,
    'automaticRecoveryCount',j.automatic_recovery_count,'maxAutomaticRecoveries',j.max_automatic_recoveries,
    'createdAt',j.created_at,'updatedAt',j.updated_at,'completedAt',j.completed_at,'serverNow',clock_timestamp()
  )
  from public.processing_jobs j
  cross join private.content_snapshots c
  left join lateral (
    select value as video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) value
    where value->>'id'=j.video_id limit 1
  ) v on true
  left join lateral (
    select coalesce(trash.payload->'draft'->'video',trash.payload->'published'->'video') as video
    from private.content_video_trash trash
    where trash.environment='production' and trash.video_id=j.video_id and trash.restored_at is null limit 1
  ) t on true
  where c.environment='production'
  order by j.created_at desc limit least(greatest(p_limit,1),100);
end $$;

revoke all on function public.admin_set_video_publication_v4(text,text,bigint) from public,anon;
revoke all on function public.admin_create_learning_repair_job_v4(text,bigint) from public,anon;
revoke all on function public.processing_commit_learning_repair_v4(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.admin_retry_processing_job(uuid) from public,anon;
revoke all on function public.admin_list_processing_jobs(integer) from public,anon;
grant execute on function public.admin_set_video_publication_v4(text,text,bigint) to authenticated;
grant execute on function public.admin_create_learning_repair_job_v4(text,bigint) to authenticated;
grant execute on function public.processing_commit_learning_repair_v4(uuid,uuid,text,text,jsonb) to service_role;
grant execute on function public.admin_retry_processing_job(uuid) to authenticated;
grant execute on function public.admin_list_processing_jobs(integer) to authenticated;

comment on function public.admin_set_video_publication_v4(text,text,bigint) is 'Atomically publishes or archives exactly one validated video.';
comment on function public.admin_create_learning_repair_job_v4(text,bigint) is 'Queues text-only repair for missing learning fields without media processing.';
