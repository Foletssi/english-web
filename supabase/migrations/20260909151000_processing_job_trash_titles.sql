-- Keep a deleted video's original title available in the retained processing history.

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
    'title', coalesce(v.video->>'title', v.video->>'titleZh', t.video->>'title', t.video->>'titleZh', j.input->>'title', j.input->>'titleZh', j.result->'video'->>'title'),
    'inputTitle', coalesce(j.input->>'title', j.input->>'titleZh'),
    'cover', coalesce(v.video->>'cover', t.video->>'cover', j.input->>'cover', j.result->'video'->>'cover'),
    'videoState', case when v.video is not null then 'ACTIVE' when t.video is not null then 'TRASHED' else 'MISSING' end,
    'canOpenVideo', v.video is not null,
    'canRetry', j.status = 'ERROR' and v.video is not null,
    'resultSentenceCount', case when jsonb_typeof(j.result->'sentences') = 'array' then jsonb_array_length(j.result->'sentences') else 0 end,
    'outputReceiptCount', (select count(*) from private.processing_output_receipts r where r.job_id = j.id),
    'status',j.status,'stage',j.stage,'progress',j.progress,
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
    select coalesce(trash.payload->'draft'->'video', trash.payload->'published'->'video') as video
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

revoke all on function public.admin_list_processing_jobs(integer) from public, anon;
grant execute on function public.admin_list_processing_jobs(integer) to authenticated;
