-- Voice files are private processing outputs. Only current published, registered
-- sentence identities may resolve them; synthesis never creates a public TTS API.
begin;

create table private.teaching_voice_assets (
  owner_job_id uuid not null,
  run_id uuid not null,
  path text not null check (path ~ '^voice/[0-9a-f]{64}\.mp3$'),
  item_id text not null check (item_id ~ '^[0-9a-f]{64}$'),
  playback_job_id uuid not null references public.processing_jobs(id) on delete cascade,
  video_id text not null,
  sentence_id text not null,
  source_text_revision bigint not null,
  kind text not null check (kind in ('token','expression')),
  local_id text not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  source_english text not null,
  source_item jsonb not null,
  primary key(owner_job_id,run_id,item_id),
  foreign key(owner_job_id,run_id,path) references private.processing_output_receipts(job_id,run_id,path) on delete cascade
);
create index teaching_voice_playback_path on private.teaching_voice_assets(playback_job_id,path);
alter table private.teaching_voice_assets enable row level security;
revoke all on private.teaching_voice_assets from public,anon,authenticated;

create table private.voice_refresh_leases (
  job_id uuid primary key references public.processing_jobs(id) on delete cascade,
  run_id uuid not null,
  token_hash text not null,
  expires_at timestamptz not null
);
alter table private.voice_refresh_leases enable row level security;
revoke all on private.voice_refresh_leases from public,anon,authenticated;

create function private.voice_source_item_v1(p_sentence jsonb,p_kind text,p_local_id text)
returns jsonb language sql immutable set search_path='' as $$
  select case when p_kind='token' then
    (select t from jsonb_array_elements(coalesce(p_sentence#>'{wordLookup,tokens}','[]'::jsonb)) t where t->>'tokenId'=p_local_id limit 1)
  when p_kind='expression' then
    (select e from jsonb_array_elements(coalesce(p_sentence->'expressions','[]'::jsonb)) with ordinality x(e,n)
      where coalesce(nullif(e->>'expressionId',''),'e'||(n-1)::text)=p_local_id
      and upper(coalesce(e->>'reviewStatus','')) not in ('REJECTED','DELETED') limit 1)
  end;
$$;

create function private.register_teaching_voice_v1(p_owner_job_id uuid,p_run_id uuid,p_playback_job_id uuid,p_video_id text,p_rows jsonb,p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item jsonb; sentence jsonb; source jsonb; v_local_id text; expected_count integer; items jsonb:='[]'::jsonb; receipt private.processing_output_receipts%rowtype;
begin
  if jsonb_typeof(p_manifest) is distinct from 'object' or p_manifest->>'status' is distinct from 'complete'
    or p_manifest->>'schemaVersion' is distinct from '1' or p_manifest->>'videoId' is distinct from p_video_id
    or jsonb_typeof(p_manifest->'items') is distinct from 'array' or jsonb_typeof(p_rows) is distinct from 'array'
    or coalesce(length(p_manifest->>'contentRevision'),0) not between 1 and 128
    then raise exception 'VOICE_MANIFEST_INVALID'; end if;
  if not exists(select 1 from public.processing_jobs where id=p_owner_job_id and video_id=p_video_id)
    or not exists(select 1 from public.processing_jobs where id=p_playback_job_id and video_id=p_video_id)
    then raise exception 'VOICE_JOB_MISMATCH'; end if;
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
    select r into sentence from jsonb_array_elements(p_rows) r where r->>'id'=item->>'sentenceId';
    source:=private.voice_source_item_v1(sentence,item->>'kind',v_local_id);
    if sentence is null or source is null or not (sentence ? 'wordLookup') or not private.learning_details_valid_v1(sentence)
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
    items:=items||jsonb_build_array(item||jsonb_build_object('ownerJobId',p_owner_job_id,'runId',p_run_id,
      'url','/api/processing/media/'||p_playback_job_id::text||'/'||receipt.path));
  end loop;
  return p_manifest||jsonb_build_object('items',items);
end $$;

-- Extend only processing output allowlists. Playback uses registry validation below.
do $migration$
declare signature text; definition text; amended text;
begin
  foreach signature in array array[
    'public.processing_record_output_v2(uuid,uuid,text,text,text,bigint,text,text)',
    'public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb)'
  ] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    amended:=replace(definition,'master\.m3u8|cover','voice/[0-9a-f]{64}\.mp3|master\.m3u8|cover');
    if amended=definition then raise exception 'VOICE_OUTPUT_FUNCTION_DRIFT: %',signature; end if;
    execute amended;
  end loop;
end $migration$;

create function public.service_begin_voice_refresh(p_job_id uuid,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.processing_jobs%rowtype; c private.content_snapshots%rowtype; token text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select * into j from public.processing_jobs where id=p_job_id and status='REVIEW' for update;
  if j.output_run_id is null or j.cancel_requested_at is not null
    or exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
    or not exists(select 1 from jsonb_array_elements(c.published->'videos') v where v->>'id'=j.video_id and v->>'processingJobId'=j.id::text and v->>'status'='PUBLISHED')
    then raise exception 'CURRENT_PUBLISHED_VIDEO_REQUIRED'; end if;
  token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into private.voice_refresh_leases(job_id,run_id,token_hash,expires_at)
    values(j.id,j.output_run_id,encode(extensions.digest(token,'sha256'),'hex'),now()+interval '6 hours')
    on conflict(job_id) do update set run_id=excluded.run_id,token_hash=excluded.token_hash,expires_at=excluded.expires_at;
  return jsonb_build_object('jobId',j.id,'runId',j.output_run_id,'token',token,'revision',c.revision,
    'existingReceipts',coalesce((select jsonb_agg(jsonb_build_object('path',r.path,'size',r.size,'sha256',r.sha256,'etag',r.etag))
      from private.processing_output_receipts r where r.job_id=j.id and r.run_id=j.output_run_id and r.path like 'voice/%'),'[]'::jsonb));
end $$;

-- Keep the existing cover upload resolver intact and add only leased voice writes.
alter function public.resolve_processing_output_v2(uuid,uuid,text,text) set schema private;
alter function private.resolve_processing_output_v2(uuid,uuid,text,text) rename to resolve_processing_output_pre_voice_v2;
revoke all on function private.resolve_processing_output_pre_voice_v2(uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.resolve_processing_output_v2(p_job_id uuid,p_run_id uuid,p_token text,p_path text)
returns table(object_key text) language sql stable security definer set search_path='' as $$
  select * from private.resolve_processing_output_pre_voice_v2(p_job_id,p_run_id,p_token,p_path)
  union all
  select 'videos/'||substring(j.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||j.id::text||'/runs/'||p_run_id::text||'/'||p_path
  from public.processing_jobs j where j.id=p_job_id and j.cancel_requested_at is null and p_path~'^voice/[0-9a-f]{64}\.mp3$'
    and not exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
    and ((j.status='RUNNING' and j.run_id=p_run_id and j.lease_until>now() and j.worker_token_expires_at>now()
      and encode(extensions.digest(p_token,'sha256'),'hex')=j.worker_token_hash)
    or (j.status='REVIEW' and j.output_run_id=p_run_id
      and exists(select 1 from private.voice_refresh_leases l where l.job_id=j.id and l.run_id=p_run_id and l.expires_at>now() and l.token_hash=encode(extensions.digest(p_token,'sha256'),'hex'))
      and not exists(select 1 from private.processing_output_receipts r where r.job_id=j.id and r.run_id=p_run_id and r.path=p_path)
      and exists(select 1 from private.content_snapshots c,jsonb_array_elements(c.published->'videos') v where c.environment='production'
        and v->>'id'=j.video_id and v->>'status'='PUBLISHED' and v->>'processingJobId'=j.id::text)));
$$;

create function public.service_commit_voice_refresh(p_job_id uuid,p_expected_revision bigint,p_manifest jsonb,p_receipts jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.content_snapshots%rowtype; j public.processing_jobs%rowtype; x jsonb; manifest jsonb; draft_manifest jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select * into j from public.processing_jobs where id=p_job_id and status='REVIEW' for update;
  if j.output_run_id is null or j.cancel_requested_at is not null
    or exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
    or not exists(select 1 from private.voice_refresh_leases l where l.job_id=j.id and l.run_id=j.output_run_id and l.expires_at>now())
    or not exists(select 1 from jsonb_array_elements(c.published->'videos') v where v->>'id'=j.video_id and v->>'processingJobId'=j.id::text and v->>'status'='PUBLISHED')
    then raise exception 'VOICE_REFRESH_STALE'; end if;
  if jsonb_typeof(p_receipts) is distinct from 'array' then raise exception 'VOICE_RECEIPTS_INVALID'; end if;
  for x in select value from jsonb_array_elements(p_receipts) loop
    if coalesce(x->>'path','')!~'^voice/[0-9a-f]{64}\.mp3$' or coalesce(x->>'size','')!~'^[1-9][0-9]{0,6}$'
      or (x->>'size')::bigint>1048576 or coalesce(x->>'sha256','')!~'^[0-9a-f]{64}$' or coalesce(length(x->>'etag'),0) not between 1 and 200
      then raise exception 'VOICE_RECEIPTS_INVALID'; end if;
    insert into private.processing_output_receipts(job_id,run_id,path,size,sha256,etag)
      values(j.id,j.output_run_id,x->>'path',(x->>'size')::bigint,x->>'sha256',x->>'etag') on conflict(job_id,run_id,path) do nothing;
    if not exists(select 1 from private.processing_output_receipts r where r.job_id=j.id and r.run_id=j.output_run_id and r.path=x->>'path'
      and r.size=(x->>'size')::bigint and r.sha256=x->>'sha256') then raise exception 'OUTPUT_RECEIPT_CONFLICT'; end if;
  end loop;
  manifest:=private.register_teaching_voice_v1(j.id,j.output_run_id,j.id,j.video_id,c.published->'sentences'->j.video_id,p_manifest);
  -- Drafts can differ from published teaching. Preserve them rather than attaching
  -- a voice manifest for another version; source-checked repair handles them later.
  if c.draft->'sentences'->j.video_id = c.published->'sentences'->j.video_id then draft_manifest:=manifest; end if;
  insert into private.catalog_field_backups(revision,reason,fields) values(c.revision,'voice-manifest:'||j.video_id,
    jsonb_build_object('videoId',j.video_id,'draft',(select v->'voiceManifest' from jsonb_array_elements(c.draft->'videos') v where v->>'id'=j.video_id),
      'published',(select v->'voiceManifest' from jsonb_array_elements(c.published->'videos') v where v->>'id'=j.video_id)));
  update private.content_snapshots set
    published=jsonb_set(published,'{videos}',(select jsonb_agg(case when v->>'id'=j.video_id then v||jsonb_build_object('voiceManifest',manifest) else v end order by n) from jsonb_array_elements(published->'videos') with ordinality t(v,n))),
    draft=case when draft_manifest is null then draft else jsonb_set(draft,'{videos}',(select jsonb_agg(case when v->>'id'=j.video_id and v->>'processingJobId'=j.id::text then v||jsonb_build_object('voiceManifest',draft_manifest) else v end order by n) from jsonb_array_elements(draft->'videos') with ordinality t(v,n))) end,
    revision=revision+1,updated_at=now() where environment='production';
  delete from private.voice_refresh_leases where job_id=j.id;
  return jsonb_build_object('videoId',j.video_id,'revision',c.revision+1,'voiceManifest',manifest);
end $$;

-- Register future uploads before the existing atomic result commit.
-- Already-running pre-rollout jobs retain their contract. Every new v5 claim
-- requires an inference-ready worker and persists the full-audio requirement.
alter function public.processing_claim_local_job_v5(text,text,integer) set schema private;
alter function private.processing_claim_local_job_v5(text,text,integer) rename to processing_claim_local_job_pre_voice_v5;
revoke all on function private.processing_claim_local_job_pre_voice_v5(text,text,integer) from public,anon,authenticated,service_role;
create function public.processing_claim_local_job_v5(p_worker_id text,p_token_hash text,p_lease_seconds integer default 180)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; updated_input jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if not exists(select 1 from public.processing_workers w where w.worker_id=p_worker_id
    and w.capabilities->'teachingVoiceV1'='true'::jsonb and w.last_seen_at>clock_timestamp()-interval '90 seconds')
    then return null; end if;
  result:=private.processing_claim_local_job_pre_voice_v5(p_worker_id,p_token_hash,p_lease_seconds);
  if result is null then return null; end if;
  update public.processing_jobs set input=input||jsonb_build_object('teachingVoiceRequired',true)
    where id=(result->>'id')::uuid returning input into updated_input;
  return jsonb_set(result,'{input}',updated_input);
end $$;
revoke all on function public.processing_claim_local_job_v5(text,text,integer) from public,anon,authenticated;
grant execute on function public.processing_claim_local_job_v5(text,text,integer) to service_role;

do $migration$
declare definition text;
begin
  definition:=pg_get_functiondef('public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb)'::regprocedure);
  if position('return public.processing_commit_result(p_job_id,p_result);' in definition)=0 then raise exception 'VOICE_COMMIT_FUNCTION_DRIFT'; end if;
  definition:=replace(definition,'return public.processing_commit_result(p_job_id,p_result);',
    'if v_job.input->''teachingVoiceRequired''=''true''::jsonb and p_result#>''{video,voiceManifest}'' is null then
       raise exception ''VOICE_MANIFEST_REQUIRED'';
     end if;
     if p_result#>''{video,voiceManifest}'' is not null then
       p_result:=jsonb_set(p_result,''{video,voiceManifest}'',private.register_teaching_voice_v1(p_job_id,p_run_id,p_job_id,v_job.video_id,p_result->''sentences'',p_result#>''{video,voiceManifest}''));
     end if;
     return public.processing_commit_result(p_job_id,p_result);');
  execute definition;
end $migration$;

alter function public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) set schema private;
alter function private.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) rename to processing_commit_learning_repair_pre_voice_v5;
revoke all on function private.processing_commit_learning_repair_pre_voice_v5(uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.processing_commit_learning_repair_v5(p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_result jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; job_row public.processing_jobs%rowtype; media_job_id uuid; manifest jsonb; snapshot jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into job_row from public.processing_jobs where id=p_job_id;
  if job_row.input->'teachingVoiceRequired'='true'::jsonb and not (p_result ? 'voiceManifest')
    then raise exception 'VOICE_MANIFEST_REQUIRED'; end if;
  result:=private.processing_commit_learning_repair_pre_voice_v5(p_job_id,p_run_id,p_token,p_worker_id,p_result);
  if p_result ? 'voiceManifest' then
    select * into job_row from public.processing_jobs where id=p_job_id;
    snapshot:=result->'snapshot';
    select (v->>'processingJobId')::uuid into media_job_id from jsonb_array_elements(snapshot->'videos') v where v->>'id'=job_row.video_id;
    manifest:=private.register_teaching_voice_v1(p_job_id,p_run_id,media_job_id,job_row.video_id,snapshot->'sentences'->job_row.video_id,p_result->'voiceManifest');
    snapshot:=jsonb_set(snapshot,'{videos}',(select jsonb_agg(case when v->>'id'=job_row.video_id then v||jsonb_build_object('voiceManifest',manifest) else v end order by n) from jsonb_array_elements(snapshot->'videos') with ordinality t(v,n)));
    update private.content_snapshots set draft=snapshot where environment='production';
    result:=jsonb_set(result,'{snapshot}',snapshot);
  end if;
  return result;
end $$;

alter function public.service_resolve_playback_access_v2(uuid,uuid,text) set schema private;
alter function private.service_resolve_playback_access_v2(uuid,uuid,text) rename to service_resolve_playback_pre_voice_v2;
revoke all on function private.service_resolve_playback_pre_voice_v2(uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.service_resolve_playback_access_v2(p_user_id uuid,p_job_id uuid,p_path text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare access jsonb; registration private.teaching_voice_assets%rowtype; owner public.processing_jobs%rowtype; prefix text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_path is null or p_path!~'^voice/[0-9a-f]{64}\.mp3$' then return private.service_resolve_playback_pre_voice_v2(p_user_id,p_job_id,p_path); end if;
  access:=private.learning_access_v2(p_user_id);
  if not coalesce((access->>'canPlay')::boolean,false) then return access; end if;
  select a.* into registration from private.teaching_voice_assets a
    join public.processing_jobs j on j.id=a.playback_job_id and j.status='REVIEW' and j.cancel_requested_at is null
    join public.processing_jobs own on own.id=a.owner_job_id and own.status='REVIEW' and own.cancel_requested_at is null
    join private.processing_output_receipts r on r.job_id=a.owner_job_id and r.run_id=a.run_id and r.path=a.path and r.size>0
    join private.content_snapshots c on c.environment='production'
    cross join lateral jsonb_array_elements(c.published->'videos') v
    cross join lateral jsonb_array_elements(coalesce(v#>'{voiceManifest,items}','[]'::jsonb)) item
    cross join lateral jsonb_array_elements(coalesce(c.published->'sentences'->a.video_id,'[]'::jsonb)) sentence
    where a.playback_job_id=p_job_id and a.path=p_path and j.video_id=a.video_id and own.video_id=a.video_id
      and v->>'id'=a.video_id and v->>'status'='PUBLISHED' and v->>'processingJobId'=p_job_id::text
      and v#>>'{voiceManifest,status}'='complete' and item->>'status'='ready'
      and item->>'itemId'=a.item_id and item->>'ownerJobId'=a.owner_job_id::text and item->>'runId'=a.run_id::text
      and item->>'fingerprint'=a.fingerprint and item->>'storagePath'=a.path and item->>'contentHash'=r.sha256
      and sentence->>'id'=a.sentence_id and coalesce(sentence->>'textRevision','1')=a.source_text_revision::text
      and sentence->>'english'=a.source_english
      and private.voice_source_item_v1(sentence,a.kind,a.local_id)=a.source_item
      and not exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=a.video_id and t.restored_at is null)
    limit 1;
  if registration.item_id is null then return access||jsonb_build_object('canPlay',false,'reason','VOICE_NOT_AVAILABLE'); end if;
  select * into owner from public.processing_jobs where id=registration.owner_job_id;
  prefix:='videos/'||substring(owner.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||owner.id::text||'/runs/'||registration.run_id::text||'/';
  if prefix is null then return access||jsonb_build_object('canPlay',false,'reason','VOICE_NOT_AVAILABLE'); end if;
  return access||jsonb_build_object('canPlay',true,'objectKey',prefix||p_path,'prefix',prefix,'path',p_path);
end $$;

revoke all on function private.voice_source_item_v1(jsonb,text,text),private.register_teaching_voice_v1(uuid,uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.service_begin_voice_refresh(uuid,bigint),public.service_commit_voice_refresh(uuid,bigint,jsonb,jsonb),
  public.service_resolve_playback_access_v2(uuid,uuid,text),public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.service_begin_voice_refresh(uuid,bigint),public.service_commit_voice_refresh(uuid,bigint,jsonb,jsonb),
  public.service_resolve_playback_access_v2(uuid,uuid,text),public.processing_commit_learning_repair_v5(uuid,uuid,text,text,jsonb) to service_role;
revoke all on function public.resolve_processing_output_v2(uuid,uuid,text,text) from public;
grant execute on function public.resolve_processing_output_v2(uuid,uuid,text,text) to anon,authenticated,service_role;
commit;
