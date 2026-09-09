-- Resume the one upload that failed only because its catalog row was lost.
-- The worker keeps its local checkpoint; R2 originals and prior run history remain intact.

do $$
declare
  v_job public.processing_jobs%rowtype;
begin
  select * into v_job
  from public.processing_jobs
  where id = '844257ee-6163-4437-9ce7-b3e67f557853'::uuid
    and video_id = '1788957611645'
  for update;
  if not found then raise exception 'REPAIRED_JOB_NOT_FOUND'; end if;

  if v_job.status in ('QUEUED', 'RUNNING', 'WAITING', 'REVIEW') then
    return;
  end if;
  if v_job.status <> 'ERROR'
    or coalesce(v_job.error::text, '') not like '%VIDEO_NOT_FOUND%'
  then raise exception 'REPAIRED_JOB_UNEXPECTED_STATE'; end if;
  if v_job.attempt >= 20 then raise exception 'RETRY_LIMIT_REACHED'; end if;
  if not exists (
    select 1
    from private.content_snapshots c,
      jsonb_array_elements(coalesce(c.draft->'videos', '[]'::jsonb)) video
    where c.environment = 'production' and video->>'id' = v_job.video_id
  ) then raise exception 'REPAIRED_VIDEO_NOT_ACTIVE'; end if;
  if exists (
    select 1 from private.content_video_trash
    where environment = 'production' and video_id = v_job.video_id and restored_at is null
  ) then raise exception 'REPAIRED_VIDEO_IN_TRASH'; end if;

  insert into private.processing_job_events(job_id, run_id, kind, stage, details)
  values (
    v_job.id, v_job.run_id, 'RETRY', v_job.stage,
    jsonb_build_object('reason', 'catalog-restored', 'previousError', v_job.error)
  );
  update public.processing_jobs
  set status = 'QUEUED',
      stage = 'LOCAL_DOWNLOAD',
      progress = 0,
      attempt = attempt + 1,
      cancel_requested_at = null,
      error = null,
      lease_token = null,
      lease_until = null,
      next_run_at = now(),
      worker_id = null,
      worker_token_hash = null,
      worker_token_expires_at = null,
      source_token_hash = null,
      source_token_expires_at = null,
      completed_at = null,
      run_id = null,
      telemetry_seq = 0,
      attempt_started_at = null,
      stage_started_at = null,
      last_heartbeat_at = null,
      last_progress_at = null,
      metrics_reported_at = null,
      updated_at = now()
  where id = v_job.id;
end;
$$;
