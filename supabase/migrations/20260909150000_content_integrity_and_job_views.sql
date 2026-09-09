-- Protect the content catalog from accidental snapshot replacement, enrich job
-- diagnostics, and repair the two videos lost by the shared browser cache bug.
-- R2 objects and active trash records are intentionally left untouched.

create or replace function private.assert_no_implicit_video_removal(
  p_current jsonb,
  p_next jsonb
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_current->'videos', '[]'::jsonb)) current_video
    where not exists (
      select 1
      from jsonb_array_elements(coalesce(p_next->'videos', '[]'::jsonb)) next_video
      where next_video->>'id' = current_video->>'id'
    )
  ) then
    raise exception 'VIDEO_REMOVAL_REQUIRES_EXPLICIT_TRASH';
  end if;
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
  raise exception 'CONTENT_EXPECTED_REVISION_REQUIRED';
end;
$$;

create or replace function public.admin_publish_content_snapshot(p_snapshot jsonb)
returns table(revision bigint, published_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  raise exception 'CONTENT_EXPECTED_REVISION_REQUIRED';
end;
$$;

create or replace function public.admin_save_content_snapshot_v2(
  p_snapshot jsonb,
  p_expected_revision bigint
)
returns table(revision bigint, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content private.content_snapshots%rowtype;
  v_safe jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_content from private.content_snapshots
  where environment = 'production' for update;
  if not found or v_content.revision is distinct from p_expected_revision then
    raise exception 'CONTENT_REVISION_CONFLICT';
  end if;
  v_safe := private.without_active_trash(p_snapshot);
  perform private.validate_content_snapshot(v_safe);
  perform private.assert_no_implicit_video_removal(v_content.draft, v_safe);
  update private.content_snapshots c
  set draft = v_safe,
      revision = c.revision + 1,
      updated_by = auth.uid(),
      updated_at = now()
  where c.environment = 'production';
  return query select c.revision, c.updated_at
  from private.content_snapshots c where c.environment = 'production';
end;
$$;

create or replace function public.admin_publish_content_snapshot_v2(
  p_snapshot jsonb,
  p_expected_revision bigint
)
returns table(revision bigint, published_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content private.content_snapshots%rowtype;
  v_safe jsonb;
  v_projection jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_content from private.content_snapshots
  where environment = 'production' for update;
  if not found or v_content.revision is distinct from p_expected_revision then
    raise exception 'CONTENT_REVISION_CONFLICT';
  end if;
  v_safe := private.without_active_trash(p_snapshot);
  perform private.validate_content_snapshot(v_safe);
  perform private.assert_no_implicit_video_removal(v_content.draft, v_safe);
  v_projection := private.published_projection(v_safe);
  update private.content_snapshots c
  set draft = v_safe,
      published = v_projection,
      revision = c.revision + 1,
      updated_by = auth.uid(),
      updated_at = now(),
      published_at = now()
  where c.environment = 'production';
  return query select c.revision, c.published_at
  from private.content_snapshots c where c.environment = 'production';
end;
$$;

create or replace function public.admin_list_processing_jobs(p_limit integer default 50)
returns table(job jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query
  select jsonb_build_object(
    'id', j.id,
    'videoId', j.video_id,
    'title', coalesce(v.video->>'title', v.video->>'titleZh', j.input->>'title', j.input->>'titleZh', j.result->'video'->>'title'),
    'inputTitle', coalesce(j.input->>'title', j.input->>'titleZh'),
    'cover', coalesce(v.video->>'cover', j.input->>'cover', j.result->'video'->>'cover'),
    'videoState', case when v.video is not null then 'ACTIVE' when t.video_id is not null then 'TRASHED' else 'MISSING' end,
    'canOpenVideo', v.video is not null,
    'canRetry', j.status = 'ERROR' and v.video is not null,
    'resultSentenceCount', case when jsonb_typeof(j.result->'sentences') = 'array' then jsonb_array_length(j.result->'sentences') else 0 end,
    'outputReceiptCount', (select count(*) from private.processing_output_receipts r where r.job_id = j.id),
    'id',j.id,'videoId',j.video_id,'status',j.status,'stage',j.stage,'progress',j.progress,
    'attempt',j.attempt,'provider',j.provider,'error',j.error,'runId',j.run_id,
    'message',j.work->>'message','telemetry',j.work->'telemetry',
    'attemptStartedAt',j.attempt_started_at,'stageStartedAt',j.stage_started_at,
    'lastHeartbeatAt',j.last_heartbeat_at,'lastProgressAt',j.last_progress_at,
    'metricsReportedAt',j.metrics_reported_at,'createdAt',j.created_at,
    'updatedAt',j.updated_at,'completedAt',j.completed_at,'serverNow',now()
  )
  from public.processing_jobs j
  cross join private.content_snapshots c
  left join lateral (
    select value as video
    from jsonb_array_elements(coalesce(c.draft->'videos', '[]'::jsonb)) value
    where value->>'id' = j.video_id
    limit 1
  ) v on true
  left join lateral (
    select trash.video_id
    from private.content_video_trash trash
    where trash.environment = 'production'
      and trash.video_id = j.video_id
      and trash.restored_at is null
    limit 1
  ) t on true
  where c.environment = 'production'
  order by j.created_at desc
  limit least(greatest(p_limit, 1), 100);
end;
$$;

do $$
declare
  v_content private.content_snapshots%rowtype;
  v_finished public.processing_jobs%rowtype;
  v_failed public.processing_jobs%rowtype;
  v_finished_video jsonb;
  v_failed_video jsonb;
  v_finished_job jsonb;
  v_failed_job jsonb;
  v_draft jsonb;
begin
  select * into v_content from private.content_snapshots
  where environment = 'production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;

  if exists (
    select 1 from private.content_video_trash
    where environment = 'production'
      and video_id in ('1788926081632', '1788957611645')
      and restored_at is null
  ) then
    raise exception 'REPAIR_VIDEO_UNEXPECTEDLY_IN_TRASH';
  end if;

  select * into v_finished from public.processing_jobs
  where id = 'c295fa07-9d5f-4b3d-b1e1-1e915ac78249'::uuid
    and video_id = '1788926081632';
  if not found or v_finished.status <> 'REVIEW'
    or jsonb_typeof(v_finished.result->'sentences') <> 'array'
    or jsonb_array_length(v_finished.result->'sentences') < 1
  then raise exception 'FINISHED_VIDEO_REPAIR_SOURCE_INVALID'; end if;

  select * into v_failed from public.processing_jobs
  where id = '844257ee-6163-4437-9ce7-b3e67f557853'::uuid
    and video_id = '1788957611645';
  if not found or v_failed.status <> 'ERROR' or jsonb_typeof(v_failed.input) <> 'object'
  then raise exception 'FAILED_VIDEO_REPAIR_SOURCE_INVALID'; end if;

  insert into private.content_snapshot_backups(
    backup_key, environment, draft, published, revision, reason
  ) values (
    'before-content-integrity-repair-' || v_content.revision,
    'production', v_content.draft, v_content.published, v_content.revision,
    'Before restoring videos lost by the shared admin/student browser cache key'
  ) on conflict (backup_key) do nothing;

  v_finished_video := coalesce(v_finished.input, '{}'::jsonb)
    || coalesce(v_finished.result->'video', '{}'::jsonb)
    || jsonb_build_object(
      'id', 1788926081632,
      'status', 'REVIEW',
      'pipelineStatus', 'READY',
      'processingJobId', v_finished.id::text,
      'mediaKey', v_finished.source_key,
      'mediaUrl', '/api/media?key=' || v_finished.source_key,
      'processingEvidence', coalesce(v_finished.result->'evidence', '{}'::jsonb),
      'updatedAt', to_jsonb(now())
    );
  v_failed_video := coalesce(v_failed.input, '{}'::jsonb)
    || jsonb_build_object(
      'id', 1788957611645,
      'status', 'DRAFT',
      'pipelineStatus', 'ERROR',
      'processingJobId', v_failed.id::text,
      'mediaKey', v_failed.source_key,
      'mediaUrl', '/api/media?key=' || v_failed.source_key,
      'updatedAt', to_jsonb(now())
    );
  v_finished_job := jsonb_build_object(
    'id', v_finished.id::text, 'videoId', 1788926081632,
    'type', 'CLOUD_PIPELINE', 'status', 'REVIEW', 'currentStep', 'review',
    'progress', 100, 'error', null, 'createdAt', v_finished.created_at,
    'updatedAt', v_finished.updated_at
  );
  v_failed_job := jsonb_build_object(
    'id', v_failed.id::text, 'videoId', 1788957611645,
    'type', 'CLOUD_PIPELINE', 'status', 'ERROR', 'currentStep', v_failed.stage,
    'progress', v_failed.progress, 'error', v_failed.error,
    'createdAt', v_failed.created_at, 'updatedAt', v_failed.updated_at
  );

  v_draft := jsonb_set(v_content.draft, '{videos}',
    private.upsert_json_array_item(v_content.draft->'videos', v_finished_video, 'id'), true);
  v_draft := jsonb_set(v_draft, '{videos}',
    private.upsert_json_array_item(v_draft->'videos', v_failed_video, 'id'), true);
  v_draft := jsonb_set(v_draft, array['sentences', '1788926081632'],
    v_finished.result->'sentences', true);
  v_draft := jsonb_set(v_draft, '{jobs}',
    private.upsert_json_array_item(v_draft->'jobs', v_finished_job, 'id'), true);
  v_draft := jsonb_set(v_draft, '{jobs}',
    private.upsert_json_array_item(v_draft->'jobs', v_failed_job, 'id'), true);
  perform private.validate_content_snapshot(v_draft);

  update private.content_snapshots
  set draft = v_draft,
      revision = revision + 1,
      updated_at = now()
  where environment = 'production';
end;
$$;

revoke all on function private.assert_no_implicit_video_removal(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.admin_save_content_snapshot(jsonb) from public, anon;
revoke all on function public.admin_publish_content_snapshot(jsonb) from public, anon;
revoke all on function public.admin_save_content_snapshot_v2(jsonb, bigint) from public, anon;
revoke all on function public.admin_publish_content_snapshot_v2(jsonb, bigint) from public, anon;
revoke all on function public.admin_list_processing_jobs(integer) from public, anon;
grant execute on function public.admin_save_content_snapshot(jsonb) to authenticated;
grant execute on function public.admin_publish_content_snapshot(jsonb) to authenticated;
grant execute on function public.admin_save_content_snapshot_v2(jsonb, bigint) to authenticated;
grant execute on function public.admin_publish_content_snapshot_v2(jsonb, bigint) to authenticated;
grant execute on function public.admin_list_processing_jobs(integer) to authenticated;

comment on function private.assert_no_implicit_video_removal(jsonb, jsonb)
  is 'Only the revisioned trash RPC may remove a video from the production content catalog.';
