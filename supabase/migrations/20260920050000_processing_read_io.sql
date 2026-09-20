-- Remove voice manifests before a set-returning function can spill video rows.
-- Only read projections change; stored content and access predicates stay intact.
begin;
set local lock_timeout='2s';

create function private.processing_video_headers_v1(p_videos jsonb)
returns setof jsonb language plpgsql immutable set search_path='' as $$
declare item_index integer;
begin
  for item_index in 0..coalesce(jsonb_array_length(p_videos),0)-1 loop
    return next (p_videos->item_index)-'voiceManifest';
  end loop;
end $$;
revoke all on function private.processing_video_headers_v1(jsonb)
  from public,anon,authenticated,service_role;

do $migration$
declare signature text; definition text; original text; replacement text;
begin
  foreach signature in array array[
    'public.admin_list_processing_video_groups_v1(integer,integer)',
    'public.admin_list_processing_video_history_v1(text,integer,integer)',
    'public.admin_get_processing_job_v1(uuid)',
    'private.processing_admin_cover_preview_v1(uuid,uuid,text)',
    'private.service_resolve_playback_pre_voice_v2(uuid,uuid,text)'
  ] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    original:='jsonb_array_elements(coalesce(c.draft->''videos'',''[]''::jsonb))';
    replacement:='private.processing_video_headers_v1(c.draft->''videos'')';
    if signature like 'private.service_resolve_playback%' then
      original:='jsonb_array_elements(coalesce(c.published->''videos'',''[]''::jsonb))';
      replacement:='private.processing_video_headers_v1(c.published->''videos'')';
    end if;
    if position(original in definition)=0 then
      raise exception 'PROCESSING_READ_PROJECTION_DRIFT: %',signature;
    end if;
    execute replace(definition,original,replacement);
  end loop;

  -- Sort IDs first, then read the five chosen job records. A completed job's
  -- input/result can contain megabytes of sentences and voice metadata.
  definition:=pg_get_functiondef('public.admin_list_processing_video_groups_v1(integer,integer)'::regprocedure);
  original:='from (select x.* from public.processing_jobs x where x.video_id=p.video_id';
  if position(original in definition)=0 then raise exception 'PROCESSING_READ_JOB_SORT_DRIFT'; end if;
  definition:=replace(definition,original,'from (select x.id from public.processing_jobs x where x.video_id=p.video_id');
  original:='x.updated_at desc,x.id limit 5) j)';
  if position(original in definition)=0 then raise exception 'PROCESSING_READ_JOB_JOIN_DRIFT'; end if;
  definition:=replace(definition,original,'x.updated_at desc,x.id limit 5) selected join public.processing_jobs j on j.id=selected.id)');
  execute definition;
end $migration$;

notify pgrst,'reload schema';
commit;
