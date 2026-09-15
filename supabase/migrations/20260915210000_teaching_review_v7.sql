-- Forward-only teaching review parity; no media or content deletion.

create or replace function private.learning_normalize_surface_v4(p_value text)
returns text language sql immutable set search_path = '' as $$
  select trim(regexp_replace(regexp_replace(lower(translate(normalize(coalesce(p_value,''),NFKC),'’‘‐‑–—',chr(39)||chr(39)||'----')),
    '[^a-z''-]+',' ','g'),'\s+',' ','g'));
$$;


create or replace function private.learning_sentence_issues_v5(p_sentence jsonb,p_for_publish boolean default false)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_issues jsonb:=private.learning_sentence_issues_v4(p_sentence,p_for_publish);
  v_expression jsonb;
  v_type text;
  v_keys jsonb;
  v_key text;
  v_source text:=' '||private.learning_normalize_surface_v4(p_sentence->>'english')||' ';
  v_ranges int4range[]:=array[]::int4range[];
  v_range int4range;
  v_start integer;
begin
  if jsonb_typeof(p_sentence->'expressions') is distinct from 'array' then return v_issues; end if;
  v_keys:=case when jsonb_typeof(p_sentence->'keyWords')='array' then p_sentence->'keyWords' else '[]'::jsonb end;
  if jsonb_array_length(v_keys)>5 then
    v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','KEYWORDS_LIMIT','message','每句重点表达最多五项'));
  end if;
  if jsonb_array_length(v_keys)<>jsonb_array_length(p_sentence->'expressions') or exists (
    select 1 from jsonb_array_elements(v_keys) with ordinality k(value,ord)
    where private.learning_normalize_surface_v4(k.value#>>'{}') is distinct from
      private.learning_normalize_surface_v4(p_sentence->'expressions'->((k.ord-1)::integer)->>'surface')
  ) then
    v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','EXPRESSION_ORDER','message','释义必须与重点表达逐项同序对应'));
  end if;
  for v_expression in select value from jsonb_array_elements(v_keys) loop
    if jsonb_typeof(v_expression)<>'string' then
      v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','KEYWORDS_INVALID','message','重点表达必须是文本'));
    end if;
    v_key:=private.learning_normalize_surface_v4(v_expression#>>'{}');
    v_start:=strpos(v_source,' '||v_key||' ');
    if v_key<>'' and v_start>0 then
      v_range:=int4range(v_start,v_start+length(v_key));
      if exists(select 1 from unnest(v_ranges) r where r && v_range) then
        v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','EXPRESSION_OVERLAP','message','重点表达不能互相重叠'));
      end if;
      v_ranges:=array_append(v_ranges,v_range);
    end if;
  end loop;
  for v_expression in select value from jsonb_array_elements(p_sentence->'expressions') loop
    if jsonb_typeof(v_expression)<>'object' or exists (
      select 1 from unnest(array['surface','lemma','expressionType','coreMeaningZh','contextMeaningZh','selectionReasonZh']) f
      where jsonb_typeof(v_expression->f) is distinct from 'string'
    ) then
      v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','EXPRESSION_FIELDS_INVALID','message','词卡字段必须是文本'));
    end if;
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
  if p_for_publish and p_sentence->'segmentationNeedsReview'='true'::jsonb then
    v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','SEGMENTATION_REVIEW_REQUIRED','message','本句分句或词级对齐仍需核对'));
  end if;
  for v_expression in select value from jsonb_array_elements(p_sentence->'expressions') loop
    if length(v_expression->>'lemma')>160 or length(v_expression->>'selectionReasonZh')>300
      or length(v_expression->>'coreMeaningZh')>300 or length(v_expression->>'contextMeaningZh')>500 then
      v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','EXPRESSION_FIELDS_TOO_LONG','message','词卡内容超出长度限制','surface',v_expression->>'surface'));
    end if;
    if p_for_publish and v_expression->'needsReview'='true'::jsonb then
      v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','EXPRESSION_UNCERTAIN','message','该表达的教学含义仍待核对','surface',v_expression->>'surface'));
    end if;
    if p_for_publish and coalesce(v_expression->>'sourceTextRevision','1') is distinct from coalesce(p_sentence->>'textRevision','1') then
      v_issues:=v_issues||jsonb_build_array(jsonb_build_object('code','EXPRESSION_STALE','message','释义与当前英文版本不一致','surface',v_expression->>'surface'));
    end if;
  end loop;
  return v_issues;
end $$;

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
    when v_preserve and (jsonb_array_length(v_current_keys)>0 or p_current->'teachingAnalysis'->>'status'='completed') then v_current_keys
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
  if p_mode='reextract' then
    v_next:=v_next||jsonb_build_object('teachingSelectionBefore',jsonb_build_object('keyWords',v_current_keys));
  end if;
  return v_next;
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
      v_issues:=v_issues||private.learning_sentence_issues_v5(v_row,true);
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
