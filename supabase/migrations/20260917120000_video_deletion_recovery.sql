-- Forward-only recovery; does not confirm or execute any deletion.
begin;

-- Preserve the deployed validators and their lock order. An unconfirmed plan
-- belongs to one administrator and one content revision; a changed owner or
-- revision must rebuild its exact scope before a new confirmation is shown.
do $migration$
declare definition text; anchor text; replacement text;
begin
  definition:=replace(pg_get_functiondef('public.admin_plan_permanent_video_delete(text,bigint)'::regprocedure),E'\r\n',E'\n');
  anchor:=$old$if found and not(d.state='PLANNED' and d.expires_at<=now()) then$old$;
  replacement:=$new$if found and d.state='PLANNED' and d.expires_at>now()
    and d.requested_by=auth.uid() and d.expected_revision=p_expected_revision then$new$;
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
    raise exception 'DELETION_PLAN_RECOVERY_PATCH_TARGET_MISMATCH';
  end if;
  execute replace(definition,anchor,replacement);

  -- admin_create_processing_job already holds the same content-snapshot lock
  -- as confirmation. Before confirmation, a new reference increments revision
  -- and forces replanning; after confirmation, this exact-key fence rejects it.
  -- Keep the fence after DONE as those source objects have already been erased.
  definition:=replace(pg_get_functiondef('public.admin_create_processing_job(jsonb,text,text,bigint)'::regprocedure),E'\r\n',E'\n');
  anchor:=$old$  select * into v_job from public.processing_jobs
  where requested_by=auth.uid() and idempotency_key=p_idempotency_key;$old$;
  replacement:=$new$  if exists(
    select 1 from private.video_deletion_jobs d
    where d.environment='production' and d.confirmed_at is not null
      and d.source_keys ? p_source_key
  ) then raise exception 'SOURCE_PERMANENT_DELETION_STARTED'; end if;

  select * into v_job from public.processing_jobs
  where requested_by=auth.uid() and idempotency_key=p_idempotency_key;$new$;
  if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
    raise exception 'DELETION_SOURCE_FENCE_PATCH_TARGET_MISMATCH';
  end if;
  execute replace(definition,anchor,replacement);
end $migration$;

-- Cover every snapshot writer, including direct draft saves and publication.
-- UPDATE already owns the snapshot row lock shared with deletion confirmation.
-- Compare references, not whole videos: removals and unrelated edits remain
-- allowed, and preserved shared sources are absent from deletion.source_keys.
create function private.validate_snapshot_source_references()
returns trigger language plpgsql security definer set search_path='' as $$
declare field text; doc jsonb; previous jsonb; video jsonb; object_key text;
begin
  foreach field in array array['draft','published'] loop
    doc:=to_jsonb(new)->field;
    previous:=case when tg_op='UPDATE' then to_jsonb(old)->field else null end;
    for video in select value from jsonb_array_elements(coalesce(doc->'videos','[]'::jsonb)) loop
      object_key:=nullif(video->>'mediaKey','');
      if object_key is not null
        and not exists(
          select 1 from jsonb_array_elements(coalesce(previous->'videos','[]'::jsonb)) prior
          where prior->>'id' is not distinct from video->>'id' and prior->>'mediaKey'=object_key
        )
        and exists(
          select 1 from private.video_deletion_jobs d
          where d.environment=new.environment and d.confirmed_at is not null
            and d.source_keys ? object_key
        ) then raise exception 'SOURCE_PERMANENT_DELETION_STARTED'; end if;
    end loop;
  end loop;
  return new;
end $$;
revoke all on function private.validate_snapshot_source_references() from public,anon,authenticated;
create trigger validate_snapshot_source_references before insert or update of draft,published
on private.content_snapshots for each row execute function private.validate_snapshot_source_references();

create or replace function public.admin_video_deletion_health()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
  return jsonb_build_object('schedulerReady', exists(
    select 1 from cron.job where jobname='eastudy-video-deletion' and active
      and command like '%https://english-web-lce.pages.dev/api/admin/video-deletions/run%'
  ));
end $$;

create or replace function public.admin_retry_video_deletion(p_deletion_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d private.video_deletion_jobs%rowtype;
begin
  if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
  select * into d from private.video_deletion_jobs where id=p_deletion_id for update;
  if not found then raise exception 'DELETION_NOT_FOUND'; end if;
  if d.confirmed_at is null then raise exception 'PERMANENT_DELETE_CONFIRMATION_REQUIRED'; end if;
  if d.state='NEEDS_ATTENTION' then
    -- Keep the confirmed scope and acknowledged objects; never make a partly
    -- deleted video restorable, and never generate a second deletion job.
    update private.video_deletion_jobs
      set state='QUEUED',attempt=0,lease_token=null,lease_until=null,
          last_error_code=null,updated_at=clock_timestamp()
      where id=d.id;
  elsif d.state not in ('QUEUED','DELETING','RETRY','DONE') then
    raise exception 'DELETION_STATE_INVALID';
  end if;
  return public.admin_get_video_deletion(d.id);
end $$;

revoke all on function public.admin_video_deletion_health() from public,anon;
revoke all on function public.admin_retry_video_deletion(uuid) from public,anon;
grant execute on function public.admin_video_deletion_health() to authenticated;
grant execute on function public.admin_retry_video_deletion(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
