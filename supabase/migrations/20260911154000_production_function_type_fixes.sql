-- Resolve two production PL/pgSQL type/identifier ambiguities found by db lint.

create or replace function public.eastudy_merge_watch_ranges(
  p_existing jsonb,
  p_incoming jsonb,
  p_duration double precision
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select public.eastudy_merge_watch_ranges(p_existing, p_incoming, p_duration::numeric)
$$;

create or replace function public.redeem_activation_code(p_code text)
returns table(product_id text, expires_at timestamptz, revoked_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_normalized text;
  v_code private.activation_codes%rowtype;
  v_entitlement public.membership_entitlements%rowtype;
begin
  if v_user is null then raise exception 'STUDENT_REQUIRED'; end if;
  select lower(coalesce(profile.role, '')) into v_role
  from public.profiles profile where profile.id = v_user;
  if v_role not in ('learner', 'student') then raise exception 'STUDENT_REQUIRED'; end if;
  v_normalized := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'));
  if length(v_normalized) < 12 or length(v_normalized) > 80 then
    raise exception 'INVALID_ACTIVATION_CODE';
  end if;
  select code.* into v_code
  from private.activation_codes code
  where code.code_hash = extensions.digest(convert_to(v_normalized, 'UTF8'), 'sha256')
  for update;
  if not found or v_code.revoked_at is not null
     or (v_code.valid_until is not null and v_code.valid_until <= now())
     or exists(select 1 from private.activation_code_batches batch
       where batch.id = v_code.batch_id and batch.disabled_at is not null) then
    raise exception 'INVALID_ACTIVATION_CODE';
  end if;
  if v_code.redeemed_by is not null then
    if v_code.redeemed_by <> v_user then raise exception 'INVALID_ACTIVATION_CODE'; end if;
    select entitlement.* into v_entitlement
    from public.membership_entitlements entitlement
    where entitlement.user_id = v_user and entitlement.product_id = v_code.product_id;
    return query select v_entitlement.product_id, v_entitlement.expires_at,
      v_entitlement.revoked_at, v_entitlement.updated_at;
    return;
  end if;
  insert into public.membership_entitlements as entitlement
    (user_id, product_id, expires_at, revoked_at, created_at, updated_at)
  values(v_user, v_code.product_id,
    now() + make_interval(days => v_code.duration_days), null, now(), now())
  on conflict on constraint membership_entitlements_pkey do update set
    expires_at = greatest(now(), entitlement.expires_at) + make_interval(days => v_code.duration_days),
    revoked_at = null, updated_at = now()
  returning entitlement.* into v_entitlement;
  update private.activation_codes set redeemed_by = v_user, redeemed_at = now()
  where id = v_code.id;
  insert into private.membership_redemptions
    (code_id, user_id, product_id, duration_days, entitlement_expires_at)
  values(v_code.id, v_user, v_code.product_id, v_code.duration_days, v_entitlement.expires_at);
  return query select v_entitlement.product_id, v_entitlement.expires_at,
    v_entitlement.revoked_at, v_entitlement.updated_at;
end;
$$;

revoke all on function public.eastudy_merge_watch_ranges(jsonb,jsonb,double precision)
  from public, anon;
revoke all on function public.redeem_activation_code(text) from public, anon;
grant execute on function public.eastudy_merge_watch_ranges(jsonb,jsonb,double precision)
  to authenticated;
grant execute on function public.redeem_activation_code(text) to authenticated;
