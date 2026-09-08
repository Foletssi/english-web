-- Eastudy cloud content MVP: controlled administrators and atomic cross-device publishing.
-- Run after the existing auth/profile migration. No phone numbers or passwords are stored here.

create schema if not exists private;

create table if not exists private.admin_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  admin_role text not null default 'editor' check (admin_role in ('owner', 'editor', 'support')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

revoke all on table private.admin_memberships from public, anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    exists (
      select 1 from private.admin_memberships m
      where m.user_id = auth.uid() and m.status = 'active'
    )
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and lower(coalesce(p.role, '')) = 'admin'
    )
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create table if not exists private.content_snapshots (
  environment text primary key check (environment in ('production')),
  draft jsonb not null default '{}'::jsonb,
  published jsonb not null default '{}'::jsonb,
  revision bigint not null default 0 check (revision >= 0),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

revoke all on table private.content_snapshots from public, anon, authenticated;

create or replace function private.validate_content_snapshot(p_snapshot jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'INVALID_CONTENT_SNAPSHOT';
  end if;
  if jsonb_typeof(coalesce(p_snapshot->'videos', '[]'::jsonb)) <> 'array' then
    raise exception 'INVALID_CONTENT_VIDEOS';
  end if;
  if jsonb_array_length(coalesce(p_snapshot->'videos', '[]'::jsonb)) > 5000 then
    raise exception 'CONTENT_VIDEO_LIMIT_EXCEEDED';
  end if;
  if octet_length(p_snapshot::text) > 5242880 then
    raise exception 'CONTENT_SNAPSHOT_TOO_LARGE';
  end if;
end;
$$;

create or replace function private.published_projection(p_snapshot jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  with published_videos as (
    select coalesce(jsonb_agg(value), '[]'::jsonb) as rows
    from jsonb_array_elements(coalesce(p_snapshot->'videos', '[]'::jsonb))
    where value->>'status' = 'PUBLISHED'
  ), published_sentences as (
    select coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb) as rows
    from jsonb_each(coalesce(p_snapshot->'sentences', '{}'::jsonb)) entry
    where exists (
      select 1 from jsonb_array_elements((select rows from published_videos)) video
      where video->>'id' = entry.key
    )
  )
  select jsonb_build_object(
    'schemaVersion', coalesce(p_snapshot->'schemaVersion', '2'::jsonb),
    'videos', (select rows from published_videos),
    'sentences', (select rows from published_sentences),
    'creators', coalesce(p_snapshot->'creators', '[]'::jsonb),
    'collections', coalesce(p_snapshot->'collections', '[]'::jsonb),
    'jobs', '[]'::jsonb,
    'auditLog', '[]'::jsonb
  );
$$;

create or replace function public.admin_get_content_snapshot()
returns table(snapshot jsonb, revision bigint, updated_at timestamptz, published_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query
  select c.draft, c.revision, c.updated_at, c.published_at
  from private.content_snapshots c where c.environment = 'production';
end;
$$;

create or replace function public.get_published_content()
returns table(snapshot jsonb, revision bigint, published_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED'; end if;
  return query
  select c.published, c.revision, c.published_at
  from private.content_snapshots c where c.environment = 'production';
end;
$$;

create or replace function public.admin_save_content_snapshot(p_snapshot jsonb)
returns table(revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  perform private.validate_content_snapshot(p_snapshot);
  insert into private.content_snapshots(environment, draft, updated_by, updated_at)
  values ('production', p_snapshot, auth.uid(), now())
  on conflict (environment) do update
    set draft = excluded.draft, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return query select c.revision, c.updated_at from private.content_snapshots c where c.environment = 'production';
end;
$$;

create or replace function public.admin_publish_content_snapshot(p_snapshot jsonb)
returns table(revision bigint, published_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_projection jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  perform private.validate_content_snapshot(p_snapshot);
  v_projection := private.published_projection(p_snapshot);
  insert into private.content_snapshots(environment, draft, published, revision, updated_by, updated_at, published_at)
  values ('production', p_snapshot, v_projection, 1, auth.uid(), now(), now())
  on conflict (environment) do update
    set draft = excluded.draft,
        published = excluded.published,
        revision = private.content_snapshots.revision + 1,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at,
        published_at = excluded.published_at;
  return query select c.revision, c.published_at from private.content_snapshots c where c.environment = 'production';
end;
$$;

revoke all on function public.admin_get_content_snapshot() from public, anon;
revoke all on function public.get_published_content() from public, anon;
revoke all on function public.admin_save_content_snapshot(jsonb) from public, anon;
revoke all on function public.admin_publish_content_snapshot(jsonb) from public, anon;
grant execute on function public.admin_get_content_snapshot() to authenticated;
grant execute on function public.get_published_content() to authenticated;
grant execute on function public.admin_save_content_snapshot(jsonb) to authenticated;
grant execute on function public.admin_publish_content_snapshot(jsonb) to authenticated;

comment on table private.admin_memberships is 'Server-controlled Eastudy administrator allowlist.';
comment on table private.content_snapshots is 'Atomic content draft and published snapshots for the MVP.';
