-- Forward-only: independently reviewed translations, token identities and coverage.
begin;

create function private.learning_utf16_length_v1(p_text text)
returns integer language sql immutable set search_path='' as $$
  select coalesce(sum(case when ascii(c)>65535 then 2 else 1 end),0)::integer
  from regexp_split_to_table(p_text,'') c where c<>'';
$$;

create function private.learning_detail_text_v1(p_value jsonb,p_limit integer)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p_value)='string' and length(trim(p_value#>>'{}'))>0
    and private.learning_utf16_length_v1(p_value#>>'{}')<=p_limit
    and (p_value#>>'{}')!~'释义待生成|尚未生成|等待生成|待补充',false);
$$;

create function private.learning_details_valid_v1(p_row jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare
  lookup jsonb:=p_row->'wordLookup'; translation jsonb:=p_row->'translationAnalysis';
  coverage jsonb:=p_row->'coverageAnalysis'; rev jsonb:=coalesce(p_row->'textRevision','1'::jsonb);
  source text:=p_row->>'english'; token jsonb; surface text; token_index integer:=0;
  cursor_pos integer:=1; char_start integer; utf_start integer; item jsonb;
begin
  if not (p_row ?| array['wordLookup','translationAnalysis','coverageAnalysis']) then return true; end if;
  if not (p_row ?& array['chinese','wordLookup','translationAnalysis','coverageAnalysis'])
    or jsonb_typeof(rev) is distinct from 'number' or (rev#>>'{}')!~'^[1-9][0-9]*$'
    or jsonb_typeof(p_row->'english') is distinct from 'string'
    or not private.learning_detail_text_v1(p_row->'chinese',1000) then return false; end if;
  if jsonb_typeof(lookup) is distinct from 'object' or lookup->'schemaVersion' is distinct from '1'::jsonb
    or lookup->'sourceTextRevision' is distinct from rev or lookup->'sourceEnglish' is distinct from p_row->'english'
    or jsonb_typeof(lookup->'tokens') is distinct from 'array' then return false; end if;
  for surface in select matches[1] from regexp_matches(source,$re$[A-Za-z]+(?:['’‘‐‑–—-][A-Za-z]+)*$re$,'g') matches loop
    char_start:=cursor_pos+strpos(substring(source from cursor_pos),surface)-1;
    utf_start:=private.learning_utf16_length_v1(substring(source from 1 for char_start-1));
    token:=lookup->'tokens'->token_index;
    if jsonb_typeof(token) is distinct from 'object'
      or token->'tokenId' is distinct from to_jsonb('t'||token_index)
      or token->'surface' is distinct from to_jsonb(surface)
      or token->'start' is distinct from to_jsonb(utf_start)
      or token->'end' is distinct from to_jsonb(utf_start+private.learning_utf16_length_v1(surface))
      or not private.learning_detail_text_v1(token->'coreMeaningZh',160)
      or jsonb_typeof(token->'pronunciationHint') is distinct from 'string'
      or private.learning_utf16_length_v1(token->>'pronunciationHint')>160 then return false; end if;
    cursor_pos:=char_start+length(surface); token_index:=token_index+1;
  end loop;
  if jsonb_array_length(lookup->'tokens')<>token_index then return false; end if;
  if jsonb_typeof(translation) is distinct from 'object'
    or translation->>'status' is distinct from 'completed'
    or translation->>'promptVersion' is distinct from 'context-lookup-v1-20260916'
    or translation->>'reviewVersion' is distinct from 'context-lookup-review-v1-20260916'
    or translation->'sourceTextRevision' is distinct from rev
    or jsonb_typeof(translation->'sourceConcerns') is distinct from 'array' then return false; end if;
  if jsonb_array_length(translation->'sourceConcerns')>5 then return false; end if;
  for item in select value from jsonb_array_elements(translation->'sourceConcerns') loop
    if not private.learning_detail_text_v1(item,300) then return false; end if;
  end loop;
  if jsonb_typeof(coverage) is distinct from 'object' or coverage->'schemaVersion' is distinct from '1'::jsonb
    or coverage->>'status' is distinct from 'completed'
    or coverage->>'promptVersion' is distinct from 'adjacent-coverage-v1-20260916'
    or coverage->>'reviewVersion' is distinct from 'adult-selection-review-v1-20260916'
    or coverage->'sourceTextRevision' is distinct from rev
    or jsonb_typeof(coverage->'pairs') is distinct from 'array'
    or p_row->'teachingAnalysis'->>'reviewVersion' is distinct from 'adult-selection-review-v1-20260916'
    then return false; end if;
  return jsonb_array_length(coverage->'pairs')<=2;
end $$;

create function private.learning_coverage_valid_v1(p_rows jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare row_value jsonb; left_row jsonb; right_row jsonb; report jsonb; partner jsonb;
  n integer; i integer; j integer; report_index integer; expected_count integer; expected_status text;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then return false; end if;
  if not exists(select 1 from jsonb_array_elements(p_rows) r where r ?| array['wordLookup','translationAnalysis','coverageAnalysis']) then return true; end if;
  n:=jsonb_array_length(p_rows);
  if (select count(distinct r->>'id') from jsonb_array_elements(p_rows) r)<>n then return false; end if;
  for i in 0..n-1 loop
    row_value:=p_rows->i;
    if not (row_value ?& array['wordLookup','translationAnalysis','coverageAnalysis'])
      or not private.learning_details_valid_v1(row_value) then return false; end if;
    expected_count:=(case when i>0 then 1 else 0 end)+(case when i<n-1 then 1 else 0 end);
    if jsonb_array_length(row_value->'coverageAnalysis'->'pairs')<>expected_count then return false; end if;
    report_index:=0;
    for j in greatest(0,i-1)..least(i,n-2) loop
      left_row:=p_rows->j; right_row:=p_rows->(j+1);
      report:=row_value->'coverageAnalysis'->'pairs'->report_index;
      if jsonb_typeof(left_row->'keyWords') is distinct from 'array' or jsonb_typeof(right_row->'keyWords') is distinct from 'array' then return false; end if;
      expected_status:=case when jsonb_array_length(left_row->'keyWords')+jsonb_array_length(right_row->'keyWords')>0 then 'covered'
        when left_row->'selectionLocked'='true'::jsonb and right_row->'selectionLocked'='true'::jsonb then 'locked' else 'no_eligible_source' end;
      if report->'pairId' is distinct from to_jsonb('p'||j)
        or report->'sentenceIds' is distinct from jsonb_build_array(left_row->'id',right_row->'id')
        or report->'sourceTextRevisions' is distinct from jsonb_build_array(coalesce(left_row->'textRevision','1'::jsonb),coalesce(right_row->'textRevision','1'::jsonb))
        or report->>'status' is distinct from expected_status
        or not private.learning_detail_text_v1(report->'reasonZh',600) then return false; end if;
      select r into partner from jsonb_array_elements((case when i=j then right_row else left_row end)->'coverageAnalysis'->'pairs') r
        where r->>'pairId'='p'||j;
      if partner is distinct from report then return false; end if;
      report_index:=report_index+1;
    end loop;
  end loop;
  return true;
end $$;

-- Preserve established v5 checks, adding new data checks to every caller.
alter function private.learning_sentence_issues_v5(jsonb,boolean) rename to learning_sentence_issues_pre_details_v5;
create function private.learning_sentence_issues_v5(p_sentence jsonb,p_for_publish boolean default false)
returns jsonb language plpgsql immutable set search_path='' as $$
declare issues jsonb:=private.learning_sentence_issues_pre_details_v5(p_sentence,p_for_publish);
begin
  if not private.learning_details_valid_v1(p_sentence) then
    issues:=issues||jsonb_build_array(jsonb_build_object('code','TEACHING_DETAILS_INVALID','message','教学详情与当前字幕不一致，请重新处理'));
  end if;
  return issues;
end $$;

alter function private.merge_learning_sentence_v5(jsonb,jsonb,text) rename to merge_learning_sentence_pre_details_v5;
create function private.merge_learning_sentence_v5(p_current jsonb,p_patch jsonb,p_mode text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare next_row jsonb; detail_row jsonb; field_name text;
begin
  next_row:=private.merge_learning_sentence_pre_details_v5(p_current,p_patch,p_mode);
  if p_patch ?| array['wordLookup','translationAnalysis','coverageAnalysis'] then
    if p_patch->'id' is distinct from p_current->'id'
      or p_patch->'english' is distinct from p_current->'english'
      or coalesce(p_patch->'textRevision','1'::jsonb) is distinct from coalesce(p_current->'textRevision','1'::jsonb)
      then raise exception 'LEARNING_DETAIL_SOURCE_CHANGED'; end if;
    detail_row:=p_current||p_patch;
    if not private.learning_details_valid_v1(detail_row) then raise exception 'LEARNING_DETAILS_INVALID'; end if;
    if p_current->'translationLocked'='true'::jsonb and p_patch->'chinese' is distinct from p_current->'chinese'
      then raise exception 'TEACHING_TRANSLATION_LOCKED'; end if;
    foreach field_name in array array['chinese','wordLookup','translationAnalysis','coverageAnalysis'] loop
      next_row:=jsonb_set(next_row,array[field_name],p_patch->field_name,true);
    end loop;
  end if;
  return next_row;
end $$;

-- Keep the existing transaction's snapshot compare-and-swap, backup and grants.
-- Its private helper receives only the original field set; the public wrapper
-- validates and writes the complete, exact detail snapshots in that transaction.
alter function public.service_commit_reviewed_teaching(text,uuid,bigint,jsonb,jsonb,jsonb) set schema private;
alter function private.service_commit_reviewed_teaching(text,uuid,bigint,jsonb,jsonb,jsonb) rename to service_commit_reviewed_teaching_base_v1;
revoke all on function private.service_commit_reviewed_teaching_base_v1(text,uuid,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
create function public.service_commit_reviewed_teaching(
  p_video_id text,p_job_id uuid,p_expected_revision bigint,p_expected_published jsonb,p_expected_draft jsonb,p_patches jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old_row jsonb; draft_row jsonb; patch jsonb; next_row jsonb; n integer; result jsonb;
  snapshot_row private.content_snapshots%rowtype;
  stripped jsonb:='[]'::jsonb; published_rows jsonb:='[]'::jsonb; draft_rows jsonb:='[]'::jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into snapshot_row from private.content_snapshots where environment='production' for update;
  if snapshot_row.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  if snapshot_row.published->'sentences'->p_video_id is distinct from p_expected_published
    or snapshot_row.draft->'sentences'->p_video_id is distinct from p_expected_draft then raise exception 'TEACHING_SOURCE_CHANGED'; end if;
  if jsonb_typeof(p_patches) is distinct from 'array' or jsonb_typeof(p_expected_published) is distinct from 'array'
    or jsonb_typeof(p_expected_draft) is distinct from 'array' then raise exception 'TEACHING_PATCH_INVALID'; end if;
  if jsonb_array_length(p_patches)<>jsonb_array_length(p_expected_published)
    or jsonb_array_length(p_expected_draft)<>jsonb_array_length(p_expected_published) then raise exception 'TEACHING_ROW_COUNT_CHANGED'; end if;
  for old_row,n in select value,ordinality::integer-1 from jsonb_array_elements(p_expected_published) with ordinality loop
    patch:=p_patches->n;
    if jsonb_typeof(patch) is distinct from 'object' then raise exception 'TEACHING_PATCH_INVALID'; end if;
    if patch->'id' is distinct from old_row->'id' then raise exception 'TEACHING_ROW_ID_CHANGED'; end if;
    if exists(select 1 from jsonb_object_keys(patch) k where k not in
      ('id','keyWords','expressions','teachingAnalysis','chinese','wordLookup','translationAnalysis','coverageAnalysis'))
      then raise exception 'TEACHING_PATCH_FIELD_DENIED'; end if;
    if (patch ?| array['chinese','wordLookup','translationAnalysis','coverageAnalysis'])
      and not (patch ?& array['chinese','wordLookup','translationAnalysis','coverageAnalysis']) then raise exception 'TEACHING_DETAILS_INCOMPLETE'; end if;
    select d into draft_row from jsonb_array_elements(p_expected_draft) d where d->'id'=old_row->'id';
    if draft_row is null then raise exception 'TEACHING_DRAFT_ID_CHANGED'; end if;
    if (old_row->'selectionLocked'='true'::jsonb and
      (patch->'keyWords' is distinct from old_row->'keyWords' or patch->'expressions' is distinct from old_row->'expressions'))
      or (draft_row->'selectionLocked'='true'::jsonb and
      (patch->'keyWords' is distinct from draft_row->'keyWords' or patch->'expressions' is distinct from draft_row->'expressions'))
      then raise exception 'TEACHING_SELECTION_LOCKED'; end if;
    if patch ? 'chinese' and ((old_row->'translationLocked'='true'::jsonb and patch->'chinese' is distinct from old_row->'chinese')
      or (draft_row->'translationLocked'='true'::jsonb and patch->'chinese' is distinct from draft_row->'chinese'))
      then raise exception 'TEACHING_TRANSLATION_LOCKED'; end if;
    next_row:=old_row||(patch-'id');
    if not private.learning_details_valid_v1(next_row) then raise exception 'TEACHING_DETAILS_INVALID'; end if;
    published_rows:=published_rows||jsonb_build_array(next_row);
    stripped:=stripped||jsonb_build_array(patch-array['chinese','wordLookup','translationAnalysis','coverageAnalysis']);
  end loop;
  if not private.learning_coverage_valid_v1(published_rows) then raise exception 'TEACHING_COVERAGE_INVALID'; end if;
  for draft_row in select value from jsonb_array_elements(p_expected_draft) loop
    select p into patch from jsonb_array_elements(p_patches) p where p->'id'=draft_row->'id';
    if patch is null then raise exception 'TEACHING_DRAFT_ID_CHANGED'; end if;
    next_row:=draft_row||(patch-'id');
    if not private.learning_details_valid_v1(next_row) then raise exception 'TEACHING_DRAFT_DETAILS_INVALID'; end if;
    draft_rows:=draft_rows||jsonb_build_array(next_row);
  end loop;
  result:=private.service_commit_reviewed_teaching_base_v1(p_video_id,p_job_id,p_expected_revision,p_expected_published,p_expected_draft,stripped);
  update private.content_snapshots set published=jsonb_set(published,array['sentences',p_video_id],published_rows),
    draft=jsonb_set(draft,array['sentences',p_video_id],draft_rows) where environment='production';
  return result;
end $$;

-- Coverage needs neighboring sentences, including in fill-missing mode. The
-- established function still decides whether work exists and enforces admin,
-- revision, active-job and media checks before widening a new queued payload.
alter function public.admin_create_learning_repair_job_v5(text,bigint,text) set schema private;
alter function private.admin_create_learning_repair_job_v5(text,bigint,text) rename to admin_create_learning_repair_job_base_v5;
revoke all on function private.admin_create_learning_repair_job_base_v5(text,bigint,text) from public,anon,authenticated,service_role;
create function public.admin_create_learning_repair_job_v5(p_video_id text,p_expected_revision bigint,p_mode text default 'fill_missing')
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; job_row public.processing_jobs%rowtype; all_rows jsonb;
begin
  result:=private.admin_create_learning_repair_job_base_v5(p_video_id,p_expected_revision,p_mode);
  select * into job_row from public.processing_jobs where id=(result->'job'->>'id')::uuid for update;
  if job_row.status='QUEUED' and job_row.run_id is null then
    select draft->'sentences'->p_video_id into all_rows from private.content_snapshots where environment='production';
    update public.processing_jobs set input=input||jsonb_build_object(
      'sentences',all_rows,'coverageScope','full-video','teachingDetailsVersion',1,
      'targetSentenceIds',coalesce(input->'targetSentenceIds',(select jsonb_agg(r->'id') from jsonb_array_elements(input->'sentences') r)))
      where id=job_row.id returning * into job_row;
    result:=jsonb_set(result,'{job}',to_jsonb(job_row));
  end if;
  return result;
end $$;

alter function public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) set schema private;
alter function private.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) rename to processing_commit_learning_repair_base_v5;
revoke all on function private.processing_commit_learning_repair_base_v5(uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.processing_commit_learning_repair_v5(p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_result jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job_row public.processing_jobs%rowtype; result jsonb; current_rows jsonb; detail_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform 1 from private.content_snapshots where environment='production' for update;
  select * into job_row from public.processing_jobs where id=p_job_id for update;
  if jsonb_typeof(p_result->'sentences') is distinct from 'array' then raise exception 'LEARNING_REPAIR_RESULT_INVALID'; end if;
  select count(*) into detail_count from jsonb_array_elements(p_result->'sentences') r
    where r ?| array['wordLookup','translationAnalysis','coverageAnalysis'];
  if job_row.input->>'coverageScope'='full-video' then
    if detail_count<>jsonb_array_length(p_result->'sentences') or not private.learning_coverage_valid_v1(p_result->'sentences')
      then raise exception 'LEARNING_REPAIR_COVERAGE_INVALID'; end if;
    select draft->'sentences'->job_row.video_id into current_rows from private.content_snapshots where environment='production';
    if (select jsonb_agg(r->'id' order by n) from jsonb_array_elements(current_rows) with ordinality a(r,n))
      is distinct from (select jsonb_agg(r->'id' order by n) from jsonb_array_elements(job_row.input->'sentences') with ordinality a(r,n))
      then raise exception 'LEARNING_SOURCE_CHANGED'; end if;
  elsif detail_count>0 then raise exception 'LEARNING_REPAIR_FULL_VIDEO_REQUIRED';
  end if;
  result:=private.processing_commit_learning_repair_base_v5(p_job_id,p_run_id,p_token,p_worker_id,p_result);
  if job_row.input->>'coverageScope'='full-video' and not private.learning_coverage_valid_v1(result->'snapshot'->'sentences'->job_row.video_id)
    then raise exception 'LEARNING_REPAIR_MERGED_COVERAGE_INVALID'; end if;
  return result;
end $$;

-- A modern job must never enter the older merge route.
alter function public.processing_commit_learning_repair_v4(uuid,uuid,text,text,jsonb) set schema private;
alter function private.processing_commit_learning_repair_v4(uuid,uuid,text,text,jsonb) rename to processing_commit_learning_repair_legacy_v4;
revoke all on function private.processing_commit_learning_repair_legacy_v4(uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.processing_commit_learning_repair_v4(p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_result jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job_input jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  -- Match the established snapshot -> job lock ordering.
  perform 1 from private.content_snapshots where environment='production' for update;
  select input into job_input from public.processing_jobs where id=p_job_id for update;
  if coalesce((job_input->>'contractVersion')::integer,0)>=5
    or coalesce((job_input->>'teachingSchemaVersion')::integer,0)>=3
    then raise exception 'LEARNING_REPAIR_V5_REQUIRED'; end if;
  return private.processing_commit_learning_repair_legacy_v4(p_job_id,p_run_id,p_token,p_worker_id,p_result);
end $$;

revoke all on function private.learning_utf16_length_v1(text),private.learning_detail_text_v1(jsonb,integer),
  private.learning_details_valid_v1(jsonb),private.learning_coverage_valid_v1(jsonb),
  private.learning_sentence_issues_pre_details_v5(jsonb,boolean),private.merge_learning_sentence_pre_details_v5(jsonb,jsonb,text),
  private.learning_sentence_issues_v5(jsonb,boolean),private.merge_learning_sentence_v5(jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.service_commit_reviewed_teaching(text,uuid,bigint,jsonb,jsonb,jsonb),
  public.processing_commit_learning_repair_v4(uuid,uuid,text,text,jsonb),
  public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.service_commit_reviewed_teaching(text,uuid,bigint,jsonb,jsonb,jsonb),
  public.processing_commit_learning_repair_v4(uuid,uuid,text,text,jsonb),
  public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) to service_role;
revoke all on function public.admin_create_learning_repair_job_v5(text,bigint,text) from public,anon;
grant execute on function public.admin_create_learning_repair_job_v5(text,bigint,text) to authenticated;
commit;
