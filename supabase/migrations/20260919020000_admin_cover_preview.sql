-- Admin-only previews of confirmed covers; published playback stays unchanged.
begin;

create function private.processing_admin_cover_preview_v1(p_job_id uuid,p_run_id uuid,p_path text default null)
returns table(path text,object_key text)
language sql stable set search_path='' as $$
  select r.path,
    'videos/'||substring(j.source_key from '^videos/([0-9a-f-]{36})/')||
      '/processed/'||j.id::text||'/runs/'||j.run_id::text||'/'||r.path
  from public.processing_jobs j
  join private.processing_output_receipts r on r.job_id=j.id and r.run_id=j.run_id
  where j.id=p_job_id and p_run_id is not null and j.run_id=p_run_id
    and j.status in ('RUNNING','ERROR','REVIEW') and j.cancel_requested_at is null
    and j.source_key ~ '^videos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    and r.path ~ '^cover(-(320|640|960))?\.webp$' and (p_path is null or r.path=p_path)
    and r.size>0 and r.size<=15728640 and r.confirmed_at is not null
    and r.sha256 ~ '^[0-9a-f]{64}$' and length(btrim(r.etag))>0
    and exists(
      select 1 from private.content_snapshots c,
        jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) v
      where c.environment='production' and v->>'id'=j.video_id
        and v->>(case when j.input->>'kind'='LEARNING_REPAIR' then 'learningRepairJobId' else 'processingJobId' end)=j.id::text
    )
    and not exists(select 1 from private.content_video_trash t
      where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
    and not exists(select 1 from private.video_deletion_jobs d
      where d.confirmed_at is not null and j.id=any(d.job_ids))
  order by case r.path when 'cover-320.webp' then 0 when 'cover.webp' then 1 when 'cover-640.webp' then 2 else 3 end
  limit 1;
$$;
revoke all on function private.processing_admin_cover_preview_v1(uuid,uuid,text) from public,anon,authenticated,service_role;

create function public.service_resolve_admin_cover_preview_v1(p_user_id uuid,p_job_id uuid,p_run_id uuid,p_path text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_access jsonb; v_key text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_access:=private.learning_access_v2(p_user_id);
  if v_access->>'kind' is distinct from 'ADMIN' or coalesce((v_access->>'canPlay')::boolean,false) is not true then
    return jsonb_build_object('canPreview',false,'reason','ADMIN_REQUIRED');
  end if;
  if p_run_id is null or p_path is null or p_path !~ '^cover(-(320|640|960))?\.webp$' then
    return jsonb_build_object('canPreview',false,'reason','MEDIA_PATH_INVALID');
  end if;
  select c.object_key into v_key from private.processing_admin_cover_preview_v1(p_job_id,p_run_id,p_path) c;
  if v_key is null then return jsonb_build_object('canPreview',false,'reason','COVER_PREVIEW_FORBIDDEN'); end if;
  return jsonb_build_object('canPreview',true,'objectKey',v_key);
end;
$$;
revoke all on function public.service_resolve_admin_cover_preview_v1(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.service_resolve_admin_cover_preview_v1(uuid,uuid,uuid,text) to service_role;

-- Wrap the installed summary instead of replacing its evolving fields.
alter function private.processing_job_admin_summary_v1(public.processing_jobs,jsonb)
  rename to processing_job_admin_summary_before_cover_20260919;
revoke all on function private.processing_job_admin_summary_before_cover_20260919(public.processing_jobs,jsonb)
  from public,anon,authenticated,service_role;
create function private.processing_job_admin_summary_v1(p_job public.processing_jobs,p_video jsonb)
returns jsonb language sql stable set search_path='' as $$
  select private.processing_job_admin_summary_before_cover_20260919(p_job,p_video)||jsonb_build_object(
    'previewCover',(select '/api/processing/media/'||p_job.id::text||'/'||c.path||'?previewRun='||p_job.run_id::text
      from private.processing_admin_cover_preview_v1(p_job.id,p_job.run_id,null) c)
  );
$$;
revoke all on function private.processing_job_admin_summary_v1(public.processing_jobs,jsonb) from public,anon,authenticated,service_role;

notify pgrst, 'reload schema';
commit;
