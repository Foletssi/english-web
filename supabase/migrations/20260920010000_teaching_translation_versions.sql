begin;
do $migration$
declare original text; revised text;
begin
  original := pg_get_functiondef('private.learning_details_valid_v1(jsonb)'::regprocedure);
  revised := regexp_replace(original,
    $pattern$or translation->>'promptVersion' is distinct from 'context-lookup-v2-20260916'[[:space:]]+or translation->>'reviewVersion' is distinct from 'context-lookup-review-v2-20260916'$pattern$,
    $$or not coalesce((translation->>'promptVersion', translation->>'reviewVersion') in (
      ('context-lookup-v2-20260916', 'context-lookup-review-v2-20260916'),
      ('context-lookup-v3-20260919', 'context-lookup-review-v3-20260919')), false)$$);
  if revised = original then raise exception 'TEACHING_TRANSLATION_MIGRATION_DRIFT'; end if;
  execute revised;
end;
$migration$;
commit;
