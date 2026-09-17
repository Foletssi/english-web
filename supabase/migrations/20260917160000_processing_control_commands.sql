begin;
create table private.processing_control_commands (
  request_id uuid primary key,
  job_id uuid not null references public.processing_jobs(id) on delete cascade,
  actor uuid not null,
  action text not null check(action in ('cancel','retry_failed_stage')),
  expected_run_id uuid,
  expected_updated_at timestamptz not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table private.processing_control_commands enable row level security;
revoke all on private.processing_control_commands from public,anon,authenticated;

create function public.admin_control_processing_job_v1(
 p_job_id uuid,p_expected_run_id uuid,p_expected_updated_at timestamptz,
 p_action text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.processing_jobs%rowtype; receipt private.processing_control_commands%rowtype; response jsonb;
begin
 if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
 if p_request_id is null or p_expected_updated_at is null or p_action is null
    or p_action not in ('cancel','retry_failed_stage') then raise exception 'INVALID_PROCESSING_COMMAND'; end if;
 -- Serialize duplicate requests, then preserve the global snapshot -> job lock order.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text,0));
 select * into receipt from private.processing_control_commands where request_id=p_request_id;
 if found then
   if receipt.actor is distinct from auth.uid() or receipt.job_id<>p_job_id or receipt.action<>p_action
     or receipt.expected_run_id is distinct from p_expected_run_id
     or receipt.expected_updated_at is distinct from p_expected_updated_at
   then raise exception 'PROCESSING_COMMAND_CONFLICT'; end if;
   return receipt.result;
 end if;
 perform private.assert_current_processing_job(p_job_id);
 select * into j from public.processing_jobs where id=p_job_id for update;
 if j.run_id is distinct from p_expected_run_id then raise exception 'PROCESSING_STATE_CHANGED'; end if;
 -- Running progress updates are normal; run identity fences them. Queued/error states
 -- have no reliable new run yet, so also compare the observed update timestamp.
 if j.status<>'RUNNING' and j.updated_at is distinct from p_expected_updated_at
 then raise exception 'PROCESSING_STATE_CHANGED'; end if;
 if p_action='retry_failed_stage' then
   if j.status not in ('ERROR','CANCELLED') then raise exception 'JOB_NOT_RETRYABLE'; end if;
   if j.input->>'kind'='MEDIA_REENCODE' then raise exception 'MEDIA_REENCODE_OPERATOR_REQUIRED'; end if;
   response:=public.admin_retry_processing_job(p_job_id);
 else
   if j.status not in ('RUNNING','QUEUED','WAITING') then raise exception 'JOB_NOT_CANCELLABLE'; end if;
   update private.processing_job_runs set ended_at=clock_timestamp(),outcome='CANCELLED'
     where job_id=j.id and run_id=j.run_id and ended_at is null;
   update public.processing_jobs set status='CANCELLED',cancel_requested_at=clock_timestamp(),
     lease_token=null,lease_until=null,worker_token_hash=null,worker_token_expires_at=null,
     source_token_hash=null,source_token_expires_at=null,completed_at=clock_timestamp(),
     error=jsonb_build_object('code','ADMIN_CANCELLED','message','已取消处理，可从有效检查点继续。'),
     updated_at=clock_timestamp() where id=p_job_id returning * into j;
   response:=to_jsonb(j);
 end if;
 insert into private.processing_control_commands(request_id,job_id,actor,action,expected_run_id,expected_updated_at,result)
 values(p_request_id,p_job_id,auth.uid(),p_action,p_expected_run_id,p_expected_updated_at,response);
 return response;
end $$;
revoke all on function public.admin_control_processing_job_v1(uuid,uuid,timestamptz,text,uuid) from public,anon;
grant execute on function public.admin_control_processing_job_v1(uuid,uuid,timestamptz,text,uuid) to authenticated;
create or replace function public.admin_list_processing_video_groups_v1(p_page integer default 1,p_page_size integer default 50)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_page integer:=greatest(coalesce(p_page,1),1); v_size integer:=least(greatest(coalesce(p_page_size,50),1),100); v_total bigint; v_items jsonb; v_summary jsonb;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;

  with eligible as (
    select j.video_id,j.updated_at,j.status,j.id,coalesce(j.id::text=v.video->>'processingJobId',false) or coalesce(j.id::text=v.video->>'learningRepairJobId',false) is_current
    from public.processing_jobs j
    cross join private.content_snapshots c
    join lateral (
      select value video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) value
      where value->>'id'=j.video_id limit 1
    ) v on true
    where c.environment='production'
      and not exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
  ), representative as (
    select distinct on(video_id) video_id,status
    from eligible order by video_id,is_current desc,(status in ('RUNNING','QUEUED','WAITING')) desc,
      updated_at desc,id
  ) select count(*),jsonb_build_object(
    'active',count(*) filter(where status in ('RUNNING','QUEUED','WAITING')),
    'failed',count(*) filter(where status='ERROR'),'review',count(*) filter(where status='REVIEW'),
    'completed',count(*) filter(where status not in ('RUNNING','QUEUED','WAITING','ERROR','REVIEW','CANCELLED')),
    'cancelled',count(*) filter(where status='CANCELLED'),'total',count(*))
  into v_total,v_summary from representative;

  with eligible as (
    select j.video_id,j.updated_at,v.video
    from public.processing_jobs j
    cross join private.content_snapshots c
    join lateral (
      select value video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) value
      where value->>'id'=j.video_id limit 1
    ) v on true
    where c.environment='production'
      and not exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
  ), latest as (
    select distinct on (video_id) video_id,video,updated_at newest
    from eligible order by video_id,updated_at desc
  ), page_videos as (
    select * from latest order by newest desc,video_id
    offset (v_page-1)*v_size limit v_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'videoId',p.video_id,'video',p.video,'recordCount',(select count(*) from public.processing_jobs c where c.video_id=p.video_id),
    'records',coalesce((select jsonb_agg(private.processing_job_admin_summary_v1(j,p.video) order by j.updated_at desc,j.id)
      from (select x.* from public.processing_jobs x where x.video_id=p.video_id order by (coalesce(x.id::text=p.video->>'processingJobId',false) or coalesce(x.id::text=p.video->>'learningRepairJobId',false)) desc,(x.status in ('RUNNING','QUEUED','WAITING')) desc,x.updated_at desc,x.id limit 5) j),'[]'::jsonb)
  ) order by p.newest desc,p.video_id),'[]'::jsonb) into v_items from page_videos p;

  return jsonb_build_object('items',v_items,'summary',v_summary,'total',v_total,'page',v_page,'pageSize',v_size,'serverNow',clock_timestamp());
end;
$$;
commit;
