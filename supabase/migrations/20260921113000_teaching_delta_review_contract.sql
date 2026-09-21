-- Delta review checks every sentence while returning only changed fields.
-- Accept that transport-efficient review version in the durable teaching contract.
begin;
do $migration$
declare original text; revised text;
begin
  original := pg_get_functiondef('private.learning_details_valid_v1(jsonb)'::regprocedure);
  revised := replace(original,
    $$('context-lookup-v3-20260919', 'context-lookup-review-v3-20260919')$$,
    $$('context-lookup-v3-20260919', 'context-lookup-review-v3-20260919'),
      ('context-lookup-v3-20260919', 'context-delta-review-v3-20260919')$$);
  if revised = original then raise exception 'TEACHING_DELTA_REVIEW_MIGRATION_DRIFT'; end if;
  execute revised;
end;
$migration$;
commit;
