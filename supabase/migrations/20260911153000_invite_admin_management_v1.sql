-- Eastudy invite-code administration: secure listing, revocation, batch control,
-- one-time reissue and immutable admin audit. Raw invite codes remain write-only.

alter table private.activation_code_batches
  add column if not exists channel text not null default '',
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by uuid references auth.users(id) on delete set null;

alter table private.activation_codes
  add column if not exists code_hint text,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references auth.users(id) on delete set null,
  add column if not exists revoke_reason text;

create table if not exists private.activation_code_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (action in (
    'BATCH_CREATED', 'CODE_REVOKED', 'BATCH_DISABLED', 'BATCH_ENABLED', 'CODE_REISSUED'
  )),
  batch_id uuid references private.activation_code_batches(id) on delete set null,
  code_id uuid references private.activation_codes(id) on delete set null,
  reason text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activation_codes_admin_created_idx
  on private.activation_codes(created_at desc, id desc);
create index if not exists activation_codes_admin_batch_idx
  on private.activation_codes(batch_id, created_at desc);
create index if not exists activation_code_audit_created_idx
  on private.activation_code_audit(created_at desc, id desc);

revoke all on table private.activation_code_batches from public, anon, authenticated;
revoke all on table private.activation_codes from public, anon, authenticated;
revoke all on table private.activation_code_audit from public, anon, authenticated;

create or replace function public.admin_generate_activation_codes_v2(
  p_label text,
  p_duration_days integer,
  p_count integer default 1,
  p_valid_until timestamptz default null,
  p_channel text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_batch uuid;
  v_raw text;
  v_code text;
  v_code_id uuid;
  v_i integer;
  v_codes jsonb := '[]'::jsonb;
begin
  if v_user is null or public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_duration_days is null or p_duration_days not between 1 and 3660
     or p_count is null or p_count not between 1 and 100
     or length(btrim(coalesce(p_label, ''))) > 100
     or length(btrim(coalesce(p_channel, ''))) > 60
     or (p_valid_until is not null and p_valid_until <= now()) then
    raise exception 'INVALID_GENERATION_PARAMETERS' using errcode = '22023';
  end if;

  insert into private.activation_code_batches(
    label, product_id, duration_days, code_count, created_by, channel
  ) values (
    left(coalesce(nullif(btrim(p_label), ''), '邀请码注册'), 100),
    'eastudy_pro', p_duration_days, p_count, v_user,
    left(btrim(coalesce(p_channel, '')), 60)
  ) returning id into v_batch;

  for v_i in 1..p_count loop
    v_raw := upper(encode(extensions.gen_random_bytes(16), 'hex'));
    v_code := 'EAST-' || substring(v_raw from 1 for 8) || '-' ||
      substring(v_raw from 9 for 8) || '-' || substring(v_raw from 17 for 8) || '-' ||
      substring(v_raw from 25 for 8);
    insert into private.activation_codes(
      batch_id, code_hash, code_hint, product_id, duration_days, valid_until
    ) values (
      v_batch, extensions.digest(convert_to(v_code, 'UTF8'), 'sha256'),
      right(v_code, 4), 'eastudy_pro', p_duration_days, p_valid_until
    ) returning id into v_code_id;
    v_codes := v_codes || jsonb_build_array(jsonb_build_object(
      'id', v_code_id, 'code', v_code, 'codeHint', right(v_code, 4),
      'durationDays', p_duration_days, 'validUntil', p_valid_until
    ));
  end loop;

  insert into private.activation_code_audit(actor_id, action, batch_id, details)
  values(v_user, 'BATCH_CREATED', v_batch, jsonb_build_object(
    'label', left(coalesce(nullif(btrim(p_label), ''), '邀请码注册'), 100),
    'channel', left(btrim(coalesce(p_channel, '')), 60),
    'durationDays', p_duration_days, 'count', p_count, 'validUntil', p_valid_until
  ));

  return jsonb_build_object('batchId', v_batch, 'codes', v_codes);
end;
$$;

create or replace function public.admin_list_activation_codes_v1(
  p_query text default '',
  p_status text default 'all',
  p_page integer default 1,
  p_page_size integer default 25,
  p_batch_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_result jsonb;
begin
  if auth.uid() is null or public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_page is null or p_page not between 1 and 100000
     or p_page_size is null or p_page_size not between 1 and 100
     or length(v_query) > 100
     or p_status is null
     or p_status not in ('all', 'available', 'reserved', 'used', 'expired', 'revoked') then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;

  with base as (
    select code.id, code.batch_id, code.code_hint, code.duration_days,
      code.valid_until, code.created_at, code.redeemed_by, code.redeemed_at,
      code.revoked_at, code.revoke_reason,
      batch.label, batch.channel, batch.disabled_at,
      profile.phone as redeemed_phone, profile.nickname as redeemed_nickname,
      redemption.entitlement_expires_at,
      case
        when code.redeemed_by is not null then 'used'
        when code.revoked_at is not null or batch.disabled_at is not null then 'revoked'
        when code.valid_until is not null and code.valid_until <= v_now then 'expired'
        when reservation.id is not null then 'reserved'
        else 'available'
      end as status
    from private.activation_codes code
    join private.activation_code_batches batch on batch.id = code.batch_id
    left join public.profiles profile on profile.id = code.redeemed_by
    left join private.membership_redemptions redemption on redemption.code_id = code.id
    left join lateral (
      select attempt.id
      from private.registration_attempts attempt
      where attempt.code_id = code.id and attempt.state = 'RESERVED'
        and attempt.lease_until > v_now
      limit 1
    ) reservation on true
    where (p_batch_id is null or code.batch_id = p_batch_id)
      and (v_query = ''
        or strpos(lower(batch.label), v_query) > 0
        or strpos(lower(batch.channel), v_query) > 0
        or strpos(lower(coalesce(code.code_hint, '')), v_query) > 0
        or strpos(lower(coalesce(profile.phone, '')), v_query) > 0
        or strpos(lower(coalesce(profile.nickname, '')), v_query) > 0)
  ), filtered as (
    select * from base where p_status = 'all' or status = p_status
  ), page_rows as (
    select * from filtered
    order by created_at desc, id desc
    limit p_page_size offset ((p_page::bigint - 1) * p_page_size)
  ), batch_rows as (
    select batch.id, batch.label, batch.channel, batch.duration_days,
      batch.code_count, batch.created_at, batch.disabled_at,
      count(code.id) filter(where code.redeemed_by is null
        and code.revoked_at is null and batch.disabled_at is null
        and (code.valid_until is null or code.valid_until > v_now)
        and not exists(select 1 from private.registration_attempts attempt
          where attempt.code_id = code.id and attempt.state = 'RESERVED'
            and attempt.lease_until > v_now)) as available_count,
      count(code.id) filter(where code.redeemed_by is not null) as used_count
    from private.activation_code_batches batch
    left join private.activation_codes code on code.batch_id = batch.id
    group by batch.id
    order by batch.created_at desc
    limit 100
  )
  select jsonb_build_object(
    'serverTime', v_now,
    'page', p_page,
    'pageSize', p_page_size,
    'total', (select count(*) from filtered),
    'stats', jsonb_build_object(
      'all', (select count(*) from base),
      'available', (select count(*) from base where status = 'available'),
      'reserved', (select count(*) from base where status = 'reserved'),
      'used', (select count(*) from base where status = 'used'),
      'expired', (select count(*) from base where status = 'expired'),
      'revoked', (select count(*) from base where status = 'revoked')
    ),
    'batches', coalesce((select jsonb_agg(jsonb_build_object(
      'id', row.id, 'label', row.label, 'channel', row.channel,
      'durationDays', row.duration_days, 'codeCount', row.code_count,
      'availableCount', row.available_count, 'usedCount', row.used_count,
      'createdAt', row.created_at, 'disabledAt', row.disabled_at
    ) order by row.created_at desc) from batch_rows row), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', item.id, 'batchId', item.batch_id,
      'codeHint', item.code_hint, 'label', item.label, 'channel', item.channel,
      'durationDays', item.duration_days, 'validUntil', item.valid_until,
      'createdAt', item.created_at, 'status', item.status,
      'redeemedBy', item.redeemed_by, 'redeemedAt', item.redeemed_at,
      'redeemedPhone', item.redeemed_phone,
      'redeemedNickname', item.redeemed_nickname,
      'entitlementExpiresAt', item.entitlement_expires_at,
      'revokedAt', item.revoked_at, 'revokeReason', item.revoke_reason,
      'batchDisabledAt', item.disabled_at
    ) order by item.created_at desc, item.id desc) from page_rows item), '[]'::jsonb),
    'audit', coalesce((select jsonb_agg(jsonb_build_object(
      'id', audit.id, 'action', audit.action, 'reason', audit.reason,
      'details', audit.details, 'createdAt', audit.created_at,
      'actorName', actor.nickname, 'actorPhone', actor.phone,
      'batchId', audit.batch_id, 'codeId', audit.code_id
    ) order by audit.created_at desc, audit.id desc)
      from (select * from private.activation_code_audit order by created_at desc, id desc limit 30) audit
      left join public.profiles actor on actor.id = audit.actor_id), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.admin_revoke_activation_code_v1(
  p_code_id uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_code private.activation_codes%rowtype;
begin
  if v_user is null or public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_code_id is null or length(btrim(coalesce(p_reason, ''))) > 200 then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;
  select * into v_code from private.activation_codes where id = p_code_id for update;
  if not found then raise exception 'CODE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_code.redeemed_by is not null then raise exception 'CODE_ALREADY_USED'; end if;
  if exists(select 1 from private.registration_attempts attempt
    where attempt.code_id = p_code_id and attempt.state = 'RESERVED'
      and attempt.lease_until > now()) then
    raise exception 'CODE_RESERVED';
  end if;
  if v_code.revoked_at is null then
    update private.activation_codes set revoked_at = now(), revoked_by = v_user,
      revoke_reason = left(btrim(coalesce(p_reason, '')), 200)
    where id = p_code_id;
    insert into private.activation_code_audit(actor_id, action, batch_id, code_id, reason)
    values(v_user, 'CODE_REVOKED', v_code.batch_id, p_code_id,
      left(btrim(coalesce(p_reason, '')), 200));
  end if;
  return jsonb_build_object('id', p_code_id, 'status', 'revoked');
end;
$$;

create or replace function public.admin_set_activation_batch_disabled_v1(
  p_batch_id uuid,
  p_disabled boolean,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_batch private.activation_code_batches%rowtype;
begin
  if v_user is null or public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_batch_id is null or p_disabled is null
     or length(btrim(coalesce(p_reason, ''))) > 200 then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;
  select * into v_batch from private.activation_code_batches where id = p_batch_id for update;
  if not found then raise exception 'BATCH_NOT_FOUND' using errcode = 'P0002'; end if;
  update private.activation_code_batches
  set disabled_at = case when p_disabled then coalesce(disabled_at, now()) else null end,
      disabled_by = case when p_disabled then v_user else null end
  where id = p_batch_id;
  insert into private.activation_code_audit(actor_id, action, batch_id, reason)
  values(v_user, case when p_disabled then 'BATCH_DISABLED' else 'BATCH_ENABLED' end,
    p_batch_id, left(btrim(coalesce(p_reason, '')), 200));
  return jsonb_build_object('id', p_batch_id,
    'status', case when p_disabled then 'disabled' else 'active' end);
end;
$$;

create or replace function public.admin_reissue_activation_code_v1(
  p_code_id uuid,
  p_valid_until timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_code private.activation_codes%rowtype;
  v_batch private.activation_code_batches%rowtype;
  v_new_batch uuid;
  v_new_code_id uuid;
  v_raw text;
  v_new_code text;
  v_until timestamptz := coalesce(p_valid_until, now() + interval '30 days');
begin
  if v_user is null or public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_code_id is null or v_until <= now() then
    raise exception 'INVALID_ARGUMENT' using errcode = '22023';
  end if;
  select * into v_code from private.activation_codes where id = p_code_id for update;
  if not found then raise exception 'CODE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_code.redeemed_by is not null then raise exception 'CODE_ALREADY_USED'; end if;
  if exists(select 1 from private.registration_attempts attempt
    where attempt.code_id = p_code_id and attempt.state = 'RESERVED'
      and attempt.lease_until > now()) then
    raise exception 'CODE_RESERVED';
  end if;
  select * into v_batch from private.activation_code_batches where id = v_code.batch_id;

  update private.activation_codes set revoked_at = coalesce(revoked_at, now()),
    revoked_by = coalesce(revoked_by, v_user),
    revoke_reason = coalesce(nullif(revoke_reason, ''), '已补发新邀请码')
  where id = p_code_id;

  insert into private.activation_code_batches(
    label, product_id, duration_days, code_count, created_by, channel
  ) values (
    left(v_batch.label || ' · 补发', 100), v_code.product_id,
    v_code.duration_days, 1, v_user, v_batch.channel
  ) returning id into v_new_batch;

  v_raw := upper(encode(extensions.gen_random_bytes(16), 'hex'));
  v_new_code := 'EAST-' || substring(v_raw from 1 for 8) || '-' ||
    substring(v_raw from 9 for 8) || '-' || substring(v_raw from 17 for 8) || '-' ||
    substring(v_raw from 25 for 8);
  insert into private.activation_codes(
    batch_id, code_hash, code_hint, product_id, duration_days, valid_until
  ) values (
    v_new_batch, extensions.digest(convert_to(v_new_code, 'UTF8'), 'sha256'),
    right(v_new_code, 4), v_code.product_id, v_code.duration_days, v_until
  ) returning id into v_new_code_id;

  insert into private.activation_code_audit(actor_id, action, batch_id, code_id, details)
  values(v_user, 'CODE_REISSUED', v_new_batch, v_new_code_id,
    jsonb_build_object('replacesCodeId', p_code_id, 'validUntil', v_until));

  return jsonb_build_object(
    'batchId', v_new_batch,
    'code', jsonb_build_object(
      'id', v_new_code_id, 'code', v_new_code, 'codeHint', right(v_new_code, 4),
      'durationDays', v_code.duration_days, 'validUntil', v_until
    )
  );
end;
$$;

revoke all on function public.admin_generate_activation_codes_v2(text,integer,integer,timestamptz,text)
  from public, anon;
revoke all on function public.admin_list_activation_codes_v1(text,text,integer,integer,uuid)
  from public, anon;
revoke all on function public.admin_revoke_activation_code_v1(uuid,text)
  from public, anon;
revoke all on function public.admin_set_activation_batch_disabled_v1(uuid,boolean,text)
  from public, anon;
revoke all on function public.admin_reissue_activation_code_v1(uuid,timestamptz)
  from public, anon;

grant execute on function public.admin_generate_activation_codes_v2(text,integer,integer,timestamptz,text)
  to authenticated;
grant execute on function public.admin_list_activation_codes_v1(text,text,integer,integer,uuid)
  to authenticated;
grant execute on function public.admin_revoke_activation_code_v1(uuid,text)
  to authenticated;
grant execute on function public.admin_set_activation_batch_disabled_v1(uuid,boolean,text)
  to authenticated;
grant execute on function public.admin_reissue_activation_code_v1(uuid,timestamptz)
  to authenticated;

comment on table private.activation_code_audit is
  'Immutable administrator audit trail for invite-code lifecycle changes.';
comment on function public.admin_list_activation_codes_v1(text,text,integer,integer,uuid) is
  'Admin-only masked invite-code inventory, batches, status counts and recent audit.';

-- Enforce revocation and batch state in both existing-member redemption and
-- account-registration redemption. These replace compatible earlier functions.
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
  on conflict (user_id, product_id) do update set
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

create or replace function public.reserve_invite_registration(
  p_attempt_id uuid, p_account text, p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account text := lower(trim(coalesce(p_account, '')));
  v_normalized_code text := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'));
  v_code private.activation_codes%rowtype;
  v_attempt private.registration_attempts%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_attempt_id is null or v_account !~ '^[a-z0-9][a-z0-9._-]{3,31}$' then
    raise exception 'ACCOUNT_INVALID';
  end if;
  if length(v_normalized_code) < 12 or length(v_normalized_code) > 80 then
    raise exception 'INVITE_INVALID';
  end if;
  select * into v_attempt from private.registration_attempts
  where id = p_attempt_id for update;
  if found then
    if v_attempt.account_key <> v_account then raise exception 'ATTEMPT_MISMATCH'; end if;
    if v_attempt.state = 'COMPLETED' then
      return jsonb_build_object('attemptId', v_attempt.id, 'state', v_attempt.state,
        'authEmail', v_attempt.auth_email, 'fence', v_attempt.fence);
    end if;
    if v_attempt.state = 'RESERVED' and v_attempt.lease_until > now() then
      select * into v_code from private.activation_codes where id = v_attempt.code_id for update;
      if not found
         or v_code.code_hash <> extensions.digest(convert_to(v_normalized_code, 'UTF8'), 'sha256')
         or v_code.revoked_at is not null
         or (v_code.valid_until is not null and v_code.valid_until <= now())
         or exists(select 1 from private.activation_code_batches batch
           where batch.id = v_code.batch_id and batch.disabled_at is not null) then
        raise exception 'ATTEMPT_MISMATCH';
      end if;
      return jsonb_build_object('attemptId', v_attempt.id, 'state', v_attempt.state,
        'authEmail', v_attempt.auth_email, 'fence', v_attempt.fence);
    end if;
    raise exception 'ATTEMPT_EXPIRED';
  end if;
  update private.registration_attempts set state = 'FAILED', error_code = 'LEASE_EXPIRED'
  where state = 'RESERVED' and lease_until <= now();
  if exists(select 1 from private.account_identities where account_key = v_account) then
    raise exception 'ACCOUNT_EXISTS';
  end if;
  select * into v_code from private.activation_codes
  where code_hash = extensions.digest(convert_to(v_normalized_code, 'UTF8'), 'sha256')
  for update;
  if not found or v_code.redeemed_by is not null or v_code.revoked_at is not null
     or (v_code.valid_until is not null and v_code.valid_until <= now())
     or exists(select 1 from private.activation_code_batches batch
       where batch.id = v_code.batch_id and batch.disabled_at is not null) then
    raise exception 'INVITE_INVALID';
  end if;
  insert into private.registration_attempts(id, account_key, auth_email, code_id, lease_until)
  values(p_attempt_id, v_account,
    'u-' || replace(p_attempt_id::text, '-', '') || '@accounts.eastudy.invalid',
    v_code.id, now() + interval '15 minutes')
  returning * into v_attempt;
  return jsonb_build_object('attemptId', v_attempt.id, 'state', v_attempt.state,
    'authEmail', v_attempt.auth_email, 'fence', v_attempt.fence);
end;
$$;

create or replace function public.finalize_invite_registration(
  p_attempt_id uuid, p_fence uuid, p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt private.registration_attempts%rowtype;
  v_code private.activation_codes%rowtype;
  v_expires_at timestamptz;
  v_auth_email text;
  v_auth_attempt text;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into v_attempt from private.registration_attempts where id = p_attempt_id for update;
  if not found or v_attempt.fence <> p_fence then raise exception 'ATTEMPT_INVALID'; end if;
  if v_attempt.state = 'COMPLETED' then
    select entitlement.expires_at into v_expires_at
    from public.membership_entitlements entitlement
    where entitlement.user_id = v_attempt.auth_user_id and entitlement.product_id = 'eastudy_pro';
    return jsonb_build_object('userId', v_attempt.auth_user_id, 'account', v_attempt.account_key,
      'expiresAt', v_expires_at, 'state', 'COMPLETED');
  end if;
  if v_attempt.state <> 'RESERVED' or v_attempt.lease_until <= now() then
    raise exception 'ATTEMPT_EXPIRED';
  end if;
  select auth_user.email, auth_user.raw_user_meta_data->>'registration_attempt_id'
  into v_auth_email, v_auth_attempt from auth.users auth_user where auth_user.id = p_auth_user_id;
  if v_auth_email is distinct from v_attempt.auth_email
     or v_auth_attempt is distinct from v_attempt.id::text then
    raise exception 'AUTH_USER_MISMATCH';
  end if;
  select * into v_code from private.activation_codes where id = v_attempt.code_id for update;
  if not found or v_code.redeemed_by is not null or v_code.revoked_at is not null
     or (v_code.valid_until is not null and v_code.valid_until <= now())
     or exists(select 1 from private.activation_code_batches batch
       where batch.id = v_code.batch_id and batch.disabled_at is not null) then
    raise exception 'INVITE_INVALID';
  end if;
  if not exists(select 1 from public.profiles where id = p_auth_user_id) then
    raise exception 'PROFILE_NOT_READY';
  end if;
  insert into private.account_identities(account_key, user_id, auth_email)
  values(v_attempt.account_key, p_auth_user_id, v_attempt.auth_email);
  update public.profiles set has_password = true, is_active = true where id = p_auth_user_id;
  insert into public.membership_entitlements as entitlement
    (user_id, product_id, expires_at, revoked_at, created_at, updated_at)
  values(p_auth_user_id, v_code.product_id,
    now() + make_interval(days => v_code.duration_days), null, now(), now())
  on conflict (user_id, product_id) do update set
    expires_at = greatest(now(), entitlement.expires_at) + make_interval(days => v_code.duration_days),
    revoked_at = null, updated_at = now()
  returning expires_at into v_expires_at;
  update private.activation_codes set redeemed_by = p_auth_user_id, redeemed_at = now()
  where id = v_code.id;
  insert into private.membership_redemptions
    (code_id, user_id, product_id, duration_days, entitlement_expires_at)
  values(v_code.id, p_auth_user_id, v_code.product_id, v_code.duration_days, v_expires_at);
  update private.registration_attempts set state = 'COMPLETED', auth_user_id = p_auth_user_id,
    completed_at = now() where id = v_attempt.id;
  return jsonb_build_object('userId', p_auth_user_id, 'account', v_attempt.account_key,
    'expiresAt', v_expires_at, 'durationDays', v_code.duration_days, 'state', 'COMPLETED');
end;
$$;

revoke all on function public.redeem_activation_code(text) from public, anon;
revoke all on function public.reserve_invite_registration(uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.finalize_invite_registration(uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.redeem_activation_code(text) to authenticated;
grant execute on function public.reserve_invite_registration(uuid,text,text) to service_role;
grant execute on function public.finalize_invite_registration(uuid,uuid,uuid) to service_role;
