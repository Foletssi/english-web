-- Run after 20260916123000 in a rollback-only migration check. The scratch
-- table copies the real columns/check constraints without touching user rows.
create temporary table vocabulary_context_contract
  (like public.user_vocabulary including constraints including defaults) on commit drop;

do $$
declare policy_using text; policy_check text;
begin
  if not (select relrowsecurity from pg_class where oid='public.user_vocabulary'::regclass) then
    raise exception 'Vocabulary RLS is disabled';
  end if;
  select pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid)
    into policy_using,policy_check from pg_policy
    where polrelid='public.user_vocabulary'::regclass and polname='vocabulary learning access v2';
  if policy_using is null or policy_check is null
    or position('auth.uid()' in policy_using)=0 or position('auth.uid()' in policy_check)=0
    or position('has_learning_access_v2()' in policy_check)=0 then
    raise exception 'Vocabulary ownership/membership policy changed';
  end if;

  insert into vocabulary_context_contract(user_id,word_key,word,meaning)
    values('00000000-0000-0000-0000-000000000001','legacy','Legacy','保留旧数据');
  insert into vocabulary_context_contract(user_id,word_key,word,source_token_id,source_text_revision)
    values('00000000-0000-0000-0000-000000000001','current','Current','t2',4);
  if not exists(select 1 from vocabulary_context_contract where word_key='legacy'
      and source_token_id is null and source_text_revision is null and meaning='保留旧数据') then
    raise exception 'Legacy vocabulary compatibility failed';
  end if;
  begin
    update vocabulary_context_contract set source_text_revision=0 where word_key='current';
    raise exception 'Invalid revision accepted';
  exception when check_violation then null;
  end;
  begin
    update vocabulary_context_contract set source_token_id='  ' where word_key='current';
    raise exception 'Invalid token accepted';
  exception when check_violation then null;
  end;
  if not exists(select 1 from vocabulary_context_contract where word_key='current'
      and source_token_id='t2' and source_text_revision=4) then
    raise exception 'Failed validation changed stored identity';
  end if;
end $$;
