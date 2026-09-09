-- Eastudy recoverable content deletion for the JSON snapshot MVP.
-- Logical deletion only: this migration never deletes Cloudflare R2 objects.

create table if not exists private.content_video_trash (
  id uuid primary key default gen_random_uuid(),
  environment text not null default 'production' check (environment in ('production')),
  video_id text not null check (video_id ~ '^[0-9]+$'),
  payload jsonb not null,
  reason text not null default 'admin-delete',
  deleted_by uuid not null references auth.users(id),
  deleted_at timestamptz not null default now(),
  restored_by uuid references auth.users(id),
  restored_at timestamptz
);

create unique index if not exists content_video_trash_active_video
  on private.content_video_trash(environment, video_id)
  where restored_at is null;

revoke all on table private.content_video_trash from public, anon, authenticated;

create or replace function private.content_video_payload(p_snapshot jsonb, p_video_id text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'video', (
      select value from jsonb_array_elements(coalesce(p_snapshot->'videos', '[]'::jsonb))
      where value->>'id' = p_video_id limit 1
    ),
    'sentences', coalesce(p_snapshot->'sentences'->p_video_id, '[]'::jsonb),
    'jobs', coalesce((
      select jsonb_agg(value) from jsonb_array_elements(coalesce(p_snapshot->'jobs', '[]'::jsonb))
      where value->>'videoId' = p_video_id
    ), '[]'::jsonb)
  );
$$;

create or replace function private.without_content_videos(p_snapshot jsonb, p_video_ids text[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_set(
    jsonb_set(
      jsonb_set(
        coalesce(p_snapshot, '{}'::jsonb),
        '{videos}',
        coalesce((
          select jsonb_agg(value) from jsonb_array_elements(coalesce(p_snapshot->'videos', '[]'::jsonb))
          where not ((value->>'id') = any(p_video_ids))
        ), '[]'::jsonb),
        true
      ),
      '{sentences}',
      coalesce(p_snapshot->'sentences', '{}'::jsonb) - p_video_ids,
      true
    ),
    '{jobs}',
    coalesce((
      select jsonb_agg(value) from jsonb_array_elements(coalesce(p_snapshot->'jobs', '[]'::jsonb))
      where not ((value->>'videoId') = any(p_video_ids))
    ), '[]'::jsonb),
    true
  );
$$;

create or replace function public.admin_list_content_trash()
returns table(video_id text, video jsonb, deleted_at timestamptz, reason text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query
  select t.video_id,
         coalesce(t.payload->'draft'->'video', t.payload->'published'->'video'),
         t.deleted_at,
         t.reason
  from private.content_video_trash t
  where t.environment = 'production' and t.restored_at is null
  order by t.deleted_at desc;
end;
$$;

create or replace function public.admin_trash_content_videos(p_video_ids text[], p_expected_revision bigint)
returns table(snapshot jsonb, revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content private.content_snapshots%rowtype;
  v_ids text[];
  v_id text;
  v_payload jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select array_agg(distinct value order by value) into v_ids
  from unnest(coalesce(p_video_ids, array[]::text[])) value;
  if coalesce(array_length(v_ids, 1), 0) < 1 or array_length(v_ids, 1) > 100 then
    raise exception 'VIDEO_DELETE_COUNT_INVALID';
  end if;
  if exists(select 1 from unnest(v_ids) value where value !~ '^[0-9]+$') then
    raise exception 'VIDEO_ID_INVALID';
  end if;

  select * into v_content from private.content_snapshots
  where environment = 'production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;
  if v_content.revision <> p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;

  if exists(
    select 1 from jsonb_array_elements(coalesce(v_content.draft->'jobs', '[]'::jsonb)) job
    where job->>'videoId' = any(v_ids)
      and upper(coalesce(job->>'status', '')) in ('PROCESSING', 'QUEUED', 'UPLOADING')
  ) then raise exception 'VIDEO_JOB_ACTIVE'; end if;

  foreach v_id in array v_ids loop
    if not exists(
      select 1 from jsonb_array_elements(coalesce(v_content.draft->'videos', '[]'::jsonb)) video
      where video->>'id' = v_id
    ) and not exists(
      select 1 from jsonb_array_elements(coalesce(v_content.published->'videos', '[]'::jsonb)) video
      where video->>'id' = v_id
    ) then raise exception 'VIDEO_NOT_FOUND:%', v_id; end if;

    v_payload := jsonb_build_object(
      'draft', private.content_video_payload(v_content.draft, v_id),
      'published', private.content_video_payload(v_content.published, v_id)
    );
    insert into private.content_video_trash(environment, video_id, payload, deleted_by)
    values ('production', v_id, v_payload, auth.uid())
    on conflict (environment, video_id) where restored_at is null
    do update set payload = excluded.payload, deleted_by = excluded.deleted_by,
                  deleted_at = now(), reason = excluded.reason;
  end loop;

  update private.content_snapshots c
  set draft = private.without_content_videos(c.draft, v_ids),
      published = private.without_content_videos(c.published, v_ids),
      revision = c.revision + 1,
      updated_by = auth.uid(), updated_at = now()
  where c.environment = 'production';

  return query select c.draft, c.revision, c.updated_at
  from private.content_snapshots c where c.environment = 'production';
end;
$$;

create or replace function public.admin_restore_content_video(p_video_id text, p_expected_revision bigint)
returns table(snapshot jsonb, revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content private.content_snapshots%rowtype;
  v_trash private.content_video_trash%rowtype;
  v_video jsonb;
  v_sentences jsonb;
  v_jobs jsonb;
  v_draft jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_video_id is null or p_video_id !~ '^[0-9]+$' then raise exception 'VIDEO_ID_INVALID'; end if;

  select * into v_content from private.content_snapshots
  where environment = 'production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;
  if v_content.revision <> p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;

  select * into v_trash from private.content_video_trash t
  where t.environment = 'production' and t.video_id = p_video_id and t.restored_at is null
  for update;
  if not found then raise exception 'TRASH_NOT_FOUND'; end if;
  if exists(
    select 1 from jsonb_array_elements(coalesce(v_content.draft->'videos', '[]'::jsonb)) video
    where video->>'id' = p_video_id
  ) then raise exception 'VIDEO_ID_CONFLICT'; end if;

  v_video := coalesce(v_trash.payload->'draft'->'video', v_trash.payload->'published'->'video');
  if v_video is null or jsonb_typeof(v_video) <> 'object' then raise exception 'TRASH_PAYLOAD_INVALID'; end if;
  v_video := v_video || jsonb_build_object('status', 'DRAFT', 'publishedAt', null, 'updatedAt', now());
  v_sentences := coalesce(v_trash.payload->'draft'->'sentences', v_trash.payload->'published'->'sentences', '[]'::jsonb);
  v_jobs := coalesce(v_trash.payload->'draft'->'jobs', '[]'::jsonb);
  v_draft := jsonb_set(v_content.draft, '{videos}', jsonb_build_array(v_video) || coalesce(v_content.draft->'videos', '[]'::jsonb), true);
  v_draft := jsonb_set(v_draft, array['sentences', p_video_id], v_sentences, true);
  v_draft := jsonb_set(v_draft, '{jobs}', v_jobs || coalesce(v_content.draft->'jobs', '[]'::jsonb), true);
  perform private.validate_content_snapshot(v_draft);

  update private.content_snapshots c
  set draft = v_draft, revision = c.revision + 1,
      updated_by = auth.uid(), updated_at = now()
  where c.environment = 'production';
  update private.content_video_trash
  set restored_by = auth.uid(), restored_at = now()
  where id = v_trash.id;

  return query select c.draft, c.revision, c.updated_at
  from private.content_snapshots c where c.environment = 'production';
end;
$$;

-- Draft edits advance the same revision used by trash/restore conflict detection.
create or replace function public.admin_save_content_snapshot(p_snapshot jsonb)
returns table(revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  perform private.validate_content_snapshot(p_snapshot);
  insert into private.content_snapshots(environment, draft, revision, updated_by, updated_at)
  values ('production', p_snapshot, 1, auth.uid(), now())
  on conflict (environment) do update
    set draft = excluded.draft, revision = private.content_snapshots.revision + 1,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return query select c.revision, c.updated_at from private.content_snapshots c where c.environment = 'production';
end;
$$;

revoke all on function public.admin_list_content_trash() from public, anon;
revoke all on function public.admin_trash_content_videos(text[], bigint) from public, anon;
revoke all on function public.admin_restore_content_video(text, bigint) from public, anon;
grant execute on function public.admin_list_content_trash() to authenticated;
grant execute on function public.admin_trash_content_videos(text[], bigint) to authenticated;
grant execute on function public.admin_restore_content_video(text, bigint) to authenticated;

comment on table private.content_video_trash is 'Recoverable Eastudy content deletion; media objects are retained.';
