-- Exam tracks are reviewed suitability labels, never an automatic CEFR conversion.
begin;

create function private.validate_video_difficulty(p_value jsonb,p_sentences jsonb)
returns void language plpgsql stable set search_path='' as $$
declare evidence jsonb; sid text; primary_track text;
begin
  if p_value is null or p_value='null'::jsonb then return; end if;
  primary_track:=p_value->>'primaryTrack';
  if jsonb_typeof(p_value) is distinct from 'object'
    or p_value->'schemaVersion' is distinct from '1'::jsonb
    or coalesce(p_value->>'reviewStatus','') not in ('review','approved')
    or coalesce(p_value->>'source','') not in ('ai','admin')
    or jsonb_typeof(p_value->'targetTracks') is distinct from 'array'
    then raise exception 'DIFFICULTY_SCHEMA_INVALID'; end if;
  if exists(select 1 from jsonb_array_elements_text(p_value->'targetTracks') x where x not in ('cet4','cet6','ielts','toefl'))
    or (select count(distinct x) from jsonb_array_elements_text(p_value->'targetTracks') x)<>jsonb_array_length(p_value->'targetTracks')
    or (primary_track is not null and (primary_track not in ('cet4','cet6','ielts','toefl') or not (p_value->'targetTracks') ? primary_track))
    or (primary_track is null and (jsonb_array_length(p_value->'targetTracks')>0 or p_value->>'reviewStatus'='approved'))
    then raise exception 'DIFFICULTY_TRACK_INVALID'; end if;
  if p_value->>'source'='ai' and primary_track is not null then
    if jsonb_typeof(p_value->'evidence') is distinct from 'array' or jsonb_array_length(p_value->'evidence')=0
      then raise exception 'DIFFICULTY_EVIDENCE_REQUIRED'; end if;
    for evidence in select value from jsonb_array_elements(p_value->'evidence') loop
      if jsonb_typeof(evidence->'sentenceIds') is distinct from 'array'
        or jsonb_typeof(evidence->'reasonZh') is distinct from 'string'
        or jsonb_array_length(evidence->'sentenceIds')=0 or length(trim(coalesce(evidence->>'reasonZh','')))=0
        then raise exception 'DIFFICULTY_EVIDENCE_INVALID'; end if;
      for sid in select value from jsonb_array_elements_text(evidence->'sentenceIds') loop
        if not exists(select 1 from jsonb_array_elements(coalesce(p_sentences,'[]'::jsonb)) s where s->>'id'=sid)
          then raise exception 'DIFFICULTY_SENTENCE_MISSING'; end if;
      end loop;
    end loop;
  end if;
end $$;
revoke all on function private.validate_video_difficulty(jsonb,jsonb) from public,anon,authenticated;

create function private.validate_snapshot_difficulty()
returns trigger language plpgsql security definer set search_path='' as $$
declare field text; doc jsonb; previous jsonb; video jsonb; old_video jsonb;
begin
  foreach field in array array['draft','published'] loop
    doc:=to_jsonb(new)->field;
    previous:=case when tg_op='UPDATE' then to_jsonb(old)->field else null end;
    for video in select value from jsonb_array_elements(coalesce(doc->'videos','[]'::jsonb)) loop
      select v into old_video from jsonb_array_elements(coalesce(previous->'videos','[]'::jsonb)) v where v->>'id'=video->>'id';
      if video->'difficulty' is distinct from old_video->'difficulty'
        or doc->'sentences'->(video->>'id') is distinct from previous->'sentences'->(video->>'id') then
        perform private.validate_video_difficulty(video->'difficulty',doc->'sentences'->(video->>'id'));
      end if;
    end loop;
  end loop;
  return new;
end $$;
revoke all on function private.validate_snapshot_difficulty() from public,anon,authenticated;
create trigger validate_snapshot_difficulty before insert or update of draft,published
on private.content_snapshots for each row execute function private.validate_snapshot_difficulty();

-- A worker result can only propose a label. Approval remains an admin operation.
do $$
declare definition text;
begin
  definition:=pg_get_functiondef('public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb)'::regprocedure);
  if position('return public.processing_commit_result(p_job_id,p_result);' in definition)=0 then raise exception 'DIFFICULTY_COMMIT_DRIFT'; end if;
  definition:=replace(definition,'return public.processing_commit_result(p_job_id,p_result);',
    'if jsonb_typeof(p_result#>''{video,difficulty}'')=''object'' then
       p_result:=jsonb_set(p_result,''{video,difficulty}'',(p_result#>''{video,difficulty}'')||jsonb_build_object(''reviewStatus'',''review'',''source'',''ai''));
     end if;
     return public.processing_commit_result(p_job_id,p_result);');
  execute definition;
end $$;

-- Field-only maintenance: never publish unrelated teaching drafts.
create function public.service_commit_video_difficulty(p_video_id text,p_job_id uuid,p_expected_revision bigint,p_difficulty jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.content_snapshots%rowtype; video jsonb; draft_difficulty jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select v into video from jsonb_array_elements(c.published->'videos') v
    where v->>'id'=p_video_id and v->>'processingJobId'=p_job_id::text and v->>'status'='PUBLISHED';
  if video is null or exists(select 1 from private.content_video_trash t where t.environment='production'
    and t.video_id=p_video_id and t.restored_at is null) then raise exception 'CURRENT_PUBLISHED_VIDEO_REQUIRED'; end if;
  if p_difficulty->>'reviewStatus' is distinct from 'approved' then raise exception 'DIFFICULTY_REVIEW_REQUIRED'; end if;
  perform private.validate_video_difficulty(p_difficulty,c.published->'sentences'->p_video_id);
  -- Draft sentence IDs may differ after an unpublished teaching repair. Keep the
  -- reviewed classification, but do not attach published sentence IDs to it.
  draft_difficulty:=(p_difficulty-'evidence')||jsonb_build_object('source','admin','reviewBasis','published-transcript');
  insert into private.catalog_field_backups(revision,reason,fields) values(c.revision,'difficulty:'||p_video_id,
    jsonb_build_object('videoId',p_video_id,'published',video->'difficulty',
      'draft',(select v->'difficulty' from jsonb_array_elements(c.draft->'videos') v where v->>'id'=p_video_id)));
  update private.content_snapshots set
    draft=jsonb_set(draft,'{videos}',(select jsonb_agg(case when v->>'id'=p_video_id and v->>'processingJobId'=p_job_id::text
      then v||jsonb_build_object('difficulty',draft_difficulty) else v end order by n) from jsonb_array_elements(draft->'videos') with ordinality t(v,n))),
    published=jsonb_set(published,'{videos}',
    (select jsonb_agg(case when v->>'id'=p_video_id then v||jsonb_build_object('difficulty',p_difficulty) else v end order by n)
       from jsonb_array_elements(published->'videos') with ordinality t(v,n))),
    revision=revision+1,updated_at=now() where environment='production';
  return jsonb_build_object('videoId',p_video_id,'revision',c.revision+1,'difficulty',p_difficulty);
end $$;
revoke all on function public.service_commit_video_difficulty(text,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.service_commit_video_difficulty(text,uuid,bigint,jsonb) to service_role;

commit;
