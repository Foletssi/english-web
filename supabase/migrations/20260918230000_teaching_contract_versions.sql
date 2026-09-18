begin;

do $migration$
declare
  original text;
  revised text;
begin
  original := pg_get_functiondef('private.learning_details_valid_v1(jsonb)'::regprocedure);
  revised := replace(original,
    $$or coverage->>'promptVersion' is distinct from 'adjacent-coverage-v1-20260916'
    or coverage->>'reviewVersion' is distinct from 'adult-selection-review-v1-20260916'$$,
    $$or not coalesce((coverage->>'promptVersion', coverage->>'reviewVersion') in (
      ('adjacent-coverage-v1-20260916', 'adult-selection-review-v1-20260916'),
      ('adjacent-coverage-v2-20260916', 'adult-selection-review-v2-20260916')), false)$$);
  if revised = original then raise exception 'TEACHING_COVERAGE_MIGRATION_DRIFT'; end if;
  original := revised;
  revised := replace(original,
    $$or p_row->'teachingAnalysis'->>'reviewVersion' is distinct from 'adult-selection-review-v1-20260916'$$,
    $$or p_row->'teachingAnalysis'->>'reviewVersion' is distinct from coverage->>'reviewVersion'$$);
  if revised = original then raise exception 'TEACHING_REVIEW_MIGRATION_DRIFT'; end if;
  execute revised;

  original := pg_get_functiondef('private.register_teaching_voice_v1(uuid,uuid,uuid,text,jsonb,jsonb)'::regprocedure);
  revised := replace(original,
    $$  select coalesce(sum(jsonb_array_length$$,
    $$  for sentence in select value from jsonb_array_elements(p_rows) loop
    if not private.learning_details_valid_v1(sentence) then
      raise exception 'TEACHING_DETAILS_INVALID';
    end if;
  end loop;
  select coalesce(sum(jsonb_array_length$$);
  if revised = original then raise exception 'VOICE_VALIDATION_MIGRATION_DRIFT'; end if;
  original := revised;
  revised := replace(original, ' or not private.learning_details_valid_v1(sentence)', '');
  if revised = original then raise exception 'VOICE_ERROR_MIGRATION_DRIFT'; end if;
  execute revised;
end;
$migration$;

commit;
