begin;
-- Offline operator utility only. The worker must be stopped and local source
-- reader locks held; this read-only result is not an online deletion ticket.
create function public.processing_local_cleanup_status_v1(p_worker_id text,p_source_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('allowed',exists(
    select 1 from private.processing_local_inputs li
    join public.processing_jobs original on original.id=li.job_id
    where li.source_id=p_source_id and li.worker_id=p_worker_id and original.status='REVIEW'
      and not exists(select 1 from public.processing_jobs consumer
        where consumer.source_key=original.source_key
          and consumer.input->>'kind' is distinct from 'LEARNING_REPAIR'
          and consumer.status is distinct from 'REVIEW')
  ));
$$;
revoke all on function public.processing_local_cleanup_status_v1(text,uuid) from public,anon,authenticated;
grant execute on function public.processing_local_cleanup_status_v1(text,uuid) to service_role;
notify pgrst,'reload schema';
commit;
