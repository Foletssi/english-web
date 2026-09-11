-- Durable, administrator-confirmed permanent deletion for videos already in trash.
-- Creation of this migration does not delete content. R2 deletion is executed by the bound Pages worker endpoint.

create table if not exists private.video_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  environment text not null default 'production',
  video_id text not null check(video_id~'^[0-9]+$'),
  video_title text not null,
  expected_revision bigint not null,
  requested_by uuid not null references auth.users(id),
  state text not null check(state in ('PLANNED','QUEUED','DELETING','RETRY','NEEDS_ATTENTION','DONE')),
  source_keys jsonb not null default '[]'::jsonb,
  output_prefixes jsonb not null default '[]'::jsonb,
  job_ids uuid[] not null default array[]::uuid[],
  estimated_bytes bigint not null default 0,
  deleted_bytes bigint not null default 0,
  deleted_objects integer not null default 0,
  shared_sources integer not null default 0,
  attempt integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text,
  expires_at timestamptz not null default now()+interval '15 minutes',
  confirmed_at timestamptz,
  completed_at timestamptz,
  inventory_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists video_deletion_one_active
  on private.video_deletion_jobs(environment,video_id)
  where state in ('PLANNED','QUEUED','DELETING','RETRY','NEEDS_ATTENTION');
create index if not exists video_deletion_due
  on private.video_deletion_jobs(state,lease_until,created_at)
  where state in ('QUEUED','DELETING','RETRY');
alter table private.video_deletion_jobs enable row level security;
revoke all on private.video_deletion_jobs from public,anon,authenticated;

create table if not exists private.video_deletion_items (
  deletion_id uuid not null references private.video_deletion_jobs(id) on delete cascade,
  object_key text not null,
  object_bytes bigint not null default 0 check(object_bytes>=0),
  deleted_at timestamptz,
  primary key(deletion_id,object_key)
);
alter table private.video_deletion_items enable row level security;
revoke all on private.video_deletion_items from public,anon,authenticated;

create or replace function public.admin_plan_permanent_video_delete(p_video_id text,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  c private.content_snapshots%rowtype;
  t private.content_video_trash%rowtype;
  d private.video_deletion_jobs%rowtype;
  v_video jsonb;
  v_source_keys jsonb;
  v_prefixes jsonb;
  v_job_ids uuid[];
  v_shared integer;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_video_id!~'^[0-9]+$' then raise exception 'VIDEO_ID_INVALID'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if not found or c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select * into t from private.content_video_trash where environment='production' and video_id=p_video_id and restored_at is null for update;
  if not found or lower(coalesce(t.payload->>'permanentDeleted','false'))='true' then raise exception 'TRASH_VIDEO_NOT_FOUND'; end if;
  select * into d from private.video_deletion_jobs where environment='production' and video_id=p_video_id and state in ('PLANNED','QUEUED','DELETING','RETRY','NEEDS_ATTENTION') order by created_at desc limit 1 for update;
  if found and d.confirmed_at is not null then
    return jsonb_build_object('planId',d.id,'videoId',d.video_id,'videoTitle',d.video_title,'expectedRevision',d.expected_revision,'state',d.state,'estimatedExclusiveBytes',d.estimated_bytes,'sharedObjectCount',d.shared_sources,'expiresAt',d.expires_at,'confirmedAt',d.confirmed_at);
  end if;
  if found and d.state='NEEDS_ATTENTION' then
    update private.video_deletion_jobs set state='PLANNED',expected_revision=p_expected_revision,requested_by=auth.uid(),attempt=0,last_error_code=null,expires_at=now()+interval '15 minutes',updated_at=now() where id=d.id returning * into d;
    return jsonb_build_object('planId',d.id,'videoId',d.video_id,'videoTitle',d.video_title,'expectedRevision',d.expected_revision,'state',d.state,'estimatedExclusiveBytes',d.estimated_bytes,'sharedObjectCount',d.shared_sources,'expiresAt',d.expires_at);
  end if;
  if found and not(d.state='PLANNED' and d.expires_at<=now()) then
    return jsonb_build_object('planId',d.id,'videoId',d.video_id,'videoTitle',d.video_title,'expectedRevision',d.expected_revision,'state',d.state,'estimatedExclusiveBytes',d.estimated_bytes,'sharedObjectCount',d.shared_sources,'expiresAt',d.expires_at);
  end if;
  -- An expired, unconfirmed plan is refreshed in place.  Keeping it in an
  -- active terminal state and inserting a second row violates the partial
  -- unique index for this video.
  v_video:=coalesce(t.payload->'draft'->'video',t.payload->'published'->'video','{}'::jsonb);
  select coalesce(array_agg(id order by created_at),array[]::uuid[]) into v_job_ids from public.processing_jobs where video_id=p_video_id;
  with target_keys(object_key) as (
    select source_key from public.processing_jobs where video_id=p_video_id
    union select t.payload#>>'{draft,video,mediaKey}'
    union select t.payload#>>'{published,video,mediaKey}'
  )
  select coalesce(jsonb_agg(target.object_key order by target.object_key),'[]'::jsonb) into v_source_keys
  from target_keys target
  where target.object_key~'^videos/[0-9a-f-]{36}/source\.(mp4|mov|webm|m4v)$'
    and not exists(select 1 from public.processing_jobs other_job where other_job.source_key=target.object_key and other_job.video_id<>p_video_id)
    and not exists(
      select 1 from private.content_snapshots snapshot
      cross join lateral (
        select value as video from jsonb_array_elements(coalesce(snapshot.draft->'videos','[]'::jsonb))
        union all
        select value as video from jsonb_array_elements(coalesce(snapshot.published->'videos','[]'::jsonb))
      ) ref
      where ref.video->>'id'<>p_video_id and ref.video->>'mediaKey'=target.object_key
    )
    and not exists(
      select 1 from private.content_video_trash other_trash
      where other_trash.environment='production' and other_trash.video_id<>p_video_id and other_trash.restored_at is null
        and lower(coalesce(other_trash.payload->>'permanentDeleted','false'))<>'true'
        and (other_trash.payload#>>'{draft,video,mediaKey}'=target.object_key or other_trash.payload#>>'{published,video,mediaKey}'=target.object_key)
    );
  with target_keys(object_key) as (
    select source_key from public.processing_jobs where video_id=p_video_id
    union select t.payload#>>'{draft,video,mediaKey}'
    union select t.payload#>>'{published,video,mediaKey}'
  )
  select count(*)::integer into v_shared from target_keys target
  where target.object_key~'^videos/[0-9a-f-]{36}/source\.(mp4|mov|webm|m4v)$' and (
    exists(select 1 from public.processing_jobs other_job where other_job.source_key=target.object_key and other_job.video_id<>p_video_id)
    or exists(
      select 1 from private.content_snapshots snapshot
      cross join lateral (
        select value as video from jsonb_array_elements(coalesce(snapshot.draft->'videos','[]'::jsonb))
        union all
        select value as video from jsonb_array_elements(coalesce(snapshot.published->'videos','[]'::jsonb))
      ) ref
      where ref.video->>'id'<>p_video_id and ref.video->>'mediaKey'=target.object_key
    )
    or exists(
      select 1 from private.content_video_trash other_trash
      where other_trash.environment='production' and other_trash.video_id<>p_video_id and other_trash.restored_at is null
        and lower(coalesce(other_trash.payload->>'permanentDeleted','false'))<>'true'
        and (other_trash.payload#>>'{draft,video,mediaKey}'=target.object_key or other_trash.payload#>>'{published,video,mediaKey}'=target.object_key)
    )
  );
  select coalesce(jsonb_agg(prefix order by prefix),'[]'::jsonb) into v_prefixes from (
    select distinct 'videos/'||substring(j.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||j.id::text||'/' as prefix
    from public.processing_jobs j where j.video_id=p_video_id
      and not exists(select 1 from public.processing_jobs other where other.video_id<>p_video_id and (other.input::text like '%'||j.id::text||'%' or other.result::text like '%'||j.id::text||'%'))
      and not exists(select 1 from private.content_snapshots snapshot where snapshot.draft::text like '%'||j.id::text||'%' or snapshot.published::text like '%'||j.id::text||'%')
      and not exists(select 1 from private.content_video_trash other where other.environment='production' and other.video_id<>p_video_id and other.restored_at is null and other.payload::text like '%'||j.id::text||'%')
  ) prefixes;
  if d.id is not null then
    update private.video_deletion_jobs
       set video_title=coalesce(nullif(v_video->>'titleZh',''),nullif(v_video->>'title',''),'已删除视频'),
           expected_revision=p_expected_revision,requested_by=auth.uid(),state='PLANNED',
           source_keys=v_source_keys,output_prefixes=v_prefixes,job_ids=v_job_ids,
           shared_sources=coalesce(v_shared,0),attempt=0,last_error_code=null,inventory_complete=false,
           expires_at=now()+interval '15 minutes',updated_at=now()
     where id=d.id returning * into d;
  else
    insert into private.video_deletion_jobs(environment,video_id,video_title,expected_revision,requested_by,state,source_keys,output_prefixes,job_ids,shared_sources)
    values('production',p_video_id,coalesce(nullif(v_video->>'titleZh',''),nullif(v_video->>'title',''),'已删除视频'),p_expected_revision,auth.uid(),'PLANNED',v_source_keys,v_prefixes,v_job_ids,coalesce(v_shared,0)) returning * into d;
  end if;
  return jsonb_build_object('planId',d.id,'videoId',d.video_id,'videoTitle',d.video_title,'expectedRevision',d.expected_revision,'state',d.state,'estimatedExclusiveBytes',d.estimated_bytes,'sharedObjectCount',d.shared_sources,'expiresAt',d.expires_at);
end $$;

create or replace function public.deletion_assert_lease(p_deletion_id uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  perform 1 from private.video_deletion_jobs where id=p_deletion_id and lease_token=p_token
    and state='DELETING' and lease_until>clock_timestamp();
  if not found then raise exception 'DELETION_LEASE_LOST'; end if;
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.deletion_stage_items(p_deletion_id uuid,p_token uuid,p_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d private.video_deletion_jobs%rowtype;v_item jsonb;v_key text;v_bytes bigint;v_allowed boolean;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>500 then raise exception 'DELETION_ITEMS_INVALID'; end if;
  select * into d from private.video_deletion_jobs where id=p_deletion_id and lease_token=p_token and state='DELETING' and lease_until>clock_timestamp() for update;
  if not found then raise exception 'DELETION_LEASE_LOST'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_key:=coalesce(v_item->>'objectKey','');v_bytes:=greatest(0,coalesce((v_item->>'objectBytes')::bigint,0));
    select exists(select 1 from jsonb_array_elements_text(d.source_keys) k where k=v_key)
      or exists(select 1 from jsonb_array_elements_text(d.output_prefixes) p where v_key like p||'%') into v_allowed;
    if v_key='' or not v_allowed then raise exception 'DELETION_OBJECT_OUT_OF_SCOPE'; end if;
    insert into private.video_deletion_items(deletion_id,object_key,object_bytes) values(d.id,v_key,v_bytes)
    on conflict(deletion_id,object_key) do update set object_bytes=excluded.object_bytes
      where private.video_deletion_items.deleted_at is null;
  end loop;
  update private.video_deletion_jobs set lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() where id=d.id;
  return jsonb_build_object('ok',true,'staged',jsonb_array_length(p_items));
end $$;

create or replace function public.deletion_mark_inventory_complete(p_deletion_id uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  update private.video_deletion_jobs set inventory_complete=true,lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
    where id=p_deletion_id and lease_token=p_token and state='DELETING' and lease_until>clock_timestamp();
  if not found then raise exception 'DELETION_LEASE_LOST'; end if;
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.deletion_next_items(p_deletion_id uuid,p_token uuid,p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_items jsonb;
begin
  perform public.deletion_assert_lease(p_deletion_id,p_token);
  select coalesce(jsonb_agg(jsonb_build_object('objectKey',object_key,'objectBytes',object_bytes) order by object_key),'[]'::jsonb) into v_items
  from (select object_key,object_bytes from private.video_deletion_items where deletion_id=p_deletion_id and deleted_at is null order by object_key limit least(greatest(p_limit,1),500)) items;
  return v_items;
end $$;

create or replace function public.deletion_ack_items(p_deletion_id uuid,p_token uuid,p_object_keys jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count integer;v_bytes bigint;
begin
  if jsonb_typeof(p_object_keys) is distinct from 'array' or jsonb_array_length(p_object_keys)>500 then raise exception 'DELETION_ITEMS_INVALID'; end if;
  perform public.deletion_assert_lease(p_deletion_id,p_token);
  with changed as (
    update private.video_deletion_items i set deleted_at=clock_timestamp()
    where i.deletion_id=p_deletion_id and i.deleted_at is null
      and i.object_key in(select jsonb_array_elements_text(p_object_keys))
    returning i.object_bytes
  ) select count(*)::integer,coalesce(sum(object_bytes),0)::bigint into v_count,v_bytes from changed;
  update private.video_deletion_jobs set deleted_objects=deleted_objects+v_count,deleted_bytes=deleted_bytes+v_bytes,
    lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
  where id=p_deletion_id and lease_token=p_token and state='DELETING' and lease_until>clock_timestamp();
  if not found then raise exception 'DELETION_LEASE_LOST'; end if;
  return jsonb_build_object('ok',true,'acked',v_count,'bytes',v_bytes);
end $$;

create or replace function public.admin_confirm_permanent_video_delete(p_plan_id uuid,p_expected_revision bigint,p_confirmation text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.content_snapshots%rowtype;d private.video_deletion_jobs%rowtype;
begin
  if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
  if p_confirmation is distinct from 'PERMANENT_DELETE' then raise exception 'PERMANENT_DELETE_CONFIRMATION_REQUIRED'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if not found or c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select * into d from private.video_deletion_jobs where id=p_plan_id and requested_by=auth.uid() for update;
  if not found then raise exception 'DELETION_PLAN_NOT_FOUND'; end if;
  if d.confirmed_at is not null then
    return jsonb_build_object('deletionId',d.id,'videoId',d.video_id,'state',d.state);
  end if;
  if d.state is distinct from 'PLANNED' or d.expires_at<=now() then raise exception 'DELETION_PLAN_EXPIRED_OR_USED'; end if;
  if d.expected_revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  perform 1 from private.content_video_trash where environment=d.environment and video_id=d.video_id and restored_at is null and lower(coalesce(payload->>'permanentDeleted','false'))<>'true' for update;
  if not found then raise exception 'TRASH_VIDEO_NOT_FOUND'; end if;
  update public.processing_jobs set status='CANCELLED',cancel_requested_at=now(),lease_token=null,lease_until=null,worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,source_token_expires_at=null,updated_at=now() where id=any(d.job_ids);
  update private.video_deletion_jobs set state='QUEUED',confirmed_at=now(),expires_at=now()+interval '7 days',updated_at=now() where id=d.id;
  return jsonb_build_object('deletionId',d.id,'videoId',d.video_id,'state','QUEUED');
end $$;

create or replace function public.admin_get_video_deletion(p_deletion_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare d private.video_deletion_jobs%rowtype;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into d from private.video_deletion_jobs where id=p_deletion_id;
  if not found then raise exception 'DELETION_NOT_FOUND'; end if;
  return jsonb_build_object('deletionId',d.id,'videoId',d.video_id,'videoTitle',d.video_title,'state',d.state,'deletedObjects',d.deleted_objects,'deletedBytes',d.deleted_bytes,'sharedSources',d.shared_sources,'lastErrorCode',d.last_error_code,'confirmedAt',d.confirmed_at,'createdAt',d.created_at,'completedAt',d.completed_at);
end $$;

create or replace function public.deletion_claim_job(p_worker_id text,p_lease_seconds integer default 45)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d private.video_deletion_jobs%rowtype;v_token uuid:=gen_random_uuid();
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into d from private.video_deletion_jobs where state in ('QUEUED','DELETING','RETRY') and (lease_until is null or lease_until<now()) order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  update private.video_deletion_jobs set state='DELETING',attempt=attempt+1,lease_token=v_token,lease_until=now()+make_interval(secs=>least(greatest(p_lease_seconds,15),120)),last_error_code=null,updated_at=now() where id=d.id returning * into d;
  return jsonb_build_object('id',d.id,'videoId',d.video_id,'token',v_token,'sourceKeys',d.source_keys,'outputPrefixes',d.output_prefixes,'attempt',d.attempt,'workerId',p_worker_id);
end $$;

create or replace function public.deletion_record_progress(p_deletion_id uuid,p_token uuid,p_object_count integer,p_bytes bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  update private.video_deletion_jobs set deleted_objects=deleted_objects+greatest(p_object_count,0),deleted_bytes=deleted_bytes+greatest(p_bytes,0),lease_until=now()+interval '45 seconds',updated_at=now() where id=p_deletion_id and lease_token=p_token and state='DELETING';
  if not found then raise exception 'DELETION_LEASE_LOST'; end if;
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.deletion_fail_job(p_deletion_id uuid,p_token uuid,p_error_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  update private.video_deletion_jobs set state=case when attempt>=8 then 'NEEDS_ATTENTION' else 'RETRY' end,last_error_code=left(coalesce(p_error_code,'DELETION_FAILED'),120),lease_token=null,lease_until=case when attempt>=8 then null else now()+least(attempt,5)*interval '1 minute' end,updated_at=now() where id=p_deletion_id and lease_token=p_token;
  if not found then raise exception 'DELETION_LEASE_LOST'; end if;
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.deletion_finalize_job(p_deletion_id uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d private.video_deletion_jobs%rowtype;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into d from private.video_deletion_jobs where id=p_deletion_id and lease_token=p_token and state='DELETING' for update;
  if not found then raise exception 'DELETION_LEASE_LOST'; end if;
  if d.lease_until<=clock_timestamp() then raise exception 'DELETION_LEASE_LOST'; end if;
  if d.inventory_complete is distinct from true or exists(select 1 from private.video_deletion_items where deletion_id=d.id and deleted_at is null) then raise exception 'DELETION_INVENTORY_INCOMPLETE'; end if;
  delete from private.processing_output_receipts where job_id=any(d.job_ids);
  delete from private.processing_job_events where job_id=any(d.job_ids);
  delete from private.processing_job_runs where job_id=any(d.job_ids);
  delete from public.processing_jobs where id=any(d.job_ids);
  update private.content_video_trash set payload=jsonb_build_object('permanentDeleted',true,'videoId',d.video_id,'title',d.video_title),reason='permanent-delete',deleted_at=now() where environment=d.environment and video_id=d.video_id and restored_at is null;
  update private.video_deletion_jobs set state='DONE',lease_token=null,lease_until=null,completed_at=now(),updated_at=now() where id=d.id;
  return jsonb_build_object('deletionId',d.id,'videoId',d.video_id,'state','DONE','deletedObjects',d.deleted_objects,'deletedBytes',d.deleted_bytes);
end $$;

create or replace function public.admin_list_content_trash_v2()
returns table(video_id text,video jsonb,deleted_at timestamptz,reason text,deletion jsonb)
language plpgsql stable security definer set search_path='' as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query select t.video_id,coalesce(t.payload->'draft'->'video',t.payload->'published'->'video'),t.deleted_at,t.reason,
    case when d.id is null then null else jsonb_build_object('deletionId',d.id,'state',d.state,'deletedObjects',d.deleted_objects,'deletedBytes',d.deleted_bytes,'lastErrorCode',d.last_error_code,'confirmedAt',d.confirmed_at) end
  from private.content_video_trash t left join lateral(select x.* from private.video_deletion_jobs x where x.environment=t.environment and x.video_id=t.video_id order by x.created_at desc limit 1)d on true
  where t.environment='production' and t.restored_at is null and lower(coalesce(t.payload->>'permanentDeleted','false'))<>'true'
  order by t.deleted_at desc;
end $$;

-- Once confirmation succeeds the media can already be partially removed.  A
-- restore must therefore take the same locks as confirm and fail closed even
-- when the deletion worker later needs attention.
create or replace function public.admin_restore_content_video(p_video_id text, p_expected_revision bigint)
returns table(snapshot jsonb, revision bigint, updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_content private.content_snapshots%rowtype;
  v_trash private.content_video_trash%rowtype;
  v_video jsonb;
  v_sentences jsonb;
  v_jobs jsonb;
  v_draft jsonb;
begin
  if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
  if p_video_id is null or p_video_id !~ '^[0-9]+$' then raise exception 'VIDEO_ID_INVALID'; end if;

  select * into v_content from private.content_snapshots
  where environment = 'production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;
  if v_content.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;

  select * into v_trash from private.content_video_trash t
  where t.environment = 'production' and t.video_id = p_video_id and t.restored_at is null
  for update;
  if not found then raise exception 'TRASH_NOT_FOUND'; end if;

  -- Keep lock order aligned with confirmation: snapshot -> trash -> deletion.
  perform 1 from private.video_deletion_jobs d
  where d.environment = 'production' and d.video_id = p_video_id
    and d.confirmed_at is not null
  order by d.created_at desc limit 1 for update;
  if found then raise exception 'VIDEO_PERMANENT_DELETION_STARTED'; end if;

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
end $$;

create or replace function public.install_video_deletion_cron(p_url text,p_secret text)
returns bigint language plpgsql security definer set search_path='' as $$
declare v_id bigint;
begin
  if auth.role()<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_url!~'^https://' or length(p_secret)<24 then raise exception 'DELETION_CRON_CONFIG_INVALID'; end if;
  perform cron.unschedule(jobid) from cron.job where jobname='eastudy-video-deletion';
  select cron.schedule('eastudy-video-deletion','* * * * *',format(
    $cmd$select net.http_post(url := %L, headers := jsonb_build_object('content-type','application/json','x-deletion-worker-secret',%L), body := '{}'::jsonb);$cmd$,
    p_url,p_secret)) into v_id;
  return v_id;
end $$;

-- The operational queue shows only tasks whose video still exists in the active draft.
-- Trashed cards disappear immediately; the underlying row remains until permanent cleanup so playback mappings are not broken.
create or replace function public.admin_list_processing_jobs(p_limit integer default 50)
returns table(job jsonb) language plpgsql stable security definer set search_path='' as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return query
  select jsonb_build_object(
    'id',j.id,'videoId',j.video_id,'type',coalesce(j.input->>'kind','CLOUD_PIPELINE'),'mode',j.input->>'mode',
    'title',coalesce(v.video->>'title',v.video->>'titleZh',j.input->>'title',j.input->>'titleZh',j.result->'video'->>'title'),
    'inputTitle',coalesce(j.input->>'title',j.input->>'titleZh'),
    'cover',coalesce(v.video->>'cover',j.input->>'cover',j.result->'video'->>'cover'),
    'videoState','ACTIVE','canOpenVideo',true,'canRetry',j.status='ERROR',
    'resultSentenceCount',case when jsonb_typeof(j.result->'sentences')='array' then jsonb_array_length(j.result->'sentences') else 0 end,
    'outputReceiptCount',(select count(*) from private.processing_output_receipts r where r.job_id=j.id),
    'status',j.status,'stage',j.stage,'progress',j.progress,'attempt',j.attempt,
    'provider',j.provider,'error',j.error,'runId',j.run_id,'message',j.work->>'message',
    'telemetry',j.work->'telemetry','attemptStartedAt',j.attempt_started_at,'stageStartedAt',j.stage_started_at,
    'lastHeartbeatAt',j.last_heartbeat_at,'lastProgressAt',j.last_progress_at,'metricsReportedAt',j.metrics_reported_at,
    'leaseUntil',j.lease_until,'nextRunAt',j.next_run_at,'automaticRecoveryCount',j.automatic_recovery_count,
    'maxAutomaticRecoveries',j.max_automatic_recoveries,'createdAt',j.created_at,'updatedAt',j.updated_at,
    'completedAt',j.completed_at,'serverNow',clock_timestamp()
  )
  from public.processing_jobs j
  cross join private.content_snapshots c
  join lateral (
    select value as video from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) value
    where value->>'id'=j.video_id limit 1
  ) v on true
  where c.environment='production'
  order by j.created_at desc limit least(greatest(p_limit,1),100);
end $$;

revoke all on function public.admin_plan_permanent_video_delete(text,bigint) from public,anon;
revoke all on function public.admin_confirm_permanent_video_delete(uuid,bigint,text) from public,anon;
revoke all on function public.admin_get_video_deletion(uuid) from public,anon;
revoke all on function public.deletion_claim_job(text,integer) from public,anon,authenticated;
revoke all on function public.deletion_record_progress(uuid,uuid,integer,bigint) from public,anon,authenticated;
revoke all on function public.deletion_fail_job(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.deletion_finalize_job(uuid,uuid) from public,anon,authenticated;
revoke all on function public.deletion_assert_lease(uuid,uuid) from public,anon,authenticated;
revoke all on function public.deletion_stage_items(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.deletion_mark_inventory_complete(uuid,uuid) from public,anon,authenticated;
revoke all on function public.deletion_next_items(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.deletion_ack_items(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.install_video_deletion_cron(text,text) from public,anon,authenticated;
revoke all on function public.admin_list_processing_jobs(integer) from public,anon;
revoke all on function public.admin_list_content_trash_v2() from public,anon;
grant execute on function public.admin_plan_permanent_video_delete(text,bigint) to authenticated;
grant execute on function public.admin_confirm_permanent_video_delete(uuid,bigint,text) to authenticated;
grant execute on function public.admin_get_video_deletion(uuid) to authenticated;
grant execute on function public.deletion_claim_job(text,integer) to service_role;
grant execute on function public.deletion_record_progress(uuid,uuid,integer,bigint) to service_role;
grant execute on function public.deletion_fail_job(uuid,uuid,text) to service_role;
grant execute on function public.deletion_finalize_job(uuid,uuid) to service_role;
grant execute on function public.deletion_assert_lease(uuid,uuid) to service_role;
grant execute on function public.deletion_stage_items(uuid,uuid,jsonb) to service_role;
grant execute on function public.deletion_mark_inventory_complete(uuid,uuid) to service_role;
grant execute on function public.deletion_next_items(uuid,uuid,integer) to service_role;
grant execute on function public.deletion_ack_items(uuid,uuid,jsonb) to service_role;
grant execute on function public.install_video_deletion_cron(text,text) to service_role;
grant execute on function public.admin_list_processing_jobs(integer) to authenticated;
grant execute on function public.admin_list_content_trash_v2() to authenticated;

comment on table private.video_deletion_jobs is 'Durable administrator-confirmed cleanup state; full trash payload is redacted after R2 and database cleanup.';
