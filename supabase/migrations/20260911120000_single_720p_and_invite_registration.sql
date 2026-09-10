-- Eastudy single-rendition playback and invite-only account registration.
-- This migration removes non-720p references from database JSON only.
-- It intentionally does not delete Cloudflare R2 objects.

create schema if not exists private;
create extension if not exists pgcrypto with schema extensions;

create or replace function private.single_720_video(p_video jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_video jsonb := coalesce(p_video, '{}'::jsonb);
  v_playback jsonb := coalesce(v_video->'playback', '{}'::jsonb);
  v_variant jsonb;
  v_url text;
begin
  select value into v_variant
  from jsonb_array_elements(coalesce(v_playback->'variants', '[]'::jsonb)) value
  where lower(coalesce(value->>'label', '')) = '720p'
     or value->>'height' = '720'
     or value->>'path' ~ '(^|/)720p/index\.m3u8$'
  limit 1;

  v_url := nullif(v_variant->>'url', '');
  if v_url is null then
    v_url := regexp_replace(coalesce(v_playback->>'masterUrl', v_video->>'mediaUrl', ''),
                            'master\.m3u8([?#].*)?$', '720p/index.m3u8\1');
  end if;

  v_playback := (v_playback - 'original' - 'quality' - 'qualityOptions') ||
    jsonb_build_object(
      'policy', 'single-standard-v2',
      'masterUrl', v_url,
      'variants', case when v_variant is null then '[]'::jsonb else jsonb_build_array(v_variant - 'original') end
    );
  return (v_video - 'originalMediaUrl' - 'mediaVariants' - 'qualityOptions') ||
    jsonb_build_object('mediaUrl', v_url, 'playback', v_playback);
end;
$$;

create or replace function private.single_720_snapshot(p_snapshot jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_set(coalesce(p_snapshot, '{}'::jsonb), '{videos}',
    coalesce((select jsonb_agg(private.single_720_video(value) order by ordinal)
      from jsonb_array_elements(coalesce(p_snapshot->'videos', '[]'::jsonb))
        with ordinality as rows(value, ordinal)), '[]'::jsonb), true);
$$;

-- Refuse the destructive reference cleanup when a published video has no
-- verifiable 720p rendition.  The migration stays atomic, so no 480p/1080p
-- reference is removed when this guard raises.
do $$
declare
  v_missing text;
begin
  select string_agg(
    coalesce(nullif(video->>'id', ''), '<missing-id>') || ' (' ||
      coalesce(nullif(video->>'title', ''), 'untitled') || ')',
    ', ' order by coalesce(video->>'id', '')
  )
  into v_missing
  from private.content_snapshots snapshot
  cross join lateral jsonb_array_elements(
    coalesce(snapshot.published->'videos', '[]'::jsonb)
  ) video
  where snapshot.environment = 'production'
    and video->>'status' = 'PUBLISHED'
    and not (
      (
        nullif(video->>'processingJobId', '') is not null
        and exists (
          select 1
          from public.processing_jobs job
          join private.processing_output_receipts receipt on receipt.job_id = job.id
          where job.id::text = video->>'processingJobId'
            and receipt.path = '720p/index.m3u8'
        )
      )
      or (
        nullif(video->>'processingJobId', '') is null
        and (
          exists (
            select 1
            from jsonb_array_elements(
              coalesce(video->'playback'->'variants', '[]'::jsonb)
            ) variant
            where lower(coalesce(variant->>'label', '')) = '720p'
               or variant->>'height' = '720'
               or coalesce(variant->>'path', variant->>'url', '')
                 ~ '(^|/)720p/index\.m3u8([?#].*)?$'
          )
          or coalesce(video->'playback'->>'masterUrl', video->>'mediaUrl', '')
            ~ '(^|/)720p/index\.m3u8([?#].*)?$'
        )
      )
    );

  if v_missing is not null then
    raise exception using
      errcode = 'check_violation',
      message = 'SINGLE_720_PRECHECK_FAILED',
      detail = 'Published videos without a verified 720p rendition: ' || v_missing,
      hint = 'Reprocess these videos to 720p, then rerun this migration.';
  end if;
end;
$$;

update private.content_snapshots
set draft = private.single_720_snapshot(draft),
    published = private.single_720_snapshot(published),
    revision = revision + 1,
    updated_at = now()
where environment = 'production'
  and (draft is distinct from private.single_720_snapshot(draft)
    or published is distinct from private.single_720_snapshot(published));

update public.processing_jobs
set result = jsonb_set(
      jsonb_set(result, '{video}', private.single_720_video(result->'video'), true),
      '{evidence,mediaVariants}',
      coalesce((select jsonb_agg(value)
        from jsonb_array_elements(coalesce(result->'evidence'->'mediaVariants', '[]'::jsonb)) value
        where lower(coalesce(value->>'label', '')) = '720p'
           or value->>'height' = '720'
           or value->>'path' ~ '(^|/)720p/index\.m3u8$'), '[]'::jsonb), true),
    updated_at = now()
where result is not null
  and jsonb_typeof(result->'video') = 'object';

update private.content_video_trash
set payload = case
      when jsonb_typeof(payload#>'{draft,video}') = 'object'
        then jsonb_set(payload, '{draft,video}', private.single_720_video(payload#>'{draft,video}'), false)
      else payload end;
update private.content_video_trash
set payload = case
      when jsonb_typeof(payload#>'{published,video}') = 'object'
        then jsonb_set(payload, '{published,video}', private.single_720_video(payload#>'{published,video}'), false)
      else payload end;

delete from private.processing_output_receipts
where path ~ '^[0-9]{3,4}p/' and path !~ '^720p/';

create table if not exists private.account_identities (
  account_key text primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  auth_email text not null unique,
  created_at timestamptz not null default now(),
  constraint account_identity_key_valid check (account_key ~ '^[a-z0-9][a-z0-9._-]{3,31}$')
);

create table if not exists private.registration_attempts (
  id uuid primary key,
  account_key text not null,
  auth_email text not null unique,
  code_id uuid not null references private.activation_codes(id) on delete restrict,
  state text not null default 'RESERVED' check (state in ('RESERVED', 'COMPLETED', 'FAILED')),
  fence uuid not null default extensions.gen_random_uuid(),
  auth_user_id uuid references auth.users(id) on delete restrict,
  lease_until timestamptz not null,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists one_live_registration_per_account
on private.registration_attempts(account_key) where state = 'RESERVED';
create unique index if not exists one_live_registration_per_code
on private.registration_attempts(code_id) where state = 'RESERVED';

revoke all on table private.account_identities from public, anon, authenticated;
revoke all on table private.registration_attempts from public, anon, authenticated;

create or replace function public.mark_my_password_set()
returns void language sql security definer set search_path = '' as $$
  update public.profiles set has_password = true where id = auth.uid();
$$;

create or replace function public.mark_my_phone_verified()
returns void language sql security definer set search_path = '' as $$
  update public.profiles profile
  set phone_verified_at = coalesce(profile.phone_verified_at, auth_user.phone_confirmed_at),
      is_active = profile.is_active or auth_user.phone_confirmed_at is not null
  from auth.users auth_user
  where profile.id = auth.uid() and auth_user.id = profile.id
    and auth_user.phone_confirmed_at is not null;
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

  select * into v_attempt from private.registration_attempts where id = p_attempt_id for update;
  if found then
    if v_attempt.account_key <> v_account then raise exception 'ATTEMPT_MISMATCH'; end if;
    if v_attempt.state = 'COMPLETED' then
      return jsonb_build_object('attemptId', v_attempt.id, 'state', v_attempt.state,
        'authEmail', v_attempt.auth_email, 'fence', v_attempt.fence);
    end if;
    if v_attempt.state = 'RESERVED' and v_attempt.lease_until > now() then
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
  if not found or v_code.redeemed_by is not null
     or (v_code.valid_until is not null and v_code.valid_until <= now()) then
    raise exception 'INVITE_INVALID';
  end if;

  insert into private.registration_attempts(id, account_key, auth_email, code_id, lease_until)
  values (p_attempt_id, v_account,
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
    select expires_at into v_expires_at from public.membership_entitlements
    where user_id = v_attempt.auth_user_id and product_id = 'eastudy_pro';
    return jsonb_build_object('userId', v_attempt.auth_user_id, 'account', v_attempt.account_key,
      'expiresAt', v_expires_at, 'state', 'COMPLETED');
  end if;
  if v_attempt.state <> 'RESERVED' or v_attempt.lease_until <= now() then
    raise exception 'ATTEMPT_EXPIRED';
  end if;

  select email, raw_user_meta_data->>'registration_attempt_id'
  into v_auth_email, v_auth_attempt from auth.users where id = p_auth_user_id;
  if v_auth_email is distinct from v_attempt.auth_email
     or v_auth_attempt is distinct from v_attempt.id::text then
    raise exception 'AUTH_USER_MISMATCH';
  end if;

  select * into v_code from private.activation_codes where id = v_attempt.code_id for update;
  if not found or v_code.redeemed_by is not null
     or (v_code.valid_until is not null and v_code.valid_until <= now()) then
    raise exception 'INVITE_INVALID';
  end if;
  if not exists(select 1 from public.profiles where id = p_auth_user_id) then
    raise exception 'PROFILE_NOT_READY';
  end if;

  insert into private.account_identities(account_key, user_id, auth_email)
  values(v_attempt.account_key, p_auth_user_id, v_attempt.auth_email);

  update public.profiles set has_password = true, is_active = true
  where id = p_auth_user_id;

  insert into public.membership_entitlements as entitlement
    (user_id, product_id, expires_at, revoked_at, created_at, updated_at)
  values(p_auth_user_id, v_code.product_id,
    now() + make_interval(days => v_code.duration_days), null, now(), now())
  on conflict (user_id, product_id) do update set
    expires_at = greatest(now(), entitlement.expires_at) + make_interval(days => v_code.duration_days),
    updated_at = now()
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

create or replace function public.resolve_account_login(p_account text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when auth.role() = 'service_role' then
    coalesce((select jsonb_build_object('authEmail', identity.auth_email, 'userId', identity.user_id)
      from private.account_identities identity
      join public.profiles profile on profile.id = identity.user_id
      where identity.account_key = lower(trim(coalesce(p_account, ''))) and profile.is_active),
      '{}'::jsonb)
    else '{}'::jsonb end;
$$;

revoke all on function public.reserve_invite_registration(uuid,text,text) from public, anon, authenticated;
revoke all on function public.finalize_invite_registration(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.resolve_account_login(text) from public, anon, authenticated;
grant execute on function public.reserve_invite_registration(uuid,text,text) to service_role;
grant execute on function public.finalize_invite_registration(uuid,uuid,uuid) to service_role;
grant execute on function public.resolve_account_login(text) to service_role;

create or replace function public.admin_generate_activation_codes(
  p_label text, p_duration_days integer, p_count integer default 1,
  p_valid_until timestamptz default null
)
returns table(code text, duration_days integer, valid_until timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_batch uuid;
  v_raw text;
  v_i integer;
begin
  if v_user is null or not exists(select 1 from public.profiles profile
    where profile.id = v_user and lower(coalesce(profile.role, '')) = 'admin') then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if p_duration_days not between 1 and 3660 or p_count not between 1 and 100 then
    raise exception 'INVALID_GENERATION_PARAMETERS';
  end if;
  if p_valid_until is not null and p_valid_until <= now() then
    raise exception 'INVALID_GENERATION_PARAMETERS';
  end if;
  insert into private.activation_code_batches(label, duration_days, code_count, created_by)
  values(left(coalesce(nullif(trim(p_label), ''), '邀请码注册'), 100),
    p_duration_days, p_count, v_user) returning id into v_batch;
  for v_i in 1..p_count loop
    v_raw := upper(encode(extensions.gen_random_bytes(16), 'hex'));
    code := 'EAST-' || substring(v_raw from 1 for 8) || '-' ||
      substring(v_raw from 9 for 8) || '-' || substring(v_raw from 17 for 8) || '-' ||
      substring(v_raw from 25 for 8);
    insert into private.activation_codes(batch_id, code_hash, duration_days, valid_until)
    values(v_batch, extensions.digest(convert_to(code, 'UTF8'), 'sha256'),
      p_duration_days, p_valid_until);
    duration_days := p_duration_days;
    valid_until := p_valid_until;
    return next;
  end loop;
end;
$$;

revoke all on function public.admin_generate_activation_codes(text,integer,integer,timestamptz)
  from public, anon;
grant execute on function public.admin_generate_activation_codes(text,integer,integer,timestamptz)
  to authenticated;

comment on function private.single_720_video(jsonb) is
  'Removes non-720p database references; it does not delete R2 objects.';
comment on table private.registration_attempts is
  'Recoverable invite registration state across Auth HTTP and database transactions.';

create or replace function public.resolve_processing_media(p_job_id uuid, p_path text)
returns table(object_key text)
language sql
stable
security definer
set search_path = ''
as $$
  select 'videos/' || substring(job.source_key from '^videos/([0-9a-f-]{36})/') ||
    '/processed/' || job.id::text || '/' ||
    case when job.output_run_id is null then p_path
         else 'runs/' || job.output_run_id::text || '/' || p_path end
  from public.processing_jobs job
  where job.id = p_job_id and job.status = 'REVIEW'
    and p_path ~ '^(master\.m3u8|cover\.webp|720p/(index\.m3u8|segment_[0-9]{5}\.ts))$'
    and not exists(select 1 from private.content_video_trash trash
      where trash.environment = 'production' and trash.video_id = job.video_id
        and trash.restored_at is null)
    and (
      public.is_admin()
      or (
        exists(select 1 from private.content_snapshots snapshot,
          jsonb_array_elements(coalesce(snapshot.published->'videos', '[]'::jsonb)) video
          where snapshot.environment = 'production' and video->>'id' = job.video_id
            and video->>'status' = 'PUBLISHED')
        and exists(select 1 from public.profiles profile
          where profile.id = auth.uid() and profile.is_active)
        and exists(select 1 from public.membership_entitlements entitlement
          where entitlement.user_id = auth.uid() and entitlement.product_id = 'eastudy_pro'
            and entitlement.revoked_at is null and entitlement.expires_at > now())
      )
    );
$$;

revoke all on function public.resolve_processing_media(uuid,text) from public, anon;
grant execute on function public.resolve_processing_media(uuid,text) to authenticated;
