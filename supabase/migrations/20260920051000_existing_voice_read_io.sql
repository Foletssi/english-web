-- Existing voice URLs keep their ownership and source checks without spilling
-- entire video manifests or sentence arrays into temporary disk rowsets.
begin;
set local lock_timeout='2s';
create function private.processing_voice_snapshot_matches_v1(p_published jsonb,p_asset private.teaching_voice_assets,p_sha text)
returns boolean language plpgsql immutable set search_path='' as $$
declare rows jsonb:=p_published->'sentences'->p_asset.video_id; sentence jsonb;
 videos jsonb:=p_published->'videos'; video jsonb; items jsonb; item jsonb;
 row_index integer; video_index integer; item_index integer; source_matches boolean:=false;
begin
 for row_index in 0..coalesce(jsonb_array_length(rows),0)-1 loop
  sentence:=rows->row_index;
  if (sentence->>'id'=p_asset.sentence_id
    and coalesce(sentence->>'textRevision','1')=p_asset.source_text_revision::text
    and sentence->>'english'=p_asset.source_english
    and private.voice_source_item_v1(sentence,p_asset.kind,p_asset.local_id)=p_asset.source_item) is true then
   source_matches:=true;exit;
  end if;
 end loop;
 if not source_matches then return false; end if;
 for video_index in 0..coalesce(jsonb_array_length(videos),0)-1 loop
  video:=videos->video_index;
  if (video->>'id'=p_asset.video_id and video->>'status'='PUBLISHED'
    and video->>'processingJobId'=p_asset.playback_job_id::text
    and video#>>'{voiceManifest,status}'='complete') is not true then continue; end if;
  items:=video#>'{voiceManifest,items}';
  for item_index in 0..coalesce(jsonb_array_length(items),0)-1 loop
   item:=items->item_index;
   if (item->>'status'='ready' and item->>'itemId'=p_asset.item_id
     and item->>'ownerJobId'=p_asset.owner_job_id::text and item->>'runId'=p_asset.run_id::text
     and item->>'fingerprint'=p_asset.fingerprint and item->>'storagePath'=p_asset.path
     and item->>'contentHash'=p_sha) is true then return true; end if;
  end loop;
 end loop;
 return false;
end $$;
revoke all on function private.processing_voice_snapshot_matches_v1(jsonb,private.teaching_voice_assets,text)
 from public,anon,authenticated,service_role;

do $migration$
declare definition text; original text;
begin
 definition:=pg_get_functiondef('public.service_resolve_playback_access_v2(uuid,uuid,text)'::regprocedure);
 definition:=replace(definition,E'\r\n',E'\n');
 original:=$old$    cross join lateral jsonb_array_elements(c.published->'videos') v
    cross join lateral jsonb_array_elements(coalesce(v#>'{voiceManifest,items}','[]'::jsonb)) item
    cross join lateral jsonb_array_elements(coalesce(c.published->'sentences'->a.video_id,'[]'::jsonb)) sentence$old$;
 original:=replace(original,E'\r','');
 if position(original in definition)=0 then raise exception 'VOICE_READ_JOIN_DRIFT'; end if;
 definition:=replace(definition,original,'');
 original:=$old$      and v->>'id'=a.video_id and v->>'status'='PUBLISHED' and v->>'processingJobId'=p_job_id::text
      and v#>>'{voiceManifest,status}'='complete' and item->>'status'='ready'
      and item->>'itemId'=a.item_id and item->>'ownerJobId'=a.owner_job_id::text and item->>'runId'=a.run_id::text
      and item->>'fingerprint'=a.fingerprint and item->>'storagePath'=a.path and item->>'contentHash'=r.sha256
      and sentence->>'id'=a.sentence_id and coalesce(sentence->>'textRevision','1')=a.source_text_revision::text
      and sentence->>'english'=a.source_english
      and private.voice_source_item_v1(sentence,a.kind,a.local_id)=a.source_item$old$;
 original:=replace(original,E'\r','');
 if position(original in definition)=0 then raise exception 'VOICE_READ_PREDICATE_DRIFT'; end if;
 execute replace(definition,original,'      and private.processing_voice_snapshot_matches_v1(c.published,a,r.sha256)');
end $migration$;
notify pgrst,'reload schema';
commit;
