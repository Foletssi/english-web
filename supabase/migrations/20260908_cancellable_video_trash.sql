-- Cancel active/stale work before recoverable deletion.
-- R2 objects are intentionally retained. Active trash rows are tombstones.

create table if not exists private.content_snapshot_backups (
  backup_key text primary key,
  environment text not null,
  draft jsonb not null,
  published jsonb not null,
  revision bigint not null,
  reason text not null,
  created_at timestamptz not null default now()
);

revoke all on table private.content_snapshot_backups from public, anon, authenticated;

create or replace function private.reconcile_orphaned_legacy_jobs(p_snapshot jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_orphan_ids text[];
  v_jobs jsonb;
  v_videos jsonb;
begin
  select coalesce(array_agg(distinct job->>'videoId'), array[]::text[])
  into v_orphan_ids
  from jsonb_array_elements(coalesce(p_snapshot->'jobs', '[]'::jsonb)) job
  where upper(coalesce(job->>'status', '')) in ('PROCESSING', 'QUEUED', 'UPLOADING')
    and nullif(job->>'externalJobId', '') is null
    and nullif(job->>'heartbeatAt', '') is null
    and nullif(job->>'leaseUntil', '') is null
    and coalesce((job->>'updatedAt')::timestamptz, 'epoch'::timestamptz) < now() - interval '15 minutes';

  select coalesce(jsonb_agg(
    case when job->>'videoId' = any(v_orphan_ids) then
      job || jsonb_build_object(
        'status', 'ERROR',
        'error', jsonb_build_object(
          'code', 'LEGACY_JOB_ORPHANED',
          'message', '旧版任务没有执行者、心跳或外部任务编号，已停止等待。',
          'retryable', false
        ),
        'updatedAt', to_jsonb(now())
      )
    else job end
  ), '[]'::jsonb) into v_jobs
  from jsonb_array_elements(coalesce(p_snapshot->'jobs', '[]'::jsonb)) job;

  select coalesce(jsonb_agg(
    case when video->>'id' = any(v_orphan_ids)
      and upper(coalesce(video->>'pipelineStatus', '')) in ('PROCESSING', 'QUEUED', 'UPLOADING')
    then video || jsonb_build_object(
      'pipelineStatus', 'ERROR',
      'status', case when upper(coalesce(video->>'status', '')) = 'PROCESSING' then 'DRAFT' else video->>'status' end,
      'updatedAt', to_jsonb(now())
    ) else video end
  ), '[]'::jsonb) into v_videos
  from jsonb_array_elements(coalesce(p_snapshot->'videos', '[]'::jsonb)) video;

  return jsonb_set(jsonb_set(coalesce(p_snapshot, '{}'::jsonb), '{jobs}', v_jobs, true), '{videos}', v_videos, true);
end;
$$;

create or replace function private.cancel_jobs_in_video_payload(p_payload jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_set(
    coalesce(p_payload, '{}'::jsonb),
    '{jobs}',
    coalesce((
      select jsonb_agg(job || jsonb_build_object(
        'status', 'CANCELLED',
        'cancelRequested', true,
        'error', null
      ))
      from jsonb_array_elements(coalesce(p_payload->'jobs', '[]'::jsonb)) job
    ), '[]'::jsonb),
    true
  );
$$;

create or replace function private.without_active_trash(p_snapshot jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select private.without_content_videos(
    coalesce(p_snapshot, '{}'::jsonb),
    coalesce((
      select array_agg(t.video_id)
      from private.content_video_trash t
      where t.environment = 'production' and t.restored_at is null
    ), array[]::text[])
  );
$$;

insert into private.content_snapshot_backups(backup_key, environment, draft, published, revision, reason)
select 'before-orphan-reconcile-' || c.revision, c.environment, c.draft, c.published, c.revision,
       'Before marking legacy jobs without execution evidence as failed'
from private.content_snapshots c
where c.environment = 'production'
on conflict (backup_key) do nothing;

update private.content_snapshots c
set draft = private.reconcile_orphaned_legacy_jobs(c.draft),
    revision = c.revision + 1,
    updated_at = now()
where c.environment = 'production'
  and c.draft is distinct from private.reconcile_orphaned_legacy_jobs(c.draft);

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

  foreach v_id in array v_ids loop
    if not exists(
      select 1 from jsonb_array_elements(coalesce(v_content.draft->'videos', '[]'::jsonb)) video
      where video->>'id' = v_id
    ) and not exists(
      select 1 from jsonb_array_elements(coalesce(v_content.published->'videos', '[]'::jsonb)) video
      where video->>'id' = v_id
    ) then raise exception 'VIDEO_NOT_FOUND:%', v_id; end if;

    v_payload := jsonb_build_object(
      'draft', private.cancel_jobs_in_video_payload(private.content_video_payload(v_content.draft, v_id)),
      'published', private.cancel_jobs_in_video_payload(private.content_video_payload(v_content.published, v_id))
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

-- Legacy callers remain safe: active trash rows are always stripped before saving.
create or replace function public.admin_save_content_snapshot(p_snapshot jsonb)
returns table(revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare v_safe jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  v_safe := private.without_active_trash(p_snapshot);
  perform private.validate_content_snapshot(v_safe);
  insert into private.content_snapshots(environment, draft, revision, updated_by, updated_at)
  values ('production', v_safe, 1, auth.uid(), now())
  on conflict (environment) do update
    set draft = excluded.draft, revision = private.content_snapshots.revision + 1,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return query select c.revision, c.updated_at from private.content_snapshots c where c.environment = 'production';
end;
$$;

create or replace function public.admin_save_content_snapshot_v2(p_snapshot jsonb, p_expected_revision bigint)
returns table(revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare v_content private.content_snapshots%rowtype; v_safe jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_content from private.content_snapshots where environment = 'production' for update;
  if not found or v_content.revision <> p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  v_safe := private.without_active_trash(p_snapshot);
  perform private.validate_content_snapshot(v_safe);
  update private.content_snapshots c set draft = v_safe, revision = c.revision + 1,
    updated_by = auth.uid(), updated_at = now() where c.environment = 'production';
  return query select c.revision, c.updated_at from private.content_snapshots c where c.environment = 'production';
end;
$$;

create or replace function public.admin_publish_content_snapshot(p_snapshot jsonb)
returns table(revision bigint, published_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare v_safe jsonb; v_projection jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  v_safe := private.without_active_trash(p_snapshot);
  perform private.validate_content_snapshot(v_safe);
  v_projection := private.published_projection(v_safe);
  insert into private.content_snapshots(environment, draft, published, revision, updated_by, updated_at, published_at)
  values ('production', v_safe, v_projection, 1, auth.uid(), now(), now())
  on conflict (environment) do update
    set draft = excluded.draft, published = excluded.published,
        revision = private.content_snapshots.revision + 1,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at,
        published_at = excluded.published_at;
  return query select c.revision, c.published_at from private.content_snapshots c where c.environment = 'production';
end;
$$;

create or replace function public.admin_publish_content_snapshot_v2(p_snapshot jsonb, p_expected_revision bigint)
returns table(revision bigint, published_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare v_content private.content_snapshots%rowtype; v_safe jsonb; v_projection jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_content from private.content_snapshots where environment = 'production' for update;
  if not found or v_content.revision <> p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  v_safe := private.without_active_trash(p_snapshot);
  perform private.validate_content_snapshot(v_safe);
  v_projection := private.published_projection(v_safe);
  update private.content_snapshots c set draft = v_safe, published = v_projection,
    revision = c.revision + 1, updated_by = auth.uid(), updated_at = now(), published_at = now()
  where c.environment = 'production';
  return query select c.revision, c.published_at from private.content_snapshots c where c.environment = 'production';
end;
$$;

revoke all on function public.admin_save_content_snapshot_v2(jsonb, bigint) from public, anon;
revoke all on function public.admin_publish_content_snapshot_v2(jsonb, bigint) from public, anon;
grant execute on function public.admin_save_content_snapshot_v2(jsonb, bigint) to authenticated;
grant execute on function public.admin_publish_content_snapshot_v2(jsonb, bigint) to authenticated;

comment on table private.content_snapshot_backups is 'Internal restore points before automated content repairs.';
