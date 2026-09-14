-- M08 maintenance only. Upload a new run, then swap media fields without AI/content edits.
-- Neither function deletes originals or previous R2 outputs.
create or replace function public.service_begin_balanced_reencode(p_original_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  c private.content_snapshots%rowtype;
  original public.processing_jobs%rowtype;
  j public.processing_jobs%rowtype;
  v_draft jsonb;
  v_published jsonb;
  v_token text:=encode(extensions.gen_random_bytes(32),'hex');
  v_run uuid:=extensions.gen_random_uuid();
  v_key text:='balanced-540-v1:'||p_original_job_id::text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;
  select * into original from public.processing_jobs where id=p_original_job_id for update;
  if not found or original.status<>'REVIEW' then raise exception 'ORIGINAL_MEDIA_NOT_READY'; end if;
  select * into j from public.processing_jobs where requested_by=original.requested_by and idempotency_key=v_key for update;
  if found and j.status='REVIEW' then return jsonb_build_object('completed',true,'jobId',j.id); end if;
  if j.id is not null and j.status='RUNNING' and j.lease_until>clock_timestamp() then raise exception 'REENCODE_ALREADY_RUNNING'; end if;
  select value into v_draft from jsonb_array_elements(c.draft->'videos') where value->>'id'=original.video_id;
  select value into v_published from jsonb_array_elements(c.published->'videos') where value->>'id'=original.video_id;
  if v_draft is null or v_published is null or v_published->>'status'<>'PUBLISHED'
    or v_draft->>'processingJobId' is distinct from original.id::text
    or v_published->>'processingJobId' is distinct from original.id::text
    then raise exception 'MEDIA_SOURCE_CHANGED'; end if;
  if exists(select 1 from private.content_video_trash where environment='production' and video_id=original.video_id and restored_at is null)
    then raise exception 'VIDEO_IN_TRASH'; end if;
  if j.id is null then
    insert into public.processing_jobs(video_id,source_key,input,requested_by,idempotency_key,status,stage,provider,input_revision,next_run_at)
      values(original.video_id,original.source_key,jsonb_build_object('kind','MEDIA_REENCODE','profile','balanced-540-v1',
        'originalJobId',original.id,'previousDraftVideo',v_draft,'previousPublishedVideo',v_published),
        original.requested_by,v_key,'WAITING','LOCAL_DOWNLOAD','local-worker',c.revision,'infinity') returning * into j;
  elsif j.run_id is not null then
    update private.processing_job_runs set ended_at=coalesce(ended_at,clock_timestamp()),outcome=coalesce(outcome,'LEASE_LOST')
      where job_id=j.id and run_id=j.run_id;
  end if;
  -- Infinity keeps ordinary/older workers from claiming this operator-owned maintenance job.
  update public.processing_jobs set status='RUNNING',stage='LOCAL_DOWNLOAD',progress=1,error=null,cancel_requested_at=null,
    run_id=v_run,worker_id='eastudy-media-maintenance',telemetry_seq=0,next_run_at='infinity',
    worker_token_hash=encode(extensions.digest(v_token,'sha256'),'hex'),source_token_hash=encode(extensions.digest(v_token,'sha256'),'hex'),
    worker_token_expires_at=clock_timestamp()+interval '10 minutes',source_token_expires_at=clock_timestamp()+interval '10 minutes',
    lease_token=extensions.gen_random_uuid(),lease_until=clock_timestamp()+interval '10 minutes',
    attempt_started_at=clock_timestamp(),stage_started_at=clock_timestamp(),last_heartbeat_at=clock_timestamp(),
    last_progress_at=clock_timestamp(),updated_at=clock_timestamp(),completed_at=null
    where id=j.id returning * into j;
  insert into private.processing_job_runs(job_id,run_id,worker_id) values(j.id,v_run,j.worker_id);
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
    values(j.id,v_run,'CLAIMED','LOCAL_DOWNLOAD',jsonb_build_object('kind','MEDIA_REENCODE','originalJobId',original.id));
  return jsonb_build_object('job',jsonb_build_object('id',j.id,'run_id',j.run_id,'source_key',j.source_key,'video_id',j.video_id),
    'token',v_token,'previousDraftVideo',v_draft,'previousPublishedVideo',v_published);
end $$;

create or replace function public.service_commit_balanced_reencode(
  p_job_id uuid,p_run_id uuid,p_token text,p_manifest jsonb,p_variant jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  c private.content_snapshots%rowtype;
  j public.processing_jobs%rowtype;
  v_original text;
  v_url text;
  v_variant jsonb;
  v_patch jsonb;
  v_draft jsonb;
  v_published jsonb;
  v_count integer;
  v_bytes bigint;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if not found then raise exception 'CONTENT_NOT_INITIALIZED'; end if;
  select * into j from private.processing_lock_run(p_job_id,p_run_id,p_token,'eastudy-media-maintenance');
  if j.input->>'kind' is distinct from 'MEDIA_REENCODE' or j.input->>'profile' is distinct from 'balanced-540-v1'
    then raise exception 'REENCODE_JOB_REQUIRED'; end if;
  v_original:=j.input->>'originalJobId';
  if (select count(*) from jsonb_array_elements(c.draft->'videos') v where v->>'id'=j.video_id and v->>'processingJobId'=v_original)<>1
    or (select count(*) from jsonb_array_elements(c.published->'videos') v where v->>'id'=j.video_id and v->>'processingJobId'=v_original and v->>'status'='PUBLISHED')<>1
    then raise exception 'MEDIA_SOURCE_CHANGED'; end if;
  if exists(select 1 from private.content_video_trash where environment='production' and video_id=j.video_id and restored_at is null)
    then raise exception 'VIDEO_IN_TRASH'; end if;
  if jsonb_typeof(p_manifest) is distinct from 'array' then raise exception 'OUTPUT_MANIFEST_INVALID'; end if;
  if jsonb_array_length(p_manifest)<4
    or (select count(distinct x->>'path') from jsonb_array_elements(p_manifest) x)<>jsonb_array_length(p_manifest)
    or not exists(select 1 from jsonb_array_elements(p_manifest) x where x->>'path'='master.m3u8')
    or not exists(select 1 from jsonb_array_elements(p_manifest) x where x->>'path'='540p/index.m3u8')
    or not exists(select 1 from jsonb_array_elements(p_manifest) x where x->>'path'='cover.webp')
    or exists(select 1 from jsonb_array_elements(p_manifest) x where coalesce(x->>'path','')!~'^(master\.m3u8|cover\.webp|540p/(index\.m3u8|segment_[0-9]{5}\.ts))$'
      or not exists(select 1 from private.processing_output_receipts r where r.job_id=j.id and r.run_id=p_run_id
        and r.path=x->>'path' and r.size::text=x->>'size' and r.sha256=x->>'sha256'))
    then raise exception 'OUTPUT_MANIFEST_INCOMPLETE'; end if;
  select count(*),sum(size) into v_count,v_bytes from private.processing_output_receipts where job_id=j.id and run_id=p_run_id;
  if v_count<>jsonb_array_length(p_manifest) then raise exception 'OUTPUT_MANIFEST_MISMATCH'; end if;
  if coalesce(p_variant->>'label','')<>'540p' or coalesce(p_variant->>'path','')<>'540p/index.m3u8'
    or coalesce(p_variant->>'width','')!~'^[1-9][0-9]{0,4}$' or coalesce(p_variant->>'height','')!~'^[1-9][0-9]{0,4}$'
    or coalesce(p_variant->>'bandwidth','')!~'^[1-9][0-9]{0,8}$'
    or coalesce(p_variant->>'averageBandwidth','')!~'^[1-9][0-9]{0,8}$'
    or p_variant->>'profileVersion' is distinct from 'balanced-540-v1'
    or coalesce(p_variant->>'frameRate','')!~'^[0-9]+(\.[0-9]+)?$' then raise exception 'BALANCED_VARIANT_INVALID'; end if;
  if least((p_variant->>'width')::integer,(p_variant->>'height')::integer)>540
    or greatest((p_variant->>'width')::integer,(p_variant->>'height')::integer)>960
    or (p_variant->>'width')::integer%2<>0 or (p_variant->>'height')::integer%2<>0
    or (p_variant->>'frameRate')::numeric<=0 or (p_variant->>'frameRate')::numeric>30
    then raise exception 'BALANCED_VARIANT_INVALID'; end if;
  v_url:='/api/processing/media/'||j.id::text||'/540p/index.m3u8';
  v_variant:=jsonb_build_object('label','540p','path','540p/index.m3u8','url',v_url,
    'width',(p_variant->>'width')::integer,'height',(p_variant->>'height')::integer,
    'frameRate',(p_variant->>'frameRate')::numeric,'fpsExpression',p_variant->>'fpsExpression',
    'bandwidth',(p_variant->>'bandwidth')::integer,'averageBandwidth',(p_variant->>'averageBandwidth')::integer,
    'profileVersion','balanced-540-v1');
  v_patch:=jsonb_build_object('processingJobId',j.id::text,'mediaUrl',v_url,
    'playback',jsonb_build_object('policy','single-standard-v2','masterUrl',v_url,'variants',jsonb_build_array(v_variant)),
    'mediaEncodingProfile','balanced-540-v1','playbackBytes',v_bytes);
  -- Preserve every unrelated field and array position; do not republish the whole draft.
  select jsonb_set(c.draft,'{videos}',jsonb_agg(case when v->>'id'=j.video_id then v||v_patch||
    case when v->>'cover' like '/api/processing/media/'||v_original||'/%' then jsonb_build_object('cover','/api/processing/media/'||j.id::text||'/cover.webp') else '{}'::jsonb end else v end order by n))
    into v_draft from jsonb_array_elements(c.draft->'videos') with ordinality t(v,n);
  select jsonb_set(c.published,'{videos}',jsonb_agg(case when v->>'id'=j.video_id then v||v_patch||
    case when v->>'cover' like '/api/processing/media/'||v_original||'/%' then jsonb_build_object('cover','/api/processing/media/'||j.id::text||'/cover.webp') else '{}'::jsonb end else v end order by n))
    into v_published from jsonb_array_elements(c.published->'videos') with ordinality t(v,n);
  perform private.validate_content_snapshot(v_draft);
  perform private.validate_content_snapshot(v_published);
  update private.content_snapshots set draft=v_draft,published=v_published,revision=revision+1,updated_at=now() where environment='production';
  update public.processing_jobs set status='REVIEW',stage='REVIEW',progress=100,output_run_id=p_run_id,
    result=jsonb_build_object('video',v_patch,'evidence',jsonb_build_object('kind','MEDIA_REENCODE','profile','balanced-540-v1','assetCount',v_count,'bytes',v_bytes)),
    worker_token_hash=null,worker_token_expires_at=null,source_token_hash=null,source_token_expires_at=null,
    lease_token=null,lease_until=null,completed_at=now(),updated_at=now(),work=work||jsonb_build_object('message','均衡540P替换完成，字幕和学习数据保持不变') where id=j.id;
  update private.processing_job_runs set ended_at=now(),outcome='REVIEW' where job_id=j.id and run_id=p_run_id;
  insert into private.processing_job_events(job_id,run_id,kind,stage,details)
    values(j.id,p_run_id,'REVIEW','REVIEW',jsonb_build_object('kind','MEDIA_REENCODE','bytes',v_bytes,'previousJobId',v_original));
  return jsonb_build_object('ok',true,'jobId',j.id,'videoId',j.video_id,'bytes',v_bytes,'revision',c.revision+1);
end $$;

revoke all on function public.service_begin_balanced_reencode(uuid) from public,anon,authenticated;
revoke all on function public.service_commit_balanced_reencode(uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.service_begin_balanced_reencode(uuid) to service_role;
grant execute on function public.service_commit_balanced_reencode(uuid,uuid,text,jsonb,jsonb) to service_role;

-- Select only the currently published rendition. 'master.m3u8' is a resolver alias,
-- not a public endpoint; old clients requesting 720 explicitly remain compatible.
create or replace function public.service_resolve_playback_access_v2(p_user_id uuid,p_job_id uuid,p_path text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_access jsonb; v_key text; v_job public.processing_jobs%rowtype;
  v_video jsonb; v_variant jsonb; v_label text; v_path text:=p_path; v_prefix text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  v_access:=private.learning_access_v2(p_user_id);
  if coalesce((v_access->>'canPlay')::boolean,false) is not true then return v_access; end if;
  if p_path is null or p_path !~ '^(master\.m3u8|cover\.webp|(540|720)p/(index\.m3u8|segment_[0-9]{5}\.ts))$' then
    return jsonb_build_object('canPlay',false,'reason','MEDIA_PATH_INVALID');
  end if;
  select * into v_job from public.processing_jobs j where j.id=p_job_id and j.status='REVIEW';
  if not found or exists(select 1 from private.content_video_trash t where t.environment='production'
    and t.video_id=v_job.video_id and t.restored_at is null) then
    return jsonb_build_object('canPlay',false,'reason','PLAYBACK_FORBIDDEN');
  end if;
  select v into v_video from private.content_snapshots c,
    jsonb_array_elements(coalesce(c.published->'videos','[]'::jsonb)) v
    where c.environment='production' and v->>'id'=v_job.video_id and v->>'status'='PUBLISHED'
      and v->>'processingJobId'=p_job_id::text;
  if v_video is null then return jsonb_build_object('canPlay',false,'reason','PLAYBACK_FORBIDDEN'); end if;
  select v into v_variant from jsonb_array_elements(coalesce(v_video#>'{playback,variants}','[]'::jsonb)) v
    where v->>'label' in ('540p','720p')
    order by case v->>'label' when '540p' then 0 else 1 end limit 1;
  v_label:=v_variant->>'label';
  if v_label is null then return jsonb_build_object('canPlay',false,'reason','MEDIA_VARIANT_MISSING'); end if;
  if v_path='master.m3u8' then v_path:=v_label||'/index.m3u8'; end if;
  if v_path<>'cover.webp' and split_part(v_path,'/',1) is distinct from v_label then
    return jsonb_build_object('canPlay',false,'reason','MEDIA_VARIANT_STALE');
  end if;
  -- Legacy unversioned media remains playable; run-scoped output must have a receipt.
  if v_job.output_run_id is not null and not exists(select 1 from private.processing_output_receipts r
    where r.job_id=v_job.id and r.run_id=v_job.output_run_id and r.path=v_path and r.size>0) then
    return jsonb_build_object('canPlay',false,'reason','MEDIA_OUTPUT_UNVERIFIED');
  end if;
  v_prefix:='videos/'||substring(v_job.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||v_job.id::text||'/'||
    case when v_job.output_run_id is null then '' else 'runs/'||v_job.output_run_id::text||'/' end;
  if v_prefix is null then return jsonb_build_object('canPlay',false,'reason','MEDIA_PATH_INVALID'); end if;
  v_key:=v_prefix||v_path;
  return v_access||jsonb_build_object('canPlay',true,'objectKey',v_key,'prefix',v_prefix,'path',v_path);
end $$;

-- Maintenance can copy only its original job's cover, using its expiring source token.
-- The caller cannot supply an object key or another video's id.
create or replace function public.resolve_processing_reencode_cover(p_job_id uuid,p_token text)
returns table(source_key text) language sql stable security definer set search_path='' as $$
  select 'videos/'||substring(o.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||o.id::text||'/'||
    case when o.output_run_id is null then '' else 'runs/'||o.output_run_id::text||'/' end||'cover.webp'
  from public.processing_jobs j join public.processing_jobs o on o.id::text=j.input->>'originalJobId'
  where j.id=p_job_id and j.input->>'kind'='MEDIA_REENCODE' and j.status='RUNNING'
    and j.video_id=o.video_id and j.source_key=o.source_key
    and j.cancel_requested_at is null and j.source_token_expires_at>now()
    and encode(extensions.digest(p_token,'sha256'),'hex')=j.source_token_hash
    and (o.output_run_id is null or exists(select 1 from private.processing_output_receipts r
      where r.job_id=o.id and r.run_id=o.output_run_id and r.path='cover.webp' and r.size>0));
$$;
revoke all on function public.resolve_processing_reencode_cover(uuid,text) from public;
grant execute on function public.resolve_processing_reencode_cover(uuid,text) to anon,authenticated;
