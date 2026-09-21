-- Keep video cards and the processing queue aligned when an existing job is retried.

create or replace function private.sync_processing_retry_snapshot_v1(
  p_job public.processing_jobs
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content private.content_snapshots%rowtype;
  v_video jsonb;
  v_display jsonb;
  v_pointer text;
begin
  select * into v_content
  from private.content_snapshots
  where environment = 'production'
  for update;
  if not found then return; end if;

  select value into v_video
  from jsonb_array_elements(coalesce(v_content.draft->'videos', '[]'::jsonb)) value
  where value->>'id' = p_job.video_id
  limit 1;
  if v_video is null then return; end if;

  v_pointer := case when p_job.input->>'kind' = 'LEARNING_REPAIR'
    then 'learningRepairJobId' else 'processingJobId' end;
  v_video := (v_video - 'processingError')
    || jsonb_build_object(
      'pipelineStatus', 'PROCESSING',
      v_pointer, p_job.id::text,
      'updatedAt', clock_timestamp()
    );
  v_display := private.processing_job_admin_summary_v1(p_job, v_video);
  v_content.draft := jsonb_set(
    v_content.draft,
    '{videos}',
    private.upsert_json_array_item(v_content.draft->'videos', v_video, 'id'),
    true
  );
  v_content.draft := jsonb_set(
    v_content.draft,
    '{jobs}',
    private.upsert_json_array_item(v_content.draft->'jobs', v_display, 'id'),
    true
  );
  perform private.validate_content_snapshot(v_content.draft);
  update private.content_snapshots
  set draft = v_content.draft,
      revision = revision + 1,
      updated_at = clock_timestamp()
  where environment = 'production';
end;
$$;

create or replace function public.admin_retry_processing_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  j public.processing_jobs%rowtype;
  previous public.processing_jobs%rowtype;
begin
  if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
  perform private.assert_current_processing_job(p_job_id);
  select * into previous from public.processing_jobs where id=p_job_id for update;
  perform private.retry_processing_before_20260917(p_job_id);
  update public.processing_jobs set automatic_recovery_count=0,attempt=attempt+1,
    stage=case when coalesce(input->>'kind','CLOUD_PIPELINE')='CLOUD_PIPELINE' then previous.stage else stage end,
    progress=case when coalesce(input->>'kind','CLOUD_PIPELINE')='CLOUD_PIPELINE' then least(99,greatest(0,previous.progress)) else progress end,
    work=case when coalesce(input->>'kind','CLOUD_PIPELINE')='CLOUD_PIPELINE' then (coalesce(work,'{}'::jsonb)-'telemetry')||jsonb_build_object(
      'message','等待执行端校验断点，显示上次进度；已完成且有效的内容将复用',
      'resumePosition',jsonb_build_object('verified',false,'phase','validating','stage',previous.stage,'progress',previous.progress,'runId',previous.run_id)) else work end
    where id=p_job_id returning * into j;
  perform private.sync_processing_retry_snapshot_v1(j);
  return to_jsonb(j);
end;
$$;

revoke all on function private.sync_processing_retry_snapshot_v1(public.processing_jobs) from public,anon,authenticated;
revoke all on function public.admin_retry_processing_job(uuid) from public,anon;
grant execute on function public.admin_retry_processing_job(uuid) to authenticated;
