-- Caller owns BEGIN/ROLLBACK. Rebind saved output to a synthetic job only.
do $fixture$
declare
  actor uuid; jid uuid:=gen_random_uuid(); rid uuid:=gen_random_uuid();
  vid text:='900000000029'; worker text:='rollback-full-commit';
  token text:=repeat('synthetic-commit-',4); rev bigint; original jsonb;
  result jsonb; manifest jsonb; saved jsonb; replay jsonb; items jsonb;
  started timestamptz; elapsed numeric; before_revision bigint;
begin
  select p.id into actor from public.profiles p where p.is_active is true and
    (lower(p.role)='admin' or exists(select 1 from private.admin_memberships m where m.user_id=p.id and m.status='active')) limit 1;
  if actor is null then raise exception 'FIXTURE_ADMIN_UNAVAILABLE'; end if;
  select revision,draft into rev,original from private.content_snapshots where environment='production' for update;
  if original::text like '%'||vid||'%' or exists(select 1 from public.processing_jobs where video_id=vid)
    then raise exception 'FIXTURE_ID_COLLISION'; end if;
  select payload->'result',payload->'manifest' into result,manifest from full_commit_payload;
  select jsonb_agg(i||jsonb_build_object('videoId',vid,
    'itemId',encode(extensions.digest(vid||':'||(i->>'itemId'),'sha256'),'hex')) order by n)
    into items from jsonb_array_elements(result#>'{video,voiceManifest,items}') with ordinality t(i,n);
  result:=jsonb_set(result,'{video,voiceManifest,videoId}',to_jsonb(vid));
  result:=jsonb_set(result,'{video,voiceManifest,items}',items);
  result:=jsonb_set(result,'{video,mediaUrl}',to_jsonb('/api/processing/media/'||jid||'/master.m3u8'));
  result:=jsonb_set(result,'{video,cover}',to_jsonb('/api/processing/media/'||jid||'/cover.webp'));
  result:=jsonb_set(result,'{video,playback}',jsonb_build_object('masterUrl','/api/processing/media/'||jid||'/master.m3u8'));
  insert into public.processing_jobs(id,video_id,source_key,requested_by,idempotency_key,input_revision,
    status,stage,run_id,worker_id,lease_until,worker_token_expires_at,worker_token_hash,input)
    values(jid,vid,'videos/'||jid||'/source.mp4',actor,'audit-full-'||jid,rev,
      'RUNNING','LOCAL_UPLOAD',rid,worker,now()+interval '5 minutes',now()+interval '5 minutes',
      encode(extensions.digest(token,'sha256'),'hex'),'{"kind":"CLOUD_PIPELINE","teachingVoiceRequired":true}');
  insert into private.processing_job_runs(job_id,run_id,worker_id) values(jid,rid,worker);
  update private.content_snapshots set draft=jsonb_set(original,'{videos}',coalesce(original->'videos','[]'::jsonb)||
    jsonb_build_array(jsonb_build_object('id',vid::bigint,'title','Rollback full commit','processingJobId',jid)))
    where environment='production';
  insert into private.processing_output_receipts(job_id,run_id,path,size,sha256,etag,confirmed_at)
    select jid,rid,m->>'path',(m->>'size')::bigint,m->>'sha256','rollback-only',now() from jsonb_array_elements(manifest) m;
  perform set_config('request.jwt.claim.role','service_role',true);
  started:=clock_timestamp();
  saved:=public.processing_commit_leased_result_v2(jid,rid,token,worker,result,manifest);
  elapsed:=extract(epoch from clock_timestamp()-started);
  if saved->>'status' is distinct from 'REVIEW'
    or jsonb_array_length(saved#>array['snapshot','sentences',vid])<>jsonb_array_length(result->'sentences')
    or not exists(select 1 from public.processing_jobs where id=jid and status='REVIEW' and output_run_id=rid and worker_token_hash is null)
    or (select count(*) from private.processing_commit_receipts where job_id=jid and run_id=rid)<>1
    or (select count(*) from private.teaching_voice_assets where owner_job_id=jid and run_id=rid)<>jsonb_array_length(items)
    then raise exception 'FULL_COMMIT_FAILED'; end if;
  if not exists(select 1 from jsonb_array_elements(saved#>'{snapshot,videos}') v where v->>'id'=vid
    and jsonb_array_length(v->'coverImages')=3 and v#>>'{voiceManifest,status}'='complete')
    then raise exception 'FULL_COMMIT_MEDIA_MISSING'; end if;
  before_revision:=(saved->>'revision')::bigint;
  replay:=public.processing_commit_leased_result_v2(jid,rid,token,worker,result,manifest);
  if replay is distinct from saved or (select revision from private.content_snapshots where environment='production')<>before_revision
    then raise exception 'FULL_COMMIT_REPLAY_MUTATED_CONTENT'; end if;
  raise notice 'Full commit passed: % sentences, % voice positions, % files, % seconds; rollback follows.',
    jsonb_array_length(result->'sentences'),jsonb_array_length(items),jsonb_array_length(manifest),elapsed;
end $fixture$;
