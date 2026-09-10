-- The product owner designated this verified phone account as the primary admin.
-- Admin is also accepted by the learner client, so one account can use both apps.
do $$
declare
  v_user uuid;
begin
  select id into v_user from auth.users where phone in ('8619882569493', '+8619882569493');
  if v_user is null then raise exception 'PRIMARY_ADMIN_ACCOUNT_MISSING'; end if;

  update public.profiles
  set role = 'admin', is_active = true
  where id = v_user;
  if not found then raise exception 'PRIMARY_ADMIN_PROFILE_MISSING'; end if;
end;
$$;
