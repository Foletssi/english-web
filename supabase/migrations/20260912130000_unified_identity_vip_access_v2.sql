-- Eastudy unified login identity, learning access and playback authorization v2.
-- Forward-only: this migration does not remove users, learning data, jobs or R2 objects.

create schema if not exists private;

create or replace function private.canonical_login_key(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_input text := coalesce(p_value, '');
  v_raw text;
  v_compact text;
begin
  if v_input ~ ('[^ -~' || chr(9) || chr(13) || chr(10) || ']') then return null; end if;
  v_raw := lower(regexp_replace(v_input, '^[ ' || chr(9) || chr(13) || chr(10) || ']+|[ ' || chr(9) || chr(13) || chr(10) || ']+$', '', 'g'));
  if v_raw = '' or length(v_raw) > 128 then return null; end if;
  v_compact := regexp_replace(v_raw, '[ ' || chr(9) || chr(13) || chr(10) || '()-]', '', 'g');
  if v_compact ~ '^1[0-9]{10}$' then return v_compact; end if;
  if v_compact ~ '^861[0-9]{10}$' then return substr(v_compact, 3); end if;
  if v_compact ~ '^\+861[0-9]{10}$' then return substr(v_compact, 4); end if;
  if v_compact ~ '^\+[1-9][0-9]{7,14}$' then return v_compact; end if;
  if v_raw ~ '^[a-z0-9][a-z0-9._-]{3,31}$' then return v_raw; end if;
  return null;
end;
$$;

create table private.login_identifiers (
  login_key text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint login_identifier_is_canonical check (
    private.canonical_login_key(login_key) is not null
    and login_key = private.canonical_login_key(login_key)
  )
);
create index login_identifiers_user_idx on private.login_identifiers(user_id);
revoke all on table private.login_identifiers from public, anon, authenticated;
revoke all on function private.canonical_login_key(text) from public, anon, authenticated;

do $$
declare v_conflicts text;
begin
  with candidates as (
    select private.canonical_login_key(i.account_key) login_key, i.user_id
    from private.account_identities i
    union all
    select private.canonical_login_key(u.phone), u.id
    from auth.users u where nullif(u.phone, '') is not null
  ), conflicts as (
    select login_key, count(distinct user_id) user_count
    from candidates group by login_key
    having login_key is null or count(distinct user_id) > 1
  )
  select string_agg(coalesce(login_key, '<invalid>') || ':' || user_count, ', ' order by login_key)
  into v_conflicts from conflicts;
  if v_conflicts is not null then
    raise exception using errcode = '23505', message = 'LOGIN_IDENTIFIER_CONFLICT', detail = v_conflicts;
  end if;
end;
$$;

insert into private.login_identifiers(login_key, user_id)
select login_key, min(user_id::text)::uuid
from (
  select private.canonical_login_key(i.account_key) login_key, i.user_id
  from private.account_identities i
  union all
  select private.canonical_login_key(u.phone), u.id
  from auth.users u where nullif(u.phone, '') is not null
) candidates
where login_key is not null
group by login_key
on conflict (login_key) do update set user_id = excluded.user_id
where private.login_identifiers.user_id = excluded.user_id;

create or replace function private.learning_access_v2(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case
    when p_user_id is null then jsonb_build_object('canEnterLearning',false,'canPlay',false,'reason','AUTH_REQUIRED','kind','NONE')
    when not exists(select 1 from public.profiles p where p.id=p_user_id and p.is_active is true)
      then jsonb_build_object('canEnterLearning',false,'canPlay',false,'reason','ACCOUNT_UNAVAILABLE','kind','NONE')
    when exists(
      select 1 from private.admin_memberships m where m.user_id=p_user_id and m.status='active'
      union all
      select 1 from public.profiles p where p.id=p_user_id and lower(coalesce(p.role,''))='admin' and p.is_active is true
    ) then jsonb_build_object('canEnterLearning',true,'canPlay',true,'reason','OK','kind','ADMIN','expiresAt',null)
    when exists(select 1 from public.membership_entitlements e where e.user_id=p_user_id and e.product_id='eastudy_pro' and e.revoked_at is not null)
      then jsonb_build_object('canEnterLearning',false,'canPlay',false,'reason','VIP_REVOKED','kind','LEARNER',
        'expiresAt',(select e.expires_at from public.membership_entitlements e where e.user_id=p_user_id and e.product_id='eastudy_pro'))
    when not exists(select 1 from public.membership_entitlements e where e.user_id=p_user_id and e.product_id='eastudy_pro')
      then jsonb_build_object('canEnterLearning',false,'canPlay',false,'reason','VIP_REQUIRED','kind','LEARNER','expiresAt',null)
    when exists(select 1 from public.membership_entitlements e where e.user_id=p_user_id and e.product_id='eastudy_pro' and e.expires_at<=now())
      then jsonb_build_object('canEnterLearning',false,'canPlay',false,'reason','VIP_EXPIRED','kind','LEARNER',
        'expiresAt',(select e.expires_at from public.membership_entitlements e where e.user_id=p_user_id and e.product_id='eastudy_pro'))
    else jsonb_build_object('canEnterLearning',true,'canPlay',true,'reason','OK','kind','LEARNER',
      'expiresAt',(select e.expires_at from public.membership_entitlements e where e.user_id=p_user_id and e.product_id='eastudy_pro'))
  end;
$$;
revoke all on function private.learning_access_v2(uuid) from public, anon, authenticated;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null
    and exists(select 1 from public.profiles p where p.id=auth.uid() and p.is_active is true)
    and (
      exists(select 1 from private.admin_memberships m where m.user_id=auth.uid() and m.status='active')
      or exists(select 1 from public.profiles p where p.id=auth.uid() and lower(coalesce(p.role,''))='admin')
    );
$$;

create or replace function public.get_my_learning_access_v2()
returns jsonb language sql stable security definer set search_path='' as $$
  select private.learning_access_v2(auth.uid());
$$;

create or replace function public.has_learning_access_v2()
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((private.learning_access_v2(auth.uid())->>'canEnterLearning')::boolean,false);
$$;

create or replace function public.service_get_user_learning_access_v2(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  return private.learning_access_v2(p_user_id);
end;
$$;

create or replace function public.resolve_account_login_v2(p_account text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_key text:=private.canonical_login_key(p_account); v_user uuid; v_profile public.profiles%rowtype; v_auth auth.users%rowtype; v_email text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if v_key is null then return jsonb_build_object('state','NOT_FOUND'); end if;
  select i.user_id into v_user from private.login_identifiers i where i.login_key=v_key;
  if v_user is null then return jsonb_build_object('state','NOT_FOUND'); end if;
  select * into v_profile from public.profiles p where p.id=v_user;
  if not found or v_profile.is_active is distinct from true then
    return jsonb_build_object('state','DISABLED');
  end if;
  select * into v_auth from auth.users u where u.id=v_user;
  if not found or v_auth.banned_until is not null and v_auth.banned_until>now() then
    return jsonb_build_object('state','DISABLED');
  end if;
  select i.auth_email into v_email from private.account_identities i where i.user_id=v_user;
  v_email:=coalesce(nullif(v_email,''),nullif(v_auth.email,''));
  if v_email is not null then
    return jsonb_build_object('state','FOUND','userId',v_user,'identity',jsonb_build_object('email',v_email));
  end if;
  if nullif(v_auth.phone,'') is not null then
    return jsonb_build_object('state','FOUND','userId',v_user,'identity',jsonb_build_object('phone',
      case when v_auth.phone like '+%' then v_auth.phone else '+'||v_auth.phone end));
  end if;
  return jsonb_build_object('state','IDENTITY_UNAVAILABLE','userId',v_user);
end;
$$;

create or replace function public.get_published_content()
returns table(snapshot jsonb, revision bigint, published_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare v_access jsonb:=private.learning_access_v2(auth.uid());
begin
  if coalesce((v_access->>'canEnterLearning')::boolean,false) is not true then
    raise exception '%',coalesce(v_access->>'reason','ACCESS_DENIED') using errcode='42501';
  end if;
  return query select c.published,c.revision,c.published_at from private.content_snapshots c where c.environment='production';
end;
$$;

create or replace function public.resolve_processing_media(p_job_id uuid,p_path text)
returns table(object_key text) language sql stable security definer set search_path='' as $$
  select 'videos/'||substring(job.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||job.id::text||'/'||
    case when job.output_run_id is null then p_path else 'runs/'||job.output_run_id::text||'/'||p_path end
  from public.processing_jobs job
  where job.id=p_job_id and job.status='REVIEW'
    and p_path ~ '^(master\.m3u8|cover\.webp|720p/(index\.m3u8|segment_[0-9]{5}\.ts))$'
    and not exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=job.video_id and t.restored_at is null)
    and coalesce((private.learning_access_v2(auth.uid())->>'canPlay')::boolean,false)
    and exists(select 1 from private.content_snapshots c,jsonb_array_elements(coalesce(c.published->'videos','[]'::jsonb)) v
      where c.environment='production' and v->>'id'=job.video_id and v->>'status'='PUBLISHED');
$$;

create or replace function public.service_resolve_playback_access_v2(p_user_id uuid,p_job_id uuid,p_path text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_access jsonb; v_key text; v_job public.processing_jobs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_access:=private.learning_access_v2(p_user_id);
  if coalesce((v_access->>'canPlay')::boolean,false) is not true then return v_access; end if;
  if p_path !~ '^720p/(index\.m3u8|segment_[0-9]{5}\.ts)$' then return jsonb_build_object('canPlay',false,'reason','MEDIA_PATH_INVALID'); end if;
  select * into v_job from public.processing_jobs j where j.id=p_job_id and j.status='REVIEW';
  if not found or exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=v_job.video_id and t.restored_at is null)
    or not exists(select 1 from private.content_snapshots c,jsonb_array_elements(coalesce(c.published->'videos','[]'::jsonb)) v
      where c.environment='production' and v->>'id'=v_job.video_id and v->>'status'='PUBLISHED') then
    return jsonb_build_object('canPlay',false,'reason','PLAYBACK_FORBIDDEN');
  end if;
  v_key:='videos/'||substring(v_job.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||v_job.id::text||'/'||
    case when v_job.output_run_id is null then p_path else 'runs/'||v_job.output_run_id::text||'/'||p_path end;
  return v_access||jsonb_build_object('canPlay',true,'objectKey',v_key,'prefix',left(v_key,length(v_key)-length(p_path)));
end;
$$;

create or replace function public.redeem_activation_code(p_code text)
returns table(product_id text,expires_at timestamptz,revoked_at timestamptz,updated_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_profile public.profiles%rowtype; v_normalized text; v_code private.activation_codes%rowtype; v_entitlement public.membership_entitlements%rowtype;
begin
  if v_user is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_profile from public.profiles p where p.id=v_user for update;
  if not found or v_profile.is_active is distinct from true then raise exception 'ACCOUNT_UNAVAILABLE'; end if;
  if lower(coalesce(v_profile.role,''))='admin' or exists(select 1 from private.admin_memberships m where m.user_id=v_user and m.status='active') then
    raise exception 'ADMIN_NO_REDEMPTION_REQUIRED';
  end if;
  if lower(coalesce(v_profile.role,'')) not in ('learner','student') then raise exception 'ACCOUNT_UNAVAILABLE'; end if;
  if exists(select 1 from public.membership_entitlements e where e.user_id=v_user and e.product_id='eastudy_pro' and e.revoked_at is not null) then raise exception 'VIP_REVOKED'; end if;
  v_normalized:=upper(regexp_replace(coalesce(p_code,''),'\s+','','g'));
  if length(v_normalized)<12 or length(v_normalized)>80 then raise exception 'ACTIVATION_CODE_INVALID'; end if;
  select * into v_code from private.activation_codes c where c.code_hash=extensions.digest(convert_to(v_normalized,'UTF8'),'sha256') for update;
  if not found then raise exception 'ACTIVATION_CODE_INVALID'; end if;
  if v_code.revoked_at is not null or exists(select 1 from private.activation_code_batches b where b.id=v_code.batch_id and b.disabled_at is not null) then raise exception 'ACTIVATION_CODE_REVOKED'; end if;
  if v_code.valid_until is not null and v_code.valid_until<=now() then raise exception 'ACTIVATION_CODE_EXPIRED'; end if;
  if v_code.redeemed_by is not null then
    if v_code.redeemed_by<>v_user then raise exception 'ACTIVATION_CODE_USED'; end if;
    select * into v_entitlement from public.membership_entitlements e where e.user_id=v_user and e.product_id=v_code.product_id;
    if not found then raise exception 'ACTIVATION_STATE_INVALID'; end if;
    return query select v_entitlement.product_id,v_entitlement.expires_at,v_entitlement.revoked_at,v_entitlement.updated_at; return;
  end if;
  insert into public.membership_entitlements as e(user_id,product_id,expires_at,revoked_at,created_at,updated_at)
  values(v_user,v_code.product_id,now()+make_interval(days=>v_code.duration_days),null,now(),now())
  on conflict on constraint membership_entitlements_pkey do update set
    expires_at=greatest(now(),e.expires_at)+make_interval(days=>v_code.duration_days),updated_at=now()
  returning e.* into v_entitlement;
  update private.activation_codes set redeemed_by=v_user,redeemed_at=now() where id=v_code.id and redeemed_by is null;
  if not found then raise exception 'ACTIVATION_CODE_USED'; end if;
  insert into private.membership_redemptions(code_id,user_id,product_id,duration_days,entitlement_expires_at)
  values(v_code.id,v_user,v_code.product_id,v_code.duration_days,v_entitlement.expires_at);
  return query select v_entitlement.product_id,v_entitlement.expires_at,v_entitlement.revoked_at,v_entitlement.updated_at;
end;
$$;

create or replace function public.reserve_invite_registration(p_attempt_id uuid,p_account text,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_account text:=private.canonical_login_key(p_account); v_code private.activation_codes%rowtype; v_attempt private.registration_attempts%rowtype; v_normalized text:=upper(regexp_replace(coalesce(p_code,''),'\s+','','g'));
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_attempt_id is null or v_account is null then raise exception 'ACCOUNT_INVALID'; end if;
  if length(v_normalized)<12 or length(v_normalized)>80 then raise exception 'INVITE_INVALID'; end if;
  select * into v_attempt from private.registration_attempts where id=p_attempt_id for update;
  if found then
    if v_attempt.account_key<>v_account then raise exception 'ATTEMPT_MISMATCH'; end if;
    if v_attempt.state='COMPLETED' or (v_attempt.state='RESERVED' and v_attempt.lease_until>now()) then
      return jsonb_build_object('attemptId',v_attempt.id,'state',v_attempt.state,'authEmail',v_attempt.auth_email,'fence',v_attempt.fence);
    end if;
    raise exception 'ATTEMPT_EXPIRED';
  end if;
  update private.registration_attempts set state='FAILED',error_code='LEASE_EXPIRED' where state='RESERVED' and lease_until<=now();
  if exists(select 1 from private.login_identifiers i where i.login_key=v_account) then raise exception 'ACCOUNT_EXISTS'; end if;
  select * into v_code from private.activation_codes c where c.code_hash=extensions.digest(convert_to(v_normalized,'UTF8'),'sha256') for update;
  if not found or v_code.redeemed_by is not null or v_code.revoked_at is not null or (v_code.valid_until is not null and v_code.valid_until<=now())
    or exists(select 1 from private.activation_code_batches b where b.id=v_code.batch_id and b.disabled_at is not null) then raise exception 'INVITE_INVALID'; end if;
  insert into private.registration_attempts(id,account_key,auth_email,code_id,lease_until)
  values(p_attempt_id,v_account,'u-'||replace(p_attempt_id::text,'-','')||'@accounts.eastudy.invalid',v_code.id,now()+interval '15 minutes') returning * into v_attempt;
  return jsonb_build_object('attemptId',v_attempt.id,'state',v_attempt.state,'authEmail',v_attempt.auth_email,'fence',v_attempt.fence);
end;
$$;

create or replace function public.finalize_invite_registration(p_attempt_id uuid,p_fence uuid,p_auth_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_attempt private.registration_attempts%rowtype; v_code private.activation_codes%rowtype; v_expires timestamptz; v_email text; v_meta text;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into v_attempt from private.registration_attempts where id=p_attempt_id for update;
  if not found or v_attempt.fence<>p_fence then raise exception 'ATTEMPT_INVALID'; end if;
  if v_attempt.state='COMPLETED' then select e.expires_at into v_expires from public.membership_entitlements e where e.user_id=v_attempt.auth_user_id and e.product_id='eastudy_pro'; return jsonb_build_object('userId',v_attempt.auth_user_id,'account',v_attempt.account_key,'expiresAt',v_expires,'state','COMPLETED'); end if;
  if v_attempt.state<>'RESERVED' or v_attempt.lease_until<=now() then raise exception 'ATTEMPT_EXPIRED'; end if;
  select u.email,u.raw_user_meta_data->>'registration_attempt_id' into v_email,v_meta from auth.users u where u.id=p_auth_user_id;
  if v_email is distinct from v_attempt.auth_email or v_meta is distinct from v_attempt.id::text then raise exception 'AUTH_USER_MISMATCH'; end if;
  select * into v_code from private.activation_codes c where c.id=v_attempt.code_id for update;
  if not found or v_code.redeemed_by is not null or v_code.revoked_at is not null or (v_code.valid_until is not null and v_code.valid_until<=now()) or exists(select 1 from private.activation_code_batches b where b.id=v_code.batch_id and b.disabled_at is not null) then raise exception 'INVITE_INVALID'; end if;
  if not exists(select 1 from public.profiles p where p.id=p_auth_user_id) then raise exception 'PROFILE_NOT_READY'; end if;
  insert into private.account_identities(account_key,user_id,auth_email) values(v_attempt.account_key,p_auth_user_id,v_attempt.auth_email);
  insert into private.login_identifiers(login_key,user_id) values(v_attempt.account_key,p_auth_user_id);
  update public.profiles set has_password=true,is_active=true where id=p_auth_user_id;
  insert into public.membership_entitlements as e(user_id,product_id,expires_at,revoked_at,created_at,updated_at)
  values(p_auth_user_id,v_code.product_id,now()+make_interval(days=>v_code.duration_days),null,now(),now())
  on conflict on constraint membership_entitlements_pkey do update set expires_at=greatest(now(),e.expires_at)+make_interval(days=>v_code.duration_days),updated_at=now()
  returning e.expires_at into v_expires;
  update private.activation_codes set redeemed_by=p_auth_user_id,redeemed_at=now() where id=v_code.id and redeemed_by is null;
  if not found then raise exception 'INVITE_INVALID'; end if;
  insert into private.membership_redemptions(code_id,user_id,product_id,duration_days,entitlement_expires_at) values(v_code.id,p_auth_user_id,v_code.product_id,v_code.duration_days,v_expires);
  update private.registration_attempts set state='COMPLETED',auth_user_id=p_auth_user_id,completed_at=now() where id=v_attempt.id;
  return jsonb_build_object('userId',p_auth_user_id,'account',v_attempt.account_key,'expiresAt',v_expires,'durationDays',v_code.duration_days,'state','COMPLETED');
end;
$$;

create or replace function public.get_my_learning_summary_v3()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_access jsonb:=private.learning_access_v2(auth.uid());
begin
  if coalesce((v_access->>'canEnterLearning')::boolean,false) is not true then raise exception '%',coalesce(v_access->>'reason','ACCESS_DENIED') using errcode='42501'; end if;
  return jsonb_build_object('totalSeconds',coalesce((select sum(s.learning_seconds) from public.daily_learning_stats s where s.user_id=v_user),0),'learningDays',coalesce((select count(*) from public.daily_learning_stats s where s.user_id=v_user and s.learning_seconds>0),0),'completedVideos',coalesce((select count(*) from public.user_progress p where p.user_id=v_user and p.completed_at is not null),0),'masteredWords',coalesce((select count(*) from public.user_vocabulary w where w.user_id=v_user and w.state='mastered'),0));
end;
$$;

create or replace function public.touch_my_activity_v1()
returns void language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_access jsonb:=private.learning_access_v2(auth.uid()); v_now timestamptz:=clock_timestamp();
begin
  if coalesce((v_access->>'canEnterLearning')::boolean,false) is not true then raise exception '%',coalesce(v_access->>'reason','ACCESS_DENIED') using errcode='42501'; end if;
  insert into private.learner_activity as a(user_id,last_seen_at) values(v_user,v_now)
  on conflict(user_id) do update set last_seen_at=excluded.last_seen_at where a.last_seen_at<=excluded.last_seen_at-interval '60 seconds';
end;
$$;

create or replace function private.enforce_learning_write_access_v2()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if auth.role()='service_role' then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if coalesce((private.learning_access_v2(auth.uid())->>'canEnterLearning')::boolean,false) is not true then raise exception 'LEARNING_ACCESS_REQUIRED' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

do $$ declare v_table text;
begin
  foreach v_table in array array['study_events','user_vocabulary','user_progress','study_activity_intervals','daily_learning_stats','learner_goal_profiles','user_creator_follows','user_collection_saves','user_learning_preferences'] loop
    if to_regclass('public.'||v_table) is not null then
      execute format('drop trigger if exists enforce_learning_write_access_v2 on public.%I',v_table);
      execute format('create trigger enforce_learning_write_access_v2 before insert or update or delete on public.%I for each row execute function private.enforce_learning_write_access_v2()',v_table);
    end if;
  end loop;
end $$;

-- Replace permissive "own row" policies so an old Auth refresh token cannot
-- keep reading or mutating the learning system after membership expires.
do $$ declare v_table text; v_policy record;
begin
  foreach v_table in array array['study_events','user_vocabulary','user_progress','saved_sentences','daily_learning_stats','study_activity_intervals','learner_goal_profiles','user_creator_follows','user_collection_saves','user_learning_preferences'] loop
    if to_regclass('public.'||v_table) is not null then
      execute format('alter table public.%I enable row level security',v_table);
      for v_policy in select policyname from pg_policies where schemaname='public' and tablename=v_table loop
        execute format('drop policy %I on public.%I',v_policy.policyname,v_table);
      end loop;
    end if;
  end loop;
end $$;

create policy "study events learning access v2" on public.study_events for all to authenticated
  using(public.has_learning_access_v2() and (user_id=auth.uid() or public.is_admin()))
  with check(public.has_learning_access_v2() and user_id=auth.uid());
create policy "vocabulary learning access v2" on public.user_vocabulary for all to authenticated
  using(public.has_learning_access_v2() and (user_id=auth.uid() or public.is_admin()))
  with check(public.has_learning_access_v2() and user_id=auth.uid());
create policy "progress learning access v2" on public.user_progress for all to authenticated
  using(public.has_learning_access_v2() and (user_id=auth.uid() or public.is_admin()))
  with check(public.has_learning_access_v2() and user_id=auth.uid());
create policy "saved sentences learning access v2" on public.saved_sentences for all to authenticated
  using(public.has_learning_access_v2() and (user_id=auth.uid() or public.is_admin()))
  with check(public.has_learning_access_v2() and user_id=auth.uid());
create policy "daily stats learning access v2" on public.daily_learning_stats for select to authenticated
  using(public.has_learning_access_v2() and (user_id=auth.uid() or public.is_admin()));
create policy "activity intervals learning access v2" on public.study_activity_intervals for select to authenticated
  using(public.has_learning_access_v2() and (user_id=auth.uid() or public.is_admin()));
create policy "goal profiles learning access v2" on public.learner_goal_profiles for all to authenticated
  using(public.has_learning_access_v2() and (user_id=auth.uid() or public.is_admin()))
  with check(public.has_learning_access_v2() and user_id=auth.uid());
create policy "creator follows learning access v2" on public.user_creator_follows for all to authenticated
  using(public.has_learning_access_v2() and user_id=auth.uid()) with check(public.has_learning_access_v2() and user_id=auth.uid());
create policy "collection saves learning access v2" on public.user_collection_saves for all to authenticated
  using(public.has_learning_access_v2() and user_id=auth.uid()) with check(public.has_learning_access_v2() and user_id=auth.uid());
create policy "learning preferences access v2" on public.user_learning_preferences for all to authenticated
  using(public.has_learning_access_v2() and user_id=auth.uid()) with check(public.has_learning_access_v2() and user_id=auth.uid());

drop policy if exists "learning targets read visible" on public.learning_targets;
create policy "learning targets read visible" on public.learning_targets for select to authenticated
  using(public.has_learning_access_v2() and (content_status<>'hidden' or public.is_admin()));

revoke all on function public.resolve_account_login_v2(text) from public,anon,authenticated;
revoke all on function public.service_get_user_learning_access_v2(uuid) from public,anon,authenticated;
revoke all on function public.service_resolve_playback_access_v2(uuid,uuid,text) from public,anon,authenticated;
revoke all on function private.enforce_learning_write_access_v2() from public,anon,authenticated;
revoke all on function public.get_my_learning_access_v2() from public,anon;
revoke all on function public.has_learning_access_v2() from public,anon;
revoke all on function public.get_published_content() from public,anon;
revoke all on function public.resolve_processing_media(uuid,text) from public,anon;
revoke all on function public.redeem_activation_code(text) from public,anon;
revoke all on function public.reserve_invite_registration(uuid,text,text) from public,anon,authenticated;
revoke all on function public.finalize_invite_registration(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.resolve_account_login_v2(text) to service_role;
grant execute on function public.service_get_user_learning_access_v2(uuid) to service_role;
grant execute on function public.service_resolve_playback_access_v2(uuid,uuid,text) to service_role;
grant execute on function public.get_my_learning_access_v2() to authenticated;
grant execute on function public.has_learning_access_v2() to authenticated;
grant execute on function public.get_published_content() to authenticated;
grant execute on function public.resolve_processing_media(uuid,text) to authenticated;
grant execute on function public.redeem_activation_code(text) to authenticated;
grant execute on function public.reserve_invite_registration(uuid,text,text) to service_role;
grant execute on function public.finalize_invite_registration(uuid,uuid,uuid) to service_role;

create or replace function public.admin_list_processing_jobs(p_limit integer default 500)
returns table(job jsonb) language plpgsql stable security definer set search_path='' as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query select jsonb_build_object(
    'id',j.id,'videoId',j.video_id,'type',coalesce(j.input->>'kind','CLOUD_PIPELINE'),'mode',j.input->>'mode',
    'title',coalesce(v.video->>'title',v.video->>'titleZh',j.input->>'title',j.input->>'titleZh',j.result->'video'->>'title'),
    'inputTitle',coalesce(j.input->>'title',j.input->>'titleZh'),'cover',coalesce(v.video->>'cover',j.input->>'cover',j.result->'video'->>'cover'),
    'videoState','ACTIVE','canOpenVideo',true,'canRetry',j.status='ERROR',
    'resultSentenceCount',case when jsonb_typeof(j.result->'sentences')='array' then jsonb_array_length(j.result->'sentences') else 0 end,
    'outputReceiptCount',(select count(*) from private.processing_output_receipts r where r.job_id=j.id),
    'status',j.status,'stage',j.stage,'progress',j.progress,'attempt',j.attempt,'provider',j.provider,'error',j.error,'runId',j.run_id,'message',j.work->>'message',
    'telemetry',j.work->'telemetry','attemptStartedAt',j.attempt_started_at,'stageStartedAt',j.stage_started_at,'lastHeartbeatAt',j.last_heartbeat_at,
    'lastProgressAt',j.last_progress_at,'metricsReportedAt',j.metrics_reported_at,'leaseUntil',j.lease_until,'nextRunAt',j.next_run_at,
    'automaticRecoveryCount',j.automatic_recovery_count,'maxAutomaticRecoveries',j.max_automatic_recoveries,'createdAt',j.created_at,'updatedAt',j.updated_at,
    'completedAt',j.completed_at,'serverNow',clock_timestamp())
  from public.processing_jobs j cross join private.content_snapshots c
  join lateral(select value video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) value where value->>'id'=j.video_id limit 1)v on true
  where c.environment='production' order by j.created_at desc limit least(greatest(p_limit,1),1000);
end $$;
revoke all on function public.admin_list_processing_jobs(integer) from public,anon;
grant execute on function public.admin_list_processing_jobs(integer) to authenticated;

comment on table private.login_identifiers is 'Canonical login identifiers mapped to exactly one existing Auth user.';
comment on function public.get_my_learning_access_v2() is 'Single learner/admin access decision used by login, content, learning and playback.';
