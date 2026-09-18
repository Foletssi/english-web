-- Keep all teaching and receipt checks; avoid copying the growing manifest per item.
begin;
create or replace function private.register_teaching_voice_v1(p_owner_job_id uuid, p_run_id uuid, p_playback_job_id uuid, p_video_id text, p_rows jsonb, p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item jsonb; sentence jsonb; source jsonb; v_local_id text; expected_count integer;
  items jsonb; sentences_by_id jsonb; receipt private.processing_output_receipts%rowtype;
begin
  if jsonb_typeof(p_manifest) is distinct from 'object' or p_manifest->>'status' is distinct from 'complete'
    or p_manifest->>'schemaVersion' is distinct from '1' or p_manifest->>'videoId' is distinct from p_video_id
    or jsonb_typeof(p_manifest->'items') is distinct from 'array' or jsonb_typeof(p_rows) is distinct from 'array'
    or coalesce(length(p_manifest->>'contentRevision'),0) not between 1 and 128
    then raise exception 'VOICE_MANIFEST_INVALID'; end if;
  if not exists(select 1 from public.processing_jobs where id=p_owner_job_id and video_id=p_video_id)
    or not exists(select 1 from public.processing_jobs where id=p_playback_job_id and video_id=p_video_id)
    then raise exception 'VOICE_JOB_MISMATCH'; end if;
  for sentence in select value from jsonb_array_elements(p_rows) loop
    if not private.learning_details_valid_v1(sentence) then raise exception 'TEACHING_DETAILS_INVALID'; end if;
  end loop;
  if (select count(distinct r->>'id') from jsonb_array_elements(p_rows) r)<>jsonb_array_length(p_rows)
    then raise exception 'VOICE_SOURCE_STALE'; end if;
  select jsonb_object_agg(r->>'id',r) into sentences_by_id from jsonb_array_elements(p_rows) r;
  select coalesce(sum(jsonb_array_length(coalesce(r#>'{wordLookup,tokens}','[]'::jsonb)) +
    (select count(*) from jsonb_array_elements(coalesce(r->'expressions','[]'::jsonb)) e where upper(coalesce(e->>'reviewStatus','')) not in ('REJECTED','DELETED'))),0)
    into expected_count from jsonb_array_elements(p_rows) r;
  if expected_count<1 or expected_count>30000 or jsonb_array_length(p_manifest->'items')<>expected_count
    or (select count(distinct i->>'itemId') from jsonb_array_elements(p_manifest->'items') i)<>expected_count
    or (select count(distinct jsonb_build_array(i->>'sentenceId',i->>'kind',case i->>'kind' when 'token' then i->>'tokenId' when 'expression' then i->>'expressionId' end)) from jsonb_array_elements(p_manifest->'items') i)<>expected_count
    then raise exception 'VOICE_MANIFEST_INCOMPLETE'; end if;
  for item in select value from jsonb_array_elements(p_manifest->'items') loop
    if item->>'status' is distinct from 'ready' or item->>'videoId' is distinct from p_video_id
      or item->>'contentRevision' is distinct from p_manifest->>'contentRevision'
      or coalesce(item->>'itemId','') !~ '^[0-9a-f]{64}$' or coalesce(item->>'fingerprint','') !~ '^[0-9a-f]{64}$'
      or item->>'storagePath' is distinct from 'voice/'||(item->>'fingerprint')||'.mp3'
      or coalesce(item->>'contentHash','') !~ '^[0-9a-f]{64}$'
      or coalesce(item->>'bytes','') !~ '^[1-9][0-9]{0,6}$' or (item->>'bytes')::bigint>1048576
      or coalesce(item->>'kind','') not in ('token','expression') then raise exception 'VOICE_ITEM_INVALID'; end if;
    v_local_id:=case item->>'kind' when 'token' then item->>'tokenId' when 'expression' then item->>'expressionId' end;
    sentence:=sentences_by_id->(item->>'sentenceId');
    source:=private.voice_source_item_v1(sentence,item->>'kind',v_local_id);
    if sentence is null or source is null or not (sentence ? 'wordLookup')
      or item->>'sourceTextRevision' is distinct from coalesce(sentence->>'textRevision','1')
      or item->>'text' is distinct from source->>'surface'
      or not private.learning_detail_text_v1(source->'coreMeaningZh',500)
      then raise exception 'VOICE_SOURCE_STALE'; end if;
    select * into receipt from private.processing_output_receipts where job_id=p_owner_job_id and run_id=p_run_id and path=item->>'storagePath';
    if receipt.path is null or receipt.size<>(item->>'bytes')::bigint or receipt.sha256<>item->>'contentHash'
      then raise exception 'VOICE_RECEIPT_MISSING'; end if;
    insert into private.teaching_voice_assets(owner_job_id,run_id,path,item_id,playback_job_id,video_id,sentence_id,source_text_revision,kind,local_id,fingerprint,source_english,source_item)
      values(p_owner_job_id,p_run_id,receipt.path,item->>'itemId',p_playback_job_id,p_video_id,item->>'sentenceId',
        (item->>'sourceTextRevision')::bigint,item->>'kind',v_local_id,item->>'fingerprint',sentence->>'english',source)
      on conflict(owner_job_id,run_id,item_id) do nothing;
    if not exists(select 1 from private.teaching_voice_assets a where a.owner_job_id=p_owner_job_id and a.run_id=p_run_id and a.item_id=item->>'itemId'
      and a.path=receipt.path and a.playback_job_id=p_playback_job_id and a.video_id=p_video_id and a.sentence_id=item->>'sentenceId'
      and a.source_text_revision=(item->>'sourceTextRevision')::bigint and a.kind=item->>'kind' and a.local_id=v_local_id
      and a.source_english=sentence->>'english' and a.source_item=source) then raise exception 'VOICE_REGISTRATION_CONFLICT'; end if;
  end loop;
  select jsonb_agg(i||jsonb_build_object('ownerJobId',p_owner_job_id,'runId',p_run_id,
    'url','/api/processing/media/'||p_playback_job_id::text||'/'||(i->>'storagePath')) order by n)
    into items from jsonb_array_elements(p_manifest->'items') with ordinality a(i,n);
  return p_manifest||jsonb_build_object('items',items);
end $$;
revoke all on function private.register_teaching_voice_v1(uuid,uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role;
commit;
