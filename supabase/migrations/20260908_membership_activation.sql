-- Eastudy Beta 6.22: server-authoritative membership and one-time activation codes.
-- Raw activation codes are returned only by the admin generator and are never stored.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

create table if not exists public.membership_entitlements (
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null default 'eastudy_pro',
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, product_id),
  constraint membership_product_valid check (product_id ~ '^[a-z0-9_]{3,40}$')
);

create table if not exists private.activation_code_batches (
  id uuid primary key default extensions.gen_random_uuid(),
  label text not null,
  product_id text not null default 'eastudy_pro',
  duration_days integer not null check (duration_days between 1 and 3660),
  code_count integer not null check (code_count between 1 and 500),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists private.activation_codes (
  id uuid primary key default extensions.gen_random_uuid(),
  batch_id uuid not null references private.activation_code_batches(id) on delete restrict,
  code_hash bytea not null unique,
  product_id text not null default 'eastudy_pro',
  duration_days integer not null check (duration_days between 1 and 3660),
  valid_until timestamptz,
  redeemed_by uuid references auth.users(id),
  redeemed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint activation_redemption_pair check ((redeemed_by is null) = (redeemed_at is null))
);

create table if not exists private.membership_redemptions (
  id bigint generated always as identity primary key,
  code_id uuid not null references private.activation_codes(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id text not null,
  duration_days integer not null,
  entitlement_expires_at timestamptz not null,
  redeemed_at timestamptz not null default now(),
  unique (code_id, user_id)
);

revoke all on schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

alter table public.membership_entitlements enable row level security;

drop policy if exists "students read own membership" on public.membership_entitlements;
create policy "students read own membership"
on public.membership_entitlements for select
to authenticated
using (auth.uid() = user_id);

revoke all on public.membership_entitlements from anon, authenticated;
grant select on public.membership_entitlements to authenticated;

create or replace function public.redeem_activation_code(p_code text)
returns table(product_id text, expires_at timestamptz, revoked_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_normalized text;
  v_code private.activation_codes%rowtype;
  v_entitlement public.membership_entitlements%rowtype;
begin
  if v_user is null then raise exception 'STUDENT_REQUIRED'; end if;
  select lower(coalesce(p.role, '')) into v_role from public.profiles p where p.id = v_user;
  if v_role not in ('learner', 'student') then raise exception 'STUDENT_REQUIRED'; end if;

  v_normalized := upper(regexp_replace(coalesce(p_code, ''), '\\s+', '', 'g'));
  if length(v_normalized) < 12 or length(v_normalized) > 48 then
    raise exception 'INVALID_ACTIVATION_CODE';
  end if;

  select c.* into v_code
  from private.activation_codes c
  where c.code_hash = extensions.digest(convert_to(v_normalized, 'UTF8'), 'sha256')
  for update;

  if not found or (v_code.valid_until is not null and v_code.valid_until <= now()) then
    raise exception 'INVALID_ACTIVATION_CODE';
  end if;

  if v_code.redeemed_by is not null then
    if v_code.redeemed_by <> v_user then raise exception 'INVALID_ACTIVATION_CODE'; end if;
    select e.* into v_entitlement from public.membership_entitlements e
      where e.user_id = v_user and e.product_id = v_code.product_id;
    return query select v_entitlement.product_id, v_entitlement.expires_at,
      v_entitlement.revoked_at, v_entitlement.updated_at;
    return;
  end if;

  insert into public.membership_entitlements as e
    (user_id, product_id, expires_at, revoked_at, created_at, updated_at)
  values
    (v_user, v_code.product_id, now() + make_interval(days => v_code.duration_days), null, now(), now())
  on conflict (user_id, product_id) do update set
    expires_at = greatest(now(), e.expires_at) + make_interval(days => v_code.duration_days),
    revoked_at = null,
    updated_at = now()
  returning e.* into v_entitlement;

  update private.activation_codes
    set redeemed_by = v_user, redeemed_at = now()
    where id = v_code.id;

  insert into private.membership_redemptions
    (code_id, user_id, product_id, duration_days, entitlement_expires_at)
  values
    (v_code.id, v_user, v_code.product_id, v_code.duration_days, v_entitlement.expires_at);

  return query select v_entitlement.product_id, v_entitlement.expires_at,
    v_entitlement.revoked_at, v_entitlement.updated_at;
end;
$$;

create or replace function public.admin_generate_activation_codes(
  p_label text,
  p_duration_days integer,
  p_count integer default 1,
  p_valid_until timestamptz default null
)
returns table(code text, duration_days integer, valid_until timestamptz)
language plpgsql
security definer
set search_path = public, private, extensions, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_batch uuid;
  v_code text;
  v_i integer;
begin
  if v_user is null or not exists (
    select 1 from public.profiles p where p.id = v_user and lower(coalesce(p.role, '')) = 'admin'
  ) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_duration_days not between 1 and 3660 or p_count not between 1 and 500 then
    raise exception 'INVALID_GENERATION_PARAMETERS';
  end if;

  insert into private.activation_code_batches(label, duration_days, code_count, created_by)
  values (left(coalesce(nullif(trim(p_label), ''), 'Eastudy Pro'), 100), p_duration_days, p_count, v_user)
  returning id into v_batch;

  for v_i in 1..p_count loop
    v_code := 'EAST-' || upper(substr(encode(extensions.gen_random_bytes(9), 'hex'), 1, 6)) || '-' ||
              upper(substr(encode(extensions.gen_random_bytes(9), 'hex'), 1, 6)) || '-' ||
              upper(substr(encode(extensions.gen_random_bytes(9), 'hex'), 1, 6));
    insert into private.activation_codes(batch_id, code_hash, duration_days, valid_until)
    values (v_batch, extensions.digest(convert_to(v_code, 'UTF8'), 'sha256'), p_duration_days, p_valid_until);
    code := v_code; duration_days := p_duration_days; valid_until := p_valid_until;
    return next;
  end loop;
end;
$$;

revoke all on function public.redeem_activation_code(text) from public, anon;
revoke all on function public.admin_generate_activation_codes(text, integer, integer, timestamptz) from public, anon;
grant execute on function public.redeem_activation_code(text) to authenticated;
grant execute on function public.admin_generate_activation_codes(text, integer, integer, timestamptz) to authenticated;

comment on table public.membership_entitlements is 'Server-authoritative Eastudy membership entitlements; clients have read-only access to their own row.';
comment on function public.redeem_activation_code(text) is 'Atomically redeems a hashed one-time activation code for the signed-in learner.';
