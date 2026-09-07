-- Eastudy phone OTP iteration.
-- Run after 20260907_mvp_auth_and_learning.sql.

alter table public.profiles
add column if not exists has_password boolean not null default false;

alter table public.profiles
add column if not exists is_active boolean not null default false;

alter table public.profiles
add column if not exists phone_verified_at timestamptz;

create index if not exists profiles_role_active_idx
on public.profiles (role, is_active);

-- Preserve the correct status for accounts created before this column existed.
update public.profiles as profile
set has_password = true
from auth.users as auth_user
where profile.id = auth_user.id
  and nullif(auth_user.encrypted_password, '') is not null;

update public.profiles as profile
set is_active = true,
    phone_verified_at = coalesce(profile.phone_verified_at, auth_user.phone_confirmed_at)
from auth.users as auth_user
where profile.id = auth_user.id
  and auth_user.phone_confirmed_at is not null;

create or replace function public.mark_my_phone_verified()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
  set is_active = true,
      phone_verified_at = coalesce(phone_verified_at, now())
  where id = auth.uid();
$$;

revoke all on function public.mark_my_phone_verified() from public;
grant execute on function public.mark_my_phone_verified() to authenticated;

create or replace function public.mark_my_password_set()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
  set has_password = true,
      is_active = true,
      phone_verified_at = coalesce(phone_verified_at, now())
  where id = auth.uid();
$$;

revoke all on function public.mark_my_password_set() from public;
grant execute on function public.mark_my_password_set() to authenticated;

-- Browser clients may edit normal profile fields, but cannot promote roles or
-- claim a password was set. The security-definer RPC above remains allowed.
create or replace function public.protect_profile_auth_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('anon', 'authenticated') then
    new.role := old.role;
    new.has_password := old.has_password;
    new.is_active := old.is_active;
    new.phone_verified_at := old.phone_verified_at;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_auth_fields_trigger on public.profiles;
create trigger protect_profile_auth_fields_trigger
before update on public.profiles
for each row execute function public.protect_profile_auth_fields();
