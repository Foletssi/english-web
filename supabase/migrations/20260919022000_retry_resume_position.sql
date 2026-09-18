begin;
create or replace function public.admin_retry_processing_job(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.processing_jobs%rowtype; previous public.processing_jobs%rowtype;
begin
  if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
  perform private.assert_current_processing_job(p_job_id);
  select * into previous from public.processing_jobs where id=p_job_id for update;
  -- Retain established retry eligibility, cancellation, lease revocation and event recording.
  perform private.retry_processing_before_20260917(p_job_id);
  update public.processing_jobs set automatic_recovery_count=0,attempt=attempt+1,
    stage=case when coalesce(input->>'kind','CLOUD_PIPELINE')='CLOUD_PIPELINE' then previous.stage else stage end,
    progress=case when coalesce(input->>'kind','CLOUD_PIPELINE')='CLOUD_PIPELINE' then least(99,greatest(0,previous.progress)) else progress end,
    work=case when coalesce(input->>'kind','CLOUD_PIPELINE')='CLOUD_PIPELINE' then (coalesce(work,'{}'::jsonb)-'telemetry')||jsonb_build_object(
      'message','等待执行端校验断点，显示上次进度；已完成且有效的内容将复用',
      'resumePosition',jsonb_build_object('verified',false,'phase','validating','stage',previous.stage,'progress',previous.progress,'runId',previous.run_id)) else work end
    where id=p_job_id returning * into j;
  return to_jsonb(j);
end $$;
revoke all on function public.admin_retry_processing_job(uuid) from public,anon;
grant execute on function public.admin_retry_processing_job(uuid) to authenticated;
alter function private.processing_job_admin_summary_v1(public.processing_jobs,jsonb)
  rename to processing_job_admin_summary_before_resume_20260919;
revoke all on function private.processing_job_admin_summary_before_resume_20260919(public.processing_jobs,jsonb)
  from public,anon,authenticated,service_role;
create function private.processing_job_admin_summary_v1(p_job public.processing_jobs,p_video jsonb)
returns jsonb language sql stable set search_path='' as $$
  select private.processing_job_admin_summary_before_resume_20260919(p_job,p_video)||jsonb_build_object(
    'resumePosition',p_job.work->'resumePosition'
  );
$$;
revoke all on function private.processing_job_admin_summary_v1(public.processing_jobs,jsonb) from public,anon,authenticated,service_role;
notify pgrst, 'reload schema';
commit;
