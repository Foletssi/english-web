begin;
create or replace function public.processing_validate_teaching_v2(
  p_job_id uuid, p_run_id uuid, p_token text, p_worker_id text, p_sentences jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare sentence jsonb; expected_count bigint; snapshot_bytes bigint;
begin
  perform private.assert_current_processing_job(p_job_id);
  perform private.processing_lock_run(p_job_id,p_run_id,p_token,p_worker_id);
  if jsonb_typeof(p_sentences) is distinct from 'array' then
    raise exception 'TEACHING_DETAILS_INVALID';
  end if;
  if jsonb_array_length(p_sentences) not between 1 and 30000 then
    raise exception 'TEACHING_DETAILS_INVALID';
  end if;
  for sentence in select value from jsonb_array_elements(p_sentences) loop
    if jsonb_typeof(sentence) is distinct from 'object'
      or jsonb_typeof(sentence->'id') is distinct from 'string'
      or coalesce(length(btrim(sentence->>'id')),0) not between 1 and 200
      or jsonb_typeof(sentence->'wordLookup') is distinct from 'object'
      or jsonb_typeof(sentence#>'{wordLookup,tokens}') is distinct from 'array'
      or jsonb_typeof(sentence->'translationAnalysis') is distinct from 'object'
      or jsonb_typeof(sentence->'coverageAnalysis') is distinct from 'object'
      or (sentence ? 'expressions' and jsonb_typeof(sentence->'expressions') is distinct from 'array')
      then raise exception 'TEACHING_DETAILS_INVALID'; end if;
    if private.learning_details_valid_v1(sentence) is distinct from true then
      raise exception 'TEACHING_DETAILS_INVALID';
    end if;
  end loop;
  if (select count(distinct r->>'id') from jsonb_array_elements(p_sentences) r) <> jsonb_array_length(p_sentences)
    then raise exception 'VOICE_SOURCE_STALE'; end if;
  select coalesce(sum(jsonb_array_length(r#>'{wordLookup,tokens}') +
    (select count(*) from jsonb_array_elements(coalesce(r->'expressions','[]'::jsonb)) e
     where upper(coalesce(e->>'reviewStatus','')) not in ('REJECTED','DELETED'))),0)
    into expected_count from jsonb_array_elements(p_sentences) r;
  if expected_count not between 1 and 30000 then raise exception 'VOICE_MANIFEST_INCOMPLETE'; end if;
  -- Reserve capacity before paid voice; final validation remains exact and locked.
  select octet_length(draft::text) into snapshot_bytes from private.content_snapshots where environment='production';
  if coalesce(snapshot_bytes,0) + octet_length(p_sentences::text) + expected_count*2048 + 1048576 > 33554432 then
    raise exception 'CONTENT_SNAPSHOT_CAPACITY_INSUFFICIENT';
  end if;
  return jsonb_build_object('valid',true,'sentenceCount',jsonb_array_length(p_sentences),'voiceItemCount',expected_count);
end $$;
revoke all on function public.processing_validate_teaching_v2(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.processing_validate_teaching_v2(uuid,uuid,text,text,jsonb) to service_role;
alter function public.processing_validate_teaching_v2(uuid,uuid,text,text,jsonb) set statement_timeout='20s';
alter function public.processing_validate_teaching_v2(uuid,uuid,text,text,jsonb) set lock_timeout='2s';
commit;
