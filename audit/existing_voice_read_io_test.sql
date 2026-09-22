-- Run after 20260922043000. Read-only verification of the clean voice projection.
do $test$
declare row record; manifest jsonb; rows jsonb; video jsonb;
begin
  if to_regprocedure('private.processing_voice_snapshot_matches_v1(jsonb,private.teaching_voice_assets,text)') is not null then
    raise exception 'LEGACY_VOICE_SNAPSHOT_HELPER_RETAINED';
  end if;
  if has_function_privilege('anon','private.teaching_voice_manifest_v2(text,uuid,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','private.teaching_voice_manifest_v2(text,uuid,jsonb)','EXECUTE')
    or has_function_privilege('service_role','private.teaching_voice_manifest_v2(text,uuid,jsonb)','EXECUTE') then
    raise exception 'VOICE_PROJECTION_HELPER_EXPOSED';
  end if;
  if exists(select 1 from private.content_snapshots c
    cross join lateral jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) v
    where c.environment='production' and jsonb_typeof(v#>'{voiceManifest,items}')='array')
    or exists(select 1 from private.content_snapshots c
    cross join lateral jsonb_array_elements(coalesce(c.published->'videos','[]'::jsonb)) v
    where c.environment='production' and jsonb_typeof(v#>'{voiceManifest,items}')='array') then
    raise exception 'VOICE_ITEMS_STILL_EMBEDDED_IN_SNAPSHOT';
  end if;
  for row in select b.* from private.teaching_voice_batches b loop
    if (select count(*) from private.teaching_voice_assets a
      join private.processing_output_receipts r on r.job_id=a.owner_job_id and r.run_id=a.run_id and r.path=a.path
      where a.owner_job_id=row.owner_job_id and a.run_id=row.run_id)<>row.item_count then
      raise exception 'VOICE_BATCH_INCOMPLETE: %/%',row.owner_job_id,row.run_id;
    end if;
    select c.draft->'sentences'->row.video_id,v.value into rows,video
      from private.content_snapshots c
      cross join lateral jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) v
      where c.environment='production' and v.value->>'id'=row.video_id
        and v.value->>'processingJobId'=row.playback_job_id::text limit 1;
    if video is not null then
      manifest:=private.teaching_voice_manifest_v2(row.video_id,row.playback_job_id,rows);
      if manifest is null or manifest->>'status'<>'complete'
        or jsonb_array_length(manifest->'items')<>row.item_count then
        raise exception 'VOICE_TARGETED_READ_INCOMPLETE: %',row.video_id;
      end if;
    end if;
  end loop;
end $test$;
select jsonb_build_object(
  'snapshotDraftBytes',(select octet_length(draft::text) from private.content_snapshots where environment='production'),
  'voiceBatches',(select count(*) from private.teaching_voice_batches),
  'voiceAssets',(select count(*) from private.teaching_voice_assets)) as voice_projection_checks;
