-- Extend accepted classifications only; no existing video or teaching data writes.
begin;
create or replace function private.validate_video_difficulty(p_value jsonb,p_sentences jsonb)
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
  if exists(select 1 from jsonb_array_elements_text(p_value->'targetTracks') x where x not in ('gaokao','zsb','cet4','cet6','tem4','tem8','ielts','toefl'))
    or (select count(distinct x) from jsonb_array_elements_text(p_value->'targetTracks') x)<>jsonb_array_length(p_value->'targetTracks')
    or (primary_track is not null and (primary_track not in ('gaokao','zsb','cet4','cet6','tem4','tem8','ielts','toefl') or not (p_value->'targetTracks') ? primary_track))
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
commit;
