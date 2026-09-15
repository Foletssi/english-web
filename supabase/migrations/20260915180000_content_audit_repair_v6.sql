-- Forward-only content checks and text-only repair. No media or published snapshot mutation.
create or replace function private.learning_analysis_complete_v1(p_sentence jsonb)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_sentence->'teachingAnalysis'->>'status'='completed'
    and nullif(trim(p_sentence->'teachingAnalysis'->>'promptVersion'),'') is not null
    and p_sentence->'teachingAnalysis'->>'sourceTextRevision'=greatest(1,coalesce((p_sentence->>'textRevision')::integer,1))::text,false);
$$;

create or replace function private.merge_learning_sentence_v5(p_current jsonb,p_patch jsonb,p_mode text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare
  v_revision integer:=greatest(1,coalesce((p_current->>'textRevision')::integer,1));
  v_locked boolean:=coalesce(p_current->>'selectionLocked','false')='true';
  v_preserve boolean:=p_mode<>'reextract' or v_locked;
  v_keys jsonb;
  v_expressions jsonb:='[]'::jsonb;
  v_keyword jsonb; v_key text; v_existing jsonb; v_generated jsonb; v_expression jsonb; v_field text;
  v_next jsonb;
  v_current_keys jsonb:=case when jsonb_typeof(p_current->'keyWords')='array' then p_current->'keyWords' else '[]'::jsonb end;
begin
  v_keys:=case when v_locked then v_current_keys
    when v_preserve and jsonb_array_length(v_current_keys)>0 then v_current_keys
    else coalesce(p_patch->'keyWords','[]'::jsonb) end;
  for v_keyword in select value from jsonb_array_elements(v_keys) loop
    v_key:=private.learning_normalize_surface_v4(v_keyword#>>'{}');
    select value into v_existing from jsonb_array_elements(case when jsonb_typeof(p_current->'expressions')='array' then p_current->'expressions' else '[]'::jsonb end)
      where private.learning_normalize_surface_v4(value->>'surface')=v_key limit 1;
    select value into v_generated from jsonb_array_elements(coalesce(p_patch->'expressions','[]'::jsonb))
      where private.learning_normalize_surface_v4(value->>'surface')=v_key limit 1;
    if v_generated is null then raise exception 'LEARNING_REPAIR_EXPRESSION_MISSING:%',v_key; end if;
    v_expression:=v_generated;
    if v_preserve and v_existing is not null then
      -- Preserve each valid human field while repairing missing v5 fields.
      foreach v_field in array array['coreMeaningZh','contextMeaningZh','usageNoteZh','lemma','selectionReasonZh'] loop
        if nullif(trim(v_existing->>v_field),'') is not null
          and length(trim(v_existing->>v_field))<=(case v_field when 'coreMeaningZh' then 300 when 'contextMeaningZh' then 500 when 'lemma' then 160 when 'selectionReasonZh' then 300 else 2000 end)
          and (v_existing->>v_field)!~'释义待生成|尚未生成|等待生成|待补充' then
          v_expression:=jsonb_set(v_expression,array[v_field],v_existing->v_field,true);
        end if;
      end loop;
      if v_existing->>'expressionType' in ('word','phrasal_verb','collocation','idiom','pattern') then
        v_expression:=jsonb_set(v_expression,'{expressionType}',v_existing->'expressionType');
      end if;
      -- Uncertainty must not be lost, even on a previously approved expression.
      v_expression:=v_expression||jsonb_build_object('needsReview',
        coalesce(v_generated->'needsReview'='true'::jsonb,false) or coalesce(v_existing->'needsReview'='true'::jsonb,false));
      v_expression:=v_existing||v_expression;
    end if;
    v_expressions:=v_expressions||jsonb_build_array(v_expression||jsonb_build_object(
      'surface',v_keyword,'reviewStatus','REVIEW','approved',false,
      'source',case when v_preserve and v_existing->>'source'='manual' then 'manual' else 'ai' end,
      'sourceTextRevision',v_revision));
  end loop;
  v_next:=p_current||jsonb_build_object(
    'chinese',case when nullif(trim(p_current->>'chinese'),'') is null then p_patch->>'chinese' else p_current->>'chinese' end,
    'grammar',case when v_preserve and nullif(trim(coalesce(p_current->>'grammar',p_current->>'grammarNote')),'') is not null
      then coalesce(p_current->>'grammar',p_current->>'grammarNote') else coalesce(p_patch->>'grammar','') end,
    'keyWords',v_keys,'expressions',v_expressions,'reviewStatus','REVIEW','learningState','REVIEW',
    'learningContractVersion',5,'selectionLocked',v_locked,
    'selectionSource',case when v_locked then 'manual' when not v_preserve then 'ai' else coalesce(p_current->>'selectionSource','ai') end,'textRevision',v_revision);
  if p_patch ? 'teachingAnalysis' then
    v_next:=v_next||jsonb_build_object('teachingAnalysis',p_patch->'teachingAnalysis');
  else
    v_next:=v_next - 'teachingAnalysis';
  end if;
  return v_next;
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
  if p_video_id is null or p_video_id!~'^[0-9]+$' then raise exception 'VIDEO_ID_INVALID'; end if;
  if p_mode is null or p_mode not in ('fill_missing','reextract') then raise exception 'LEARNING_REPAIR_MODE_INVALID'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;
  select value into v_video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) where value->>'id'=p_video_id limit 1;
  if v_video is null then raise exception 'VIDEO_NOT_FOUND'; end if;
  if exists(select 1 from private.content_video_trash where environment='production' and video_id=p_video_id and restored_at is null) then raise exception 'VIDEO_IN_TRASH'; end if;
  -- The snapshot lock serializes administrators before looking up active work.
  select * into v_job from public.processing_jobs
    where video_id=p_video_id and status in ('QUEUED','RUNNING','WAITING')
    order by created_at desc,id limit 1 for update;
  if found then
    if v_job.input->>'kind'='LEARNING_REPAIR' and coalesce(v_job.input->>'mode','fill_missing')=p_mode then
      return jsonb_build_object('ok',true,'reused',true,'snapshot',c.draft,'revision',c.revision,'job',to_jsonb(v_job));
    end if;
    raise exception 'VIDEO_PROCESSING_ACTIVE';
  end if;
  if c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select coalesce(jsonb_agg(value order by ord),'[]'::jsonb) into v_targets
  from jsonb_array_elements(coalesce(c.draft->'sentences'->p_video_id,'[]'::jsonb)) with ordinality rows(value,ord)
  where p_mode='reextract' or jsonb_array_length(private.learning_sentence_issues_v5(value,false))>0
    or (not private.learning_analysis_complete_v1(value) and (
      value->'teachingAnalysis' is not null
      or case when jsonb_typeof(value->'keyWords')='array' then jsonb_array_length(value->'keyWords')=0 else true end
      or nullif(trim(coalesce(value->>'grammar',value->>'grammarNote')),'') is null));
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
  if jsonb_typeof(p_result->'sentences') is distinct from 'array' or jsonb_array_length(p_result->'sentences')<>jsonb_array_length(j.input->'sentences') then raise exception 'LEARNING_REPAIR_RESULT_INVALID'; end if;
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
    if (v_current - array['updatedAt','learningState']) is distinct from (v_expected - array['updatedAt','learningState'])
      then raise exception 'LEARNING_SOURCE_CHANGED'; end if;
    if (v_mode='fill_missing' or lower(coalesce(v_current->>'selectionLocked','false'))='true') and coalesce(v_current->'keyWords','[]'::jsonb) is distinct from coalesce(v_expected->'keyWords','[]'::jsonb) then raise exception 'LEARNING_SOURCE_CHANGED'; end if;
    select value into v_patch from jsonb_array_elements(p_result->'sentences') where value->>'id'=v_current->>'id' limit 1;
    if v_patch is null or jsonb_array_length(private.learning_sentence_issues_v5(v_patch,false))>0 then raise exception 'LEARNING_REPAIR_PATCH_INVALID'; end if;
    if v_patch ? 'teachingAnalysis' and (
      not private.learning_analysis_complete_v1(v_patch || jsonb_build_object('textRevision',coalesce(v_current->'textRevision','1'::jsonb))))
      then raise exception 'LEARNING_ANALYSIS_INVALID'; end if;
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

create or replace function public.admin_list_processing_video_groups_v1(p_page integer default 1,p_page_size integer default 50)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_page integer:=greatest(coalesce(p_page,1),1); v_size integer:=least(greatest(coalesce(p_page_size,50),1),100); v_total bigint; v_items jsonb; v_summary jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;

  with eligible as (
    select j.video_id,j.updated_at,j.status,j.id
    from public.processing_jobs j
    cross join private.content_snapshots c
    join lateral (
      select value video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) value
      where value->>'id'=j.video_id limit 1
    ) v on true
    where c.environment='production'
      and not exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
  ), representative as (
    select distinct on(video_id) video_id,status
    from eligible order by video_id,(status in ('RUNNING','QUEUED','WAITING')) desc,
      (status<>'CANCELLED') desc,updated_at desc,id
  ) select count(*),jsonb_build_object(
    'active',count(*) filter(where status in ('RUNNING','QUEUED','WAITING')),
    'failed',count(*) filter(where status='ERROR'),'review',count(*) filter(where status='REVIEW'),
    'completed',count(*) filter(where status not in ('RUNNING','QUEUED','WAITING','ERROR','REVIEW','CANCELLED')),
    'cancelled',count(*) filter(where status='CANCELLED'),'total',count(*))
  into v_total,v_summary from representative;

  with eligible as (
    select j.video_id,j.updated_at,v.video
    from public.processing_jobs j
    cross join private.content_snapshots c
    join lateral (
      select value video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) value
      where value->>'id'=j.video_id limit 1
    ) v on true
    where c.environment='production'
      and not exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
  ), latest as (
    select distinct on (video_id) video_id,video,updated_at newest
    from eligible order by video_id,updated_at desc
  ), page_videos as (
    select * from latest order by newest desc,video_id
    offset (v_page-1)*v_size limit v_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'videoId',p.video_id,'video',p.video,'recordCount',(select count(*) from public.processing_jobs c where c.video_id=p.video_id),
    'records',coalesce((select jsonb_agg(private.processing_job_admin_summary_v1(j,p.video) order by j.updated_at desc,j.id)
      from (select x.* from public.processing_jobs x where x.video_id=p.video_id order by (x.status in ('RUNNING','QUEUED','WAITING')) desc,(x.status<>'CANCELLED') desc,x.updated_at desc,x.id limit 5) j),'[]'::jsonb)
  ) order by p.newest desc,p.video_id),'[]'::jsonb) into v_items from page_videos p;

  return jsonb_build_object('items',v_items,'summary',v_summary,'total',v_total,'page',v_page,'pageSize',v_size,'serverNow',clock_timestamp());
end;
$$;


revoke all on function private.learning_analysis_complete_v1(jsonb) from public,anon,authenticated;
revoke all on function private.merge_learning_sentence_v5(jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.admin_create_learning_repair_job_v5(text,bigint,text) from public,anon;
revoke all on function public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.admin_list_processing_video_groups_v1(integer,integer) from public,anon;
grant execute on function public.admin_create_learning_repair_job_v5(text,bigint,text) to authenticated;
grant execute on function public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) to service_role;
grant execute on function public.admin_list_processing_video_groups_v1(integer,integer) to authenticated;
