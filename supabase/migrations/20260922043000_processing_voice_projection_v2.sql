-- Clean break for teaching voice storage.
-- The catalog keeps only a small voice header; registered audio items remain in
-- private.teaching_voice_assets and are assembled on the targeted read paths.
begin;
set local lock_timeout='2s';
set local statement_timeout='15min';

create table if not exists private.teaching_voice_batches (
  owner_job_id uuid not null,
  run_id uuid not null,
  playback_job_id uuid not null references public.processing_jobs(id) on delete cascade,
  video_id text not null,
  content_revision text not null,
  manifest jsonb not null check (jsonb_typeof(manifest)='object' and not (manifest ? 'items')),
  item_count integer not null check (item_count between 1 and 30000),
  created_at timestamptz not null default clock_timestamp(),
  primary key(owner_job_id,run_id),
  foreign key(owner_job_id,run_id) references private.processing_job_runs(job_id,run_id) on delete cascade
);
create index if not exists teaching_voice_batches_playback
  on private.teaching_voice_batches(playback_job_id,video_id,created_at desc);
alter table private.teaching_voice_batches enable row level security;
revoke all on private.teaching_voice_batches from public,anon,authenticated,service_role;

create or replace function private.teaching_voice_manifest_header_v2(p_manifest jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare header jsonb;
begin
  if jsonb_typeof(p_manifest) is distinct from 'object' then return null; end if;
  header:=p_manifest-'items'-'ownerJobId'-'runId';
  if header->>'status' is distinct from 'complete' then
    header:=header||jsonb_build_object('status','complete');
  end if;
  return header;
end $$;
revoke all on function private.teaching_voice_manifest_header_v2(jsonb)
  from public,anon,authenticated,service_role;

-- Register the batch header alongside its already validated individual assets.
create or replace function private.register_teaching_voice_v1(
  p_owner_job_id uuid,p_run_id uuid,p_playback_job_id uuid,p_video_id text,
  p_rows jsonb,p_manifest jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  item jsonb; sentence jsonb; source jsonb; v_local_id text; expected_count integer;
  items jsonb; sentences_by_id jsonb; receipt private.processing_output_receipts%rowtype;
  header jsonb;
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
  select coalesce(sum(jsonb_array_length(coalesce(r#>'{wordLookup,tokens}','[]'::jsonb))+
    (select count(*) from jsonb_array_elements(coalesce(r->'expressions','[]'::jsonb)) e
      where upper(coalesce(e->>'reviewStatus','')) not in ('REJECTED','DELETED'))),0)
    into expected_count from jsonb_array_elements(p_rows) r;
  if expected_count<1 or expected_count>30000 or jsonb_array_length(p_manifest->'items')<>expected_count
    or (select count(distinct i->>'itemId') from jsonb_array_elements(p_manifest->'items') i)<>expected_count
    or (select count(distinct jsonb_build_array(i->>'sentenceId',i->>'kind',
      case i->>'kind' when 'token' then i->>'tokenId' when 'expression' then i->>'expressionId' end))
      from jsonb_array_elements(p_manifest->'items') i)<>expected_count
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
    select * into receipt from private.processing_output_receipts
      where job_id=p_owner_job_id and run_id=p_run_id and path=item->>'storagePath';
    if receipt.path is null or receipt.size<>(item->>'bytes')::bigint or receipt.sha256<>item->>'contentHash'
      then raise exception 'VOICE_RECEIPT_MISSING'; end if;
    insert into private.teaching_voice_assets(owner_job_id,run_id,path,item_id,playback_job_id,video_id,
      sentence_id,source_text_revision,kind,local_id,fingerprint,source_english,source_item)
      values(p_owner_job_id,p_run_id,receipt.path,item->>'itemId',p_playback_job_id,p_video_id,item->>'sentenceId',
        (item->>'sourceTextRevision')::bigint,item->>'kind',v_local_id,item->>'fingerprint',sentence->>'english',source)
      on conflict(owner_job_id,run_id,item_id) do nothing;
    if not exists(select 1 from private.teaching_voice_assets a where a.owner_job_id=p_owner_job_id
      and a.run_id=p_run_id and a.item_id=item->>'itemId' and a.path=receipt.path
      and a.playback_job_id=p_playback_job_id and a.video_id=p_video_id and a.sentence_id=item->>'sentenceId'
      and a.source_text_revision=(item->>'sourceTextRevision')::bigint and a.kind=item->>'kind'
      and a.local_id=v_local_id and a.source_english=sentence->>'english' and a.source_item=source)
      then raise exception 'VOICE_REGISTRATION_CONFLICT'; end if;
  end loop;
  header:=private.teaching_voice_manifest_header_v2(p_manifest);
  insert into private.teaching_voice_batches(owner_job_id,run_id,playback_job_id,video_id,content_revision,manifest,item_count)
    values(p_owner_job_id,p_run_id,p_playback_job_id,p_video_id,p_manifest->>'contentRevision',header,expected_count)
    on conflict(owner_job_id,run_id) do update set playback_job_id=excluded.playback_job_id,
      video_id=excluded.video_id,content_revision=excluded.content_revision,
      manifest=excluded.manifest,item_count=excluded.item_count;
  select jsonb_agg(i||jsonb_build_object('ownerJobId',p_owner_job_id,'runId',p_run_id,
    'url','/api/processing/media/'||p_playback_job_id::text||'/'||(i->>'storagePath')) order by n)
    into items from jsonb_array_elements(p_manifest->'items') with ordinality a(i,n);
  return header||jsonb_build_object('items',items);
end $$;
revoke all on function private.register_teaching_voice_v1(uuid,uuid,uuid,text,jsonb,jsonb)
  from public,anon,authenticated,service_role;

create or replace function private.processing_compact_snapshot_v1(p_snapshot jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select p_snapshot||jsonb_build_object('videos',coalesce((select jsonb_agg(v.value-'voiceManifest' order by v.ordinality)
    from jsonb_array_elements(coalesce(p_snapshot->'videos','[]'::jsonb)) with ordinality v),'[]'::jsonb));
$$;
revoke all on function private.processing_compact_snapshot_v1(jsonb)
  from public,anon,authenticated,service_role;

create or replace function private.teaching_voice_manifest_v2(
  p_video_id text,p_playback_job_id uuid,p_sentences jsonb
)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  expected_count integer; batch record; items jsonb; actual_count integer;
begin
  if jsonb_typeof(p_sentences) is distinct from 'array' then return null; end if;
  select coalesce(sum(jsonb_array_length(coalesce(r#>'{wordLookup,tokens}','[]'::jsonb))+
    (select count(*) from jsonb_array_elements(coalesce(r->'expressions','[]'::jsonb)) e
      where upper(coalesce(e->>'reviewStatus','')) not in ('REJECTED','DELETED'))),0)
    into expected_count from jsonb_array_elements(p_sentences) r;
  if expected_count<1 then return null; end if;
  for batch in
    select b.* from private.teaching_voice_batches b
    where b.playback_job_id=p_playback_job_id and b.video_id=p_video_id and b.item_count=expected_count
      and (select count(*) from private.teaching_voice_assets a
        join public.processing_jobs own on own.id=a.owner_job_id and own.status='REVIEW' and own.cancel_requested_at is null
        join private.processing_output_receipts r on r.job_id=a.owner_job_id and r.run_id=a.run_id and r.path=a.path and r.size>0
        where a.owner_job_id=b.owner_job_id and a.run_id=b.run_id and a.playback_job_id=b.playback_job_id
          and a.video_id=b.video_id)=expected_count
      and not exists(select 1 from private.teaching_voice_assets a
        where a.owner_job_id=b.owner_job_id and a.run_id=b.run_id and a.playback_job_id=b.playback_job_id
          and a.video_id=b.video_id and not exists(select 1 from jsonb_array_elements(p_sentences) s
            where s->>'id'=a.sentence_id and coalesce(s->>'textRevision','1')=a.source_text_revision::text
              and s->>'english'=a.source_english
              and private.voice_source_item_v1(s,a.kind,a.local_id)=a.source_item))
    order by b.created_at desc
  loop
    select jsonb_agg(
      jsonb_build_object('status','ready','videoId',a.video_id,'contentRevision',batch.content_revision,
        'sentenceId',a.sentence_id,'sourceTextRevision',a.source_text_revision,'kind',a.kind,
        'itemId',a.item_id,'fingerprint',a.fingerprint,'storagePath',a.path,
        'text',a.source_item->>'surface','bytes',r.size,'contentHash',r.sha256,
        'ownerJobId',a.owner_job_id,'runId',a.run_id,
        'url','/api/processing/media/'||a.playback_job_id::text||'/'||a.path,'contentType','audio/mpeg')||
        case when a.kind='token' then jsonb_build_object('tokenId',a.local_id)
          else jsonb_build_object('expressionId',a.local_id) end||
        case when a.source_item ? 'pronunciationHint' then jsonb_build_object('pronunciationHint',a.source_item->'pronunciationHint') else '{}'::jsonb end
      order by a.sentence_id,a.kind,a.local_id)
      into items
      from private.teaching_voice_assets a
      join private.processing_output_receipts r on r.job_id=a.owner_job_id and r.run_id=a.run_id and r.path=a.path
      where a.owner_job_id=batch.owner_job_id and a.run_id=batch.run_id and a.playback_job_id=batch.playback_job_id
        and a.video_id=batch.video_id;
    actual_count:=coalesce(jsonb_array_length(items),0);
    if actual_count=expected_count then
      return batch.manifest||jsonb_build_object('status','complete','videoId',p_video_id,
        'contentRevision',batch.content_revision,'items',items,'ready',actual_count,'total',actual_count,
        'uniqueFiles',(select count(distinct a.path) from private.teaching_voice_assets a
          where a.owner_job_id=batch.owner_job_id and a.run_id=batch.run_id));
    end if;
  end loop;
  return null;
end $$;
revoke all on function private.teaching_voice_manifest_v2(text,uuid,jsonb)
  from public,anon,authenticated,service_role;

create or replace function private.processing_voice_registration_matches_v2(
  p_published jsonb,p_asset private.teaching_voice_assets,p_sha text
)
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
  return exists(select 1 from jsonb_array_elements(coalesce(p_published->'videos','[]'::jsonb)) v
    join private.teaching_voice_batches b on b.owner_job_id=p_asset.owner_job_id and b.run_id=p_asset.run_id
      and b.playback_job_id=p_asset.playback_job_id and b.video_id=p_asset.video_id
    join private.processing_output_receipts r on r.job_id=p_asset.owner_job_id and r.run_id=p_asset.run_id and r.path=p_asset.path
    where v->>'id'=p_asset.video_id and v->>'status'='PUBLISHED'
      and v->>'processingJobId'=p_asset.playback_job_id::text
      and b.manifest->>'status'='complete' and b.item_count>0
      and r.sha256=p_sha and r.size>0
      and exists(select 1 from jsonb_array_elements(coalesce(p_published->'sentences'->p_asset.video_id,'[]'::jsonb)) s
        where s->>'id'=p_asset.sentence_id and coalesce(s->>'textRevision','1')=p_asset.source_text_revision::text
          and s->>'english'=p_asset.source_english
          and private.voice_source_item_v1(s,p_asset.kind,p_asset.local_id)=p_asset.source_item));
end $$;
revoke all on function private.processing_voice_registration_matches_v2(jsonb,private.teaching_voice_assets,text)
  from public,anon,authenticated,service_role;

-- Existing manifests are copied to the batch table before their large item arrays
-- are removed from the catalog. Missing headers are rebuilt from registered rows.
do $backfill$
declare c private.content_snapshots%rowtype; field text; video jsonb; manifest jsonb; item jsonb; batch_row record; compact_draft jsonb; compact_published jsonb;
begin
  select * into c from private.content_snapshots where environment='production' for update;
  foreach field in array array['draft','published'] loop
    for video in select value from jsonb_array_elements(coalesce((case when field='draft' then c.draft else c.published end)->'videos','[]'::jsonb)) loop
      manifest:=video->'voiceManifest';
      if jsonb_typeof(manifest)='object' and jsonb_typeof(manifest->'items')='array'
        and video->>'processingJobId'~'^[0-9a-f-]{36}$' then
        for item in select value from jsonb_array_elements(manifest->'items') loop
          if item->>'ownerJobId'~'^[0-9a-f-]{36}$' and item->>'runId'~'^[0-9a-f-]{36}$' then
            insert into private.teaching_voice_batches(owner_job_id,run_id,playback_job_id,video_id,content_revision,manifest,item_count)
              values((item->>'ownerJobId')::uuid,(item->>'runId')::uuid,(video->>'processingJobId')::uuid,
                video->>'id',coalesce(manifest->>'contentRevision',item->>'contentRevision',(item->>'runId')),
                private.teaching_voice_manifest_header_v2(manifest),jsonb_array_length(manifest->'items'))
              on conflict(owner_job_id,run_id) do nothing;
            exit;
          end if;
        end loop;
      end if;
    end loop;
  end loop;
  for batch_row in select distinct a.owner_job_id,a.run_id,a.playback_job_id,a.video_id from private.teaching_voice_assets a loop
    insert into private.teaching_voice_batches(owner_job_id,run_id,playback_job_id,video_id,content_revision,manifest,item_count)
      select batch_row.owner_job_id,batch_row.run_id,batch_row.playback_job_id,batch_row.video_id,batch_row.run_id::text,
        jsonb_build_object('schemaVersion',1,'status','complete','videoId',batch_row.video_id,
          'contentRevision',batch_row.run_id::text),count(*)
      from private.teaching_voice_assets a where a.owner_job_id=batch_row.owner_job_id and a.run_id=batch_row.run_id
      group by batch_row.owner_job_id,batch_row.run_id,batch_row.playback_job_id,batch_row.video_id
      on conflict(owner_job_id,run_id) do nothing;
  end loop;
  compact_draft:=private.processing_compact_snapshot_v1(c.draft);
  compact_published:=private.processing_compact_snapshot_v1(c.published);
  if compact_draft is distinct from c.draft or compact_published is distinct from c.published then
    perform private.validate_content_snapshot(compact_draft);
    perform private.validate_content_snapshot(compact_published);
    update private.content_snapshots set draft=compact_draft,published=compact_published,
      revision=revision+1,updated_at=clock_timestamp() where environment='production';
  end if;
end $backfill$;

-- Finalization v3 already registers assets. Strip the item array before the
-- compact snapshot commit, while returning a full read manifest later.
do $patch$
declare definition text; marker text; replacement text;
begin
  definition:=pg_get_functiondef('private.processing_commit_leased_result_core(uuid,uuid,text,text,jsonb,jsonb)'::regprocedure);
  marker:='return private.commit_processing_result_v3(p_job_id,private.processing_finalize_ai_result_v1(p_result),true);';
  if position(marker in definition)=0 then raise exception 'VOICE_COMPACT_COMMIT_DRIFT'; end if;
  replacement:=E'if p_result#>''{video,voiceManifest}'' is not null then\n'
    ||E'    p_result:=jsonb_set(p_result,''{video,voiceManifest}'',\n'
    ||E'      private.teaching_voice_manifest_header_v2(p_result#>''{video,voiceManifest}''),true);\n'
    ||E'  end if;\n  '||marker;
  execute replace(definition,marker,replacement);
end $patch$;

-- Learning repair has its own commit wrapper; it must apply the same compact
-- projection after registering the repair batch.
do $patch$
declare definition text; marker text;
begin
  definition:=pg_get_functiondef('private.commit_learning_before_20260917(uuid,uuid,text,text,jsonb)'::regprocedure);
  marker:='jsonb_build_object(''voiceManifest'',manifest)';
  if position(marker in definition)=0 then raise exception 'VOICE_COMPACT_REPAIR_DRIFT'; end if;
  execute replace(definition,marker,'jsonb_build_object(''voiceManifest'',private.teaching_voice_manifest_header_v2(manifest))');
end $patch$;

-- Voice refresh returns the full registered manifest to its caller, but stores
-- only the header in draft/published content snapshots.
create or replace function public.service_commit_voice_refresh(
  p_job_id uuid,p_expected_revision bigint,p_manifest jsonb,p_receipts jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.content_snapshots%rowtype; j public.processing_jobs%rowtype; x jsonb; manifest jsonb; header jsonb; draft_header jsonb;
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
    if coalesce(x->>'path','') !~ '^voice/[0-9a-f]{64}\.mp3$' or coalesce(x->>'size','') !~ '^[1-9][0-9]{0,6}$'
      or (x->>'size')::bigint>1048576 or coalesce(x->>'sha256','') !~ '^[0-9a-f]{64}$' or coalesce(length(x->>'etag'),0) not between 1 and 200
      then raise exception 'VOICE_RECEIPTS_INVALID'; end if;
    insert into private.processing_output_receipts(job_id,run_id,path,size,sha256,etag)
      values(j.id,j.output_run_id,x->>'path',(x->>'size')::bigint,x->>'sha256',x->>'etag') on conflict(job_id,run_id,path) do nothing;
    if not exists(select 1 from private.processing_output_receipts r where r.job_id=j.id and r.run_id=j.output_run_id and r.path=x->>'path'
      and r.size=(x->>'size')::bigint and r.sha256=x->>'sha256') then raise exception 'OUTPUT_RECEIPT_CONFLICT'; end if;
  end loop;
  manifest:=private.register_teaching_voice_v1(j.id,j.output_run_id,j.id,j.video_id,c.published->'sentences'->j.video_id,p_manifest);
  header:=private.teaching_voice_manifest_header_v2(manifest);
  if c.draft->'sentences'->j.video_id = c.published->'sentences'->j.video_id then draft_header:=header; end if;
  insert into private.catalog_field_backups(revision,reason,fields) values(c.revision,'voice-manifest:'||j.video_id,
    jsonb_build_object('videoId',j.video_id,'draft',(select v->'voiceManifest' from jsonb_array_elements(c.draft->'videos') v where v->>'id'=j.video_id),
      'published',(select v->'voiceManifest' from jsonb_array_elements(c.published->'videos') v where v->>'id'=j.video_id)));
  update private.content_snapshots set
    published=jsonb_set(published,'{videos}',(select jsonb_agg(case when v->>'id'=j.video_id then v||jsonb_build_object('voiceManifest',header) else v end order by n) from jsonb_array_elements(published->'videos') with ordinality t(v,n)),true),
    draft=case when draft_header is null then draft else jsonb_set(draft,'{videos}',(select jsonb_agg(case when v->>'id'=j.video_id and v->>'processingJobId'=j.id::text then v||jsonb_build_object('voiceManifest',draft_header) else v end order by n) from jsonb_array_elements(draft->'videos') with ordinality t(v,n)),true) end,
    revision=revision+1,updated_at=now() where environment='production';
  delete from private.voice_refresh_leases where job_id=j.id;
  return jsonb_build_object('videoId',j.video_id,'revision',c.revision+1,'voiceManifest',manifest);
end $$;
-- Rebuild targeted read responses from the registered asset table.
create or replace function public.get_published_video_teaching_v1(p_video_id text,p_known_revision bigint default null)
returns table(video jsonb,sentences jsonb,revision bigint)
language plpgsql stable security definer set search_path='' as $$
declare access jsonb:=private.learning_access_v2(auth.uid()); c private.content_snapshots%rowtype; target jsonb; rows jsonb; voice jsonb;
begin
  if coalesce((access->>'canEnterLearning')::boolean,false) is not true then raise exception '%',coalesce(access->>'reason','ACCESS_DENIED') using errcode='42501'; end if;
  select * into c from private.content_snapshots where environment='production';
  select v.value into target from jsonb_array_elements(coalesce(c.published->'videos','[]'::jsonb)) v
    where v.value->>'id'=p_video_id and v.value->>'status'='PUBLISHED';
  if target is null then raise exception 'VIDEO_NOT_FOUND' using errcode='22023'; end if;
  rows:=coalesce(c.published->'sentences'->p_video_id,'[]'::jsonb);
  if target->>'processingJobId'~'^[0-9a-f-]{36}$' then
    voice:=private.teaching_voice_manifest_v2(p_video_id,(target->>'processingJobId')::uuid,rows);
    target:=target-'voiceManifest';
    if voice is not null then target:=target||jsonb_build_object('voiceManifest',voice); end if;
  end if;
  return query select case when c.revision=p_known_revision then null else target end,
    case when c.revision=p_known_revision then null else rows end,c.revision;
end $$;
revoke all on function public.get_published_video_teaching_v1(text,bigint) from public,anon;
grant execute on function public.get_published_video_teaching_v1(text,bigint) to authenticated;

create or replace function public.admin_get_processing_video_content_v1(p_video_id text)
returns table(video jsonb,sentences jsonb,revision bigint,updated_at timestamptz)
language plpgsql stable security definer set search_path='' as $$
declare target jsonb; rows jsonb; voice jsonb; c private.content_snapshots%rowtype;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into c from private.content_snapshots where environment='production';
  select v.value into target from jsonb_array_elements(coalesce(c.draft->'videos','[]'::jsonb)) v where v.value->>'id'=p_video_id limit 1;
  if target is null then return; end if;
  rows:=coalesce(c.draft->'sentences'->p_video_id,'[]'::jsonb);
  if target->>'processingJobId'~'^[0-9a-f-]{36}$' then
    voice:=private.teaching_voice_manifest_v2(p_video_id,(target->>'processingJobId')::uuid,rows);
    target:=target-'voiceManifest';
    if voice is not null then target:=target||jsonb_build_object('voiceManifest',voice); end if;
  end if;
  return query select target,rows,c.revision,c.updated_at;
end $$;
revoke all on function public.admin_get_processing_video_content_v1(text) from public,anon;
grant execute on function public.admin_get_processing_video_content_v1(text) to authenticated;

-- Playback authorization must use the registered asset and receipt, never a
-- catalog-embedded item array.
do $patch$
declare definition text; marker text;
begin
  definition:=pg_get_functiondef('public.service_resolve_playback_access_v2(uuid,uuid,text)'::regprocedure);
  marker:='private.processing_voice_snapshot_matches_v1(c.published,a,r.sha256)';
  if position(marker in definition)=0 then raise exception 'VOICE_PLAYBACK_PATCH_DRIFT'; end if;
  execute replace(definition,marker,'private.processing_voice_registration_matches_v2(c.published,a,r.sha256)');
end $patch$;

-- Teaching preflight measures the compact snapshot plus the incoming sentence
-- projection; it no longer reserves a fictitious 2 KB per voice item.
create or replace function public.processing_validate_teaching_v2(
  p_job_id uuid,p_run_id uuid,p_token text,p_worker_id text,p_sentences jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare sentence jsonb; expected_count bigint; snapshot_bytes bigint; c private.content_snapshots%rowtype; v_job public.processing_jobs%rowtype; projected jsonb;
begin
  perform private.assert_current_processing_job(p_job_id);
  select * into v_job from private.processing_lock_run(p_job_id,p_run_id,p_token,p_worker_id);
  if jsonb_typeof(p_sentences) is distinct from 'array' or jsonb_array_length(p_sentences) not between 1 and 30000 then
    raise exception 'TEACHING_DETAILS_INVALID'; end if;
  for sentence in select value from jsonb_array_elements(p_sentences) loop
    if jsonb_typeof(sentence) is distinct from 'object'
      or jsonb_typeof(sentence->'id') is distinct from 'string'
      or coalesce(length(btrim(sentence->>'id')),0) not between 1 and 200
      or jsonb_typeof(sentence->'wordLookup') is distinct from 'object'
      or jsonb_typeof(sentence#>'{wordLookup,tokens}') is distinct from 'array'
      or jsonb_typeof(sentence->'translationAnalysis') is distinct from 'object'
      or jsonb_typeof(sentence->'coverageAnalysis') is distinct from 'object'
      or (sentence ? 'expressions' and jsonb_typeof(sentence->'expressions') is distinct from 'array')
      or private.learning_details_valid_v1(sentence) is distinct from true then raise exception 'TEACHING_DETAILS_INVALID'; end if;
  end loop;
  if (select count(distinct r->>'id') from jsonb_array_elements(p_sentences) r)<>jsonb_array_length(p_sentences)
    then raise exception 'VOICE_SOURCE_STALE'; end if;
  select coalesce(sum(jsonb_array_length(r#>'{wordLookup,tokens}')+
    (select count(*) from jsonb_array_elements(coalesce(r->'expressions','[]'::jsonb)) e
      where upper(coalesce(e->>'reviewStatus','')) not in ('REJECTED','DELETED'))),0)
    into expected_count from jsonb_array_elements(p_sentences) r;
  if expected_count not between 1 and 30000 then raise exception 'VOICE_MANIFEST_INCOMPLETE'; end if;
  select * into c from private.content_snapshots where environment='production';
  projected:=private.processing_compact_snapshot_v1(c.draft);
  projected:=projected||jsonb_build_object('sentences',coalesce(projected->'sentences','{}'::jsonb)||jsonb_build_object(v_job.video_id,p_sentences));
  snapshot_bytes:=octet_length(projected::text);
  if coalesce(snapshot_bytes,0)+1048576>33554432 then
    raise exception 'CONTENT_SNAPSHOT_CAPACITY_INSUFFICIENT'; end if;
  return jsonb_build_object('valid',true,'sentenceCount',jsonb_array_length(p_sentences),'voiceItemCount',expected_count);
end $$;
revoke all on function public.processing_validate_teaching_v2(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.processing_validate_teaching_v2(uuid,uuid,text,text,jsonb) to service_role;
alter function public.processing_validate_teaching_v2(uuid,uuid,text,text,jsonb) set statement_timeout='20s';
alter function public.processing_validate_teaching_v2(uuid,uuid,text,text,jsonb) set lock_timeout='2s';

drop function if exists private.processing_voice_snapshot_matches_v1(jsonb,private.teaching_voice_assets,text);

notify pgrst,'reload schema';
commit;
