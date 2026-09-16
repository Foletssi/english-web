-- Publish only reviewed teaching fields; preserve media, timing and editorial drafts.
begin;
create function public.service_commit_reviewed_teaching(
  p_video_id text,p_job_id uuid,p_expected_revision bigint,
  p_expected_published jsonb,p_expected_draft jsonb,p_patches jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  c private.content_snapshots%rowtype; video jsonb; old_row jsonb; draft_row jsonb;
  patch jsonb; next_row jsonb; teaching jsonb; issues jsonb;
  published_rows jsonb:='[]'::jsonb; draft_rows jsonb:='[]'::jsonb;
  n integer; total integer:=0;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select v into video from jsonb_array_elements(c.published->'videos') v
    where v->>'id'=p_video_id and v->>'processingJobId'=p_job_id::text and v->>'status'='PUBLISHED';
  if video is null or exists(select 1 from private.content_video_trash t where t.environment='production'
    and t.video_id=p_video_id and t.restored_at is null) then raise exception 'CURRENT_PUBLISHED_VIDEO_REQUIRED'; end if;
  if c.published->'sentences'->p_video_id is distinct from p_expected_published
    or c.draft->'sentences'->p_video_id is distinct from p_expected_draft then
    raise exception 'TEACHING_SOURCE_CHANGED'; end if;
  if jsonb_typeof(p_patches) is distinct from 'array'
    or jsonb_typeof(p_expected_published) is distinct from 'array'
    or jsonb_typeof(p_expected_draft) is distinct from 'array' then raise exception 'TEACHING_PATCH_INVALID'; end if;
  if jsonb_array_length(p_patches)<>jsonb_array_length(p_expected_published)
    or jsonb_array_length(p_expected_draft)<>jsonb_array_length(p_expected_published) then
    raise exception 'TEACHING_ROW_COUNT_CHANGED'; end if;
  if exists(select 1 from jsonb_array_elements(p_expected_published) r group by r->>'id'
      having count(*)>1 or nullif(r->>'id','') is null)
    or exists(select 1 from jsonb_array_elements(p_expected_draft) r group by r->>'id'
      having count(*)>1 or nullif(r->>'id','') is null) then raise exception 'TEACHING_DUPLICATE_ID'; end if;
  for old_row,n in select value,ordinality::integer-1 from jsonb_array_elements(p_expected_published) with ordinality loop
    patch:=p_patches->n;
    if jsonb_typeof(patch) is distinct from 'object'
      or jsonb_typeof(patch->'keyWords') is distinct from 'array'
      or jsonb_typeof(patch->'expressions') is distinct from 'array'
      or jsonb_typeof(patch->'teachingAnalysis') is distinct from 'object' then raise exception 'TEACHING_PATCH_INVALID'; end if;
    if patch->>'id' is distinct from old_row->>'id' then raise exception 'TEACHING_ROW_ID_CHANGED'; end if;
    if exists(select 1 from jsonb_object_keys(patch) k where k not in
      ('id','keyWords','expressions','teachingAnalysis')) then raise exception 'TEACHING_PATCH_FIELD_DENIED'; end if;
    if patch->'teachingAnalysis'->>'status' is distinct from 'completed'
      or nullif(patch->'teachingAnalysis'->>'reviewVersion','') is null
      or nullif(patch->'teachingAnalysis'->>'promptVersion','') is null
      or patch->'teachingAnalysis'->'sourceTextRevision' is distinct from coalesce(old_row->'textRevision','1'::jsonb)
      then raise exception 'TEACHING_REVIEW_REQUIRED'; end if;
    select d into draft_row from jsonb_array_elements(p_expected_draft) d where d->>'id'=old_row->>'id';
    if draft_row is null or draft_row->'english' is distinct from old_row->'english'
      or draft_row->'startTime' is distinct from old_row->'startTime'
      or draft_row->'endTime' is distinct from old_row->'endTime'
      or coalesce(draft_row->'textRevision','1'::jsonb) is distinct from coalesce(old_row->'textRevision','1'::jsonb)
      then raise exception 'TEACHING_DRAFT_TEXT_CHANGED'; end if;
    if (old_row->'selectionLocked'='true'::jsonb or draft_row->'selectionLocked'='true'::jsonb)
      and (patch->'keyWords' is distinct from draft_row->'keyWords'
        or patch->'expressions' is distinct from draft_row->'expressions') then raise exception 'TEACHING_SELECTION_LOCKED'; end if;
    teaching:=patch-'id';
    next_row:=old_row||teaching;
    issues:=private.learning_sentence_issues_v5(next_row,true);
    if jsonb_array_length(issues)>0 then raise exception 'TEACHING_PUBLICATION_INVALID:%',issues; end if;
    published_rows:=published_rows||jsonb_build_array(next_row);
    total:=total+jsonb_array_length(patch->'expressions');
  end loop;
  -- Keep the draft's ordering, translation, grammar, lock and sentence review state.
  for draft_row in select value from jsonb_array_elements(p_expected_draft) loop
    select p into patch from jsonb_array_elements(p_patches) p where p->>'id'=draft_row->>'id';
    if patch is null then raise exception 'TEACHING_DRAFT_ID_CHANGED'; end if;
    draft_rows:=draft_rows||jsonb_build_array(draft_row||(patch-'id'));
  end loop;
  insert into private.catalog_field_backups(revision,reason,fields) values(c.revision,'teaching:'||p_video_id,
    jsonb_build_object('videoId',p_video_id,'published',p_expected_published,'draft',p_expected_draft));
  update private.content_snapshots set
    published=jsonb_set(published,array['sentences',p_video_id],published_rows),
    draft=jsonb_set(draft,array['sentences',p_video_id],draft_rows),revision=revision+1,updated_at=now()
    where environment='production';
  return jsonb_build_object('videoId',p_video_id,'revision',c.revision+1,'sentences',jsonb_array_length(published_rows),'expressions',total);
end $$;
revoke all on function public.service_commit_reviewed_teaching(text,uuid,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.service_commit_reviewed_teaching(text,uuid,bigint,jsonb,jsonb,jsonb) to service_role;
commit;
