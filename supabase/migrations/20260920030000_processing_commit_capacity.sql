-- Preserve validation while avoiding repeated conversion of large trigger rows.
begin;
create or replace function private.validate_snapshot_difficulty()
returns trigger language plpgsql security definer set search_path='' as $$
declare field text; doc jsonb; previous jsonb; video jsonb; old_video jsonb;
begin
  foreach field in array array['draft','published'] loop
    doc:=case when field='draft' then new.draft else new.published end;
    previous:=case when tg_op='UPDATE' then case when field='draft' then old.draft else old.published end else null end;
    for video in select value from jsonb_array_elements(coalesce(doc->'videos','[]'::jsonb)) loop
      -- A missing difficulty has no evidence to validate.
      if video->'difficulty' is null or video->'difficulty'='null'::jsonb then continue; end if;
      select v into old_video from jsonb_array_elements(coalesce(previous->'videos','[]'::jsonb)) v where v->>'id'=video->>'id';
      if video->'difficulty' is distinct from old_video->'difficulty'
        or doc->'sentences'->(video->>'id') is distinct from previous->'sentences'->(video->>'id') then
        perform private.validate_video_difficulty(video->'difficulty',doc->'sentences'->(video->>'id'));
      end if;
    end loop;
  end loop;
  return new;
end $$;
create or replace function private.validate_snapshot_source_references()
returns trigger language plpgsql security definer set search_path='' as $$
declare field text; doc jsonb; previous jsonb; video jsonb; object_key text;
begin
  foreach field in array array['draft','published'] loop
    doc:=case when field='draft' then new.draft else new.published end;
    previous:=case when tg_op='UPDATE' then case when field='draft' then old.draft else old.published end else null end;
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

create or replace function private.normalize_snapshot_covers()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  -- Cover resolution depends on catalog metadata, never sentence/voice payloads.
  if tg_op='INSERT' or new.draft->'collections' is distinct from old.draft->'collections'
    or new.draft->'videos' is distinct from old.draft->'videos' then
    new.draft:=private.normalize_collection_covers(new.draft);
  end if;
  if tg_op='INSERT' or new.published->'collections' is distinct from old.published->'collections'
    or new.published->'videos' is distinct from old.published->'videos' then
    new.published:=private.normalize_collection_covers(new.published);
  end if;
  return new;
end $$;
-- Bounded capacity suitable for full teaching and voice metadata.
do $migration$
declare definition text;
begin
  definition:=pg_get_functiondef('private.validate_content_snapshot(jsonb)'::regprocedure);
  if position('5242880' in definition)=0 then raise exception 'SNAPSHOT_CAPACITY_DRIFT'; end if;
  execute replace(definition,'5242880','33554432');
end $migration$;
-- Store a compact worker acknowledgement; admin snapshot contracts stay intact.
do $migration$
declare definition text; marker text;
begin
  definition:=pg_get_functiondef('public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb)'::regprocedure);
  marker:='v_result:=private.processing_commit_leased_result_pre_receipt_v2(p_job_id,p_run_id,p_token,p_worker_id,p_result,p_manifest);';
  if position(marker in definition)=0 then raise exception 'COMMIT_RECEIPT_CAPACITY_DRIFT'; end if;
  execute replace(definition,marker,marker||E'\n  v_result:=v_result-''snapshot'';');
end $migration$;
-- PostgREST hoists these settings to transaction scope for this endpoint only.
alter function public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb) set statement_timeout='60s';
alter function public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb) set lock_timeout='2s';
notify pgrst,'reload schema';
commit;
