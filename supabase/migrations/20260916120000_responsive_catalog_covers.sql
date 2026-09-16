-- Additive cover support. No video re-encoding, object deletion or draft publication.
begin;

-- Preserve the deployed function bodies and privileges, changing only the media
-- whitelist. Abort on drift instead of silently installing a partial upgrade.
do $migration$
declare signature text; definition text; amended text;
begin
  foreach signature in array array[
    'public.processing_record_output_v2(uuid,uuid,text,text,text,bigint,text,text)',
    'public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb)',
    'public.service_resolve_playback_access_v2(uuid,uuid,text)'
  ] loop
    definition:=pg_get_functiondef(signature::regprocedure);
    amended:=replace(definition,'cover\.webp','cover(-320|-640|-960)?\.webp');
    if amended=definition then raise exception 'COVER_MIGRATION_FUNCTION_DRIFT: %',signature; end if;
    if signature like '%service_resolve_playback%' then
      if position('v_path<>''cover.webp''' in amended)=0 then raise exception 'COVER_MIGRATION_RESOLVER_DRIFT'; end if;
      amended:=replace(amended,'v_path<>''cover.webp''','v_path !~ ''^cover(-320|-640|-960)?\.webp$''');
    end if;
    execute amended;
  end loop;
end $migration$;

create table private.catalog_field_backups (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  revision bigint not null,
  reason text not null,
  fields jsonb not null
);
revoke all on private.catalog_field_backups from public,anon,authenticated;

-- Resolve only proven video-owned covers. Custom assets are deliberately retained.
create function private.normalize_collection_covers(p_snapshot jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare collection jsonb; member jsonb; source_id text; job_id text; result jsonb:='[]'::jsonb;
begin
  if p_snapshot is null then return p_snapshot; end if;
  for collection in select value from jsonb_array_elements(coalesce(p_snapshot->'collections','[]'::jsonb)) loop
    member:=null; source_id:=null;
    if collection#>>'{coverSource,type}'='video' then
      source_id:=collection#>>'{coverSource,videoId}';
    elsif collection#>>'{coverSource,type}' is distinct from 'asset' then
      job_id:=substring(collection->>'cover' from '^/api/processing/media/([0-9a-f-]{36})/cover(-320|-640|-960)?\.webp$');
      select j.video_id into source_id from public.processing_jobs j where j.id::text=job_id;
      -- Legacy inference requires a proven owner AND an actual collection member.
      if not exists(select 1 from jsonb_array_elements(coalesce(p_snapshot->'videos','[]'::jsonb)) v
        where v->>'id'=source_id and exists(select 1 from jsonb_array_elements_text(coalesce(v->'collectionIds','[]'::jsonb)) c where c=collection->>'id')) then source_id:=null; end if;
    end if;
    if source_id is not null then
      select v into member from jsonb_array_elements(coalesce(p_snapshot->'videos','[]'::jsonb)) with ordinality t(v,n)
      where v->>'status'='PUBLISHED' and coalesce(v->>'deletedAt','')=''
        and exists(select 1 from jsonb_array_elements_text(coalesce(v->'collectionIds','[]'::jsonb)) c where c=collection->>'id')
      order by case when v->>'id'=source_id then 0 else 1 end,n limit 1;
      collection:=collection||jsonb_build_object('coverSource',jsonb_build_object('type','video','videoId',coalesce(member->>'id',source_id)),
        'cover',coalesce(nullif(member->>'cover',''),'assets/images/video_cover_pending.svg'));
    end if;
    result:=result||jsonb_build_array(collection);
  end loop;
  return jsonb_set(p_snapshot,'{collections}',result);
end $$;
revoke all on function private.normalize_collection_covers(jsonb) from public,anon,authenticated;

create function private.normalize_snapshot_covers()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  new.draft:=private.normalize_collection_covers(new.draft);
  new.published:=private.normalize_collection_covers(new.published);
  return new;
end $$;
revoke all on function private.normalize_snapshot_covers() from public,anon,authenticated;
create trigger normalize_snapshot_covers before insert or update of draft,published
on private.content_snapshots for each row execute function private.normalize_snapshot_covers();

do $$
declare c private.content_snapshots%rowtype;
begin
  select * into c from private.content_snapshots where environment='production' for update;
  if c.revision is distinct from 77 then raise exception 'CONTENT_REVISION_CONFLICT: expected 77'; end if;
  insert into private.catalog_field_backups(revision,reason,fields) values(c.revision,'responsive-cover-relations',
    jsonb_build_object('draftCollections',c.draft->'collections','publishedCollections',c.published->'collections'));
  update private.content_snapshots set draft=private.normalize_collection_covers(draft),
    published=private.normalize_collection_covers(published),revision=revision+1,updated_at=now() where environment='production';
end $$;

-- Maintenance leases are scoped to one current published job/run and three NEW
-- thumbnail keys. They cannot overwrite video segments or existing receipts.
create table private.cover_refresh_leases (
  job_id uuid primary key references public.processing_jobs(id) on delete cascade,
  run_id uuid not null,
  token_hash text not null,
  expires_at timestamptz not null
);
revoke all on private.cover_refresh_leases from public,anon,authenticated;

create function public.service_begin_cover_refresh(p_job_id uuid,p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.processing_jobs%rowtype; c private.content_snapshots%rowtype; token text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select * into j from public.processing_jobs where id=p_job_id and status='REVIEW' for update;
  if j.output_run_id is null or j.cancel_requested_at is not null
    or exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
    or not exists(select 1 from jsonb_array_elements(c.published->'videos') v
    where v->>'id'=j.video_id and v->>'processingJobId'=j.id::text and v->>'status'='PUBLISHED') then raise exception 'CURRENT_PUBLISHED_VIDEO_REQUIRED'; end if;
  token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into private.cover_refresh_leases(job_id,run_id,token_hash,expires_at)
    values(j.id,j.output_run_id,encode(extensions.digest(token,'sha256'),'hex'),now()+interval '2 hours')
    on conflict(job_id) do update set run_id=excluded.run_id,token_hash=excluded.token_hash,expires_at=excluded.expires_at;
  return jsonb_build_object('jobId',j.id,'runId',j.output_run_id,'token',token,'revision',c.revision);
end $$;
revoke all on function public.service_begin_cover_refresh(uuid,bigint) from public,anon,authenticated;
grant execute on function public.service_begin_cover_refresh(uuid,bigint) to service_role;

create or replace function public.resolve_processing_output_v2(p_job_id uuid,p_run_id uuid,p_token text,p_path text)
returns table(object_key text) language sql stable security definer set search_path='' as $$
  select 'videos/'||substring(j.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||j.id::text||
    '/runs/'||p_run_id::text||'/'||p_path
  from public.processing_jobs j where j.id=p_job_id and j.cancel_requested_at is null and (
    (j.status='RUNNING' and j.run_id=p_run_id and j.worker_token_expires_at>now()
      and encode(extensions.digest(p_token,'sha256'),'hex')=j.worker_token_hash
      and p_path~'^(master\.m3u8|cover(-320|-640|-960)?\.webp|[0-9]{3,4}p/(index\.m3u8|segment_[0-9]{5}\.ts))$')
    or (j.status='REVIEW' and j.output_run_id=p_run_id and p_path~'^cover-(320|640|960)\.webp$'
      and exists(select 1 from private.cover_refresh_leases l where l.job_id=j.id and l.run_id=p_run_id
        and l.expires_at>now() and l.token_hash=encode(extensions.digest(p_token,'sha256'),'hex'))
      and not exists(select 1 from private.processing_output_receipts r where r.job_id=j.id and r.run_id=p_run_id and r.path=p_path)
      and not exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
      and exists(select 1 from private.content_snapshots c,jsonb_array_elements(c.published->'videos') v
        where c.environment='production' and v->>'id'=j.video_id and v->>'status'='PUBLISHED' and v->>'processingJobId'=j.id::text)));
$$;

-- Validate image metadata against stored upload receipts and derive URLs here.
create function private.verified_cover_images(p_job_id uuid,p_run_id uuid,p_images jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare x jsonb; images jsonb:='[]'::jsonb;
begin
  if jsonb_typeof(p_images) is distinct from 'array' or jsonb_array_length(p_images)<>3 then raise exception 'COVER_IMAGES_INVALID'; end if;
  if (select count(distinct value->>'path') from jsonb_array_elements(p_images))<>3 then raise exception 'COVER_IMAGES_DUPLICATE'; end if;
  for x in select value from jsonb_array_elements(p_images) loop
    if coalesce(x->>'path','')!~'^cover-(320|640|960)\.webp$'
      or coalesce(x->>'width','')!~'^[1-9][0-9]{0,2}$' or coalesce(x->>'height','')!~'^[1-9][0-9]{0,2}$'
      or coalesce(x->>'bytes','')!~'^[1-9][0-9]{0,5}$' then raise exception 'COVER_IMAGES_INVALID'; end if;
    if (x->>'width')::integer>substring(x->>'path' from '([0-9]+)')::integer
      or (x->>'height')::integer>540 or (x->>'bytes')::integer>262144
      or not exists(select 1 from private.processing_output_receipts r where r.job_id=p_job_id and r.run_id=p_run_id
        and r.path=x->>'path' and r.size=(x->>'bytes')::bigint) then raise exception 'COVER_IMAGE_UNVERIFIED'; end if;
    images:=images||jsonb_build_array(jsonb_build_object('path',x->>'path','width',(x->>'width')::integer,
      'height',(x->>'height')::integer,'bytes',(x->>'bytes')::integer,'url','/api/processing/media/'||p_job_id::text||'/'||(x->>'path')));
  end loop;
  return images;
end $$;
revoke all on function private.verified_cover_images(uuid,uuid,jsonb) from public,anon,authenticated;

-- This service-only commit consumes evidence returned by the authenticated R2
-- upload route. It patches coverImages only, preserving all teaching drafts.
create function public.service_commit_cover_refresh(p_job_id uuid,p_expected_revision bigint,p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c private.content_snapshots%rowtype; j public.processing_jobs%rowtype; x jsonb; images jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select * into j from public.processing_jobs where id=p_job_id and status='REVIEW' for update;
  if j.output_run_id is null or j.cancel_requested_at is not null
    or exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
    or not exists(select 1 from private.cover_refresh_leases l where l.job_id=j.id and l.run_id=j.output_run_id and l.expires_at>now())
    or not exists(select 1 from jsonb_array_elements(c.published->'videos') v where v->>'id'=j.video_id and v->>'processingJobId'=j.id::text and v->>'status'='PUBLISHED')
    then raise exception 'COVER_REFRESH_STALE'; end if;
  if jsonb_typeof(p_manifest) is distinct from 'array' or jsonb_array_length(p_manifest)<>3 then raise exception 'COVER_MANIFEST_INVALID'; end if;
  for x in select value from jsonb_array_elements(p_manifest) loop
    if coalesce(x->>'path','')!~'^cover-(320|640|960)\.webp$' or coalesce(x->>'size','')!~'^[1-9][0-9]{0,5}$'
      or (x->>'size')::integer>262144 or coalesce(x->>'sha256','')!~'^[0-9a-f]{64}$' or coalesce(length(x->>'etag'),0)<1 then raise exception 'COVER_MANIFEST_INVALID'; end if;
    insert into private.processing_output_receipts(job_id,run_id,path,size,sha256,etag)
      values(j.id,j.output_run_id,x->>'path',(x->>'size')::bigint,x->>'sha256',x->>'etag');
  end loop;
  images:=private.verified_cover_images(j.id,j.output_run_id,p_manifest);
  insert into private.catalog_field_backups(revision,reason,fields) values(c.revision,'cover-images:'||j.video_id,
    jsonb_build_object('videoId',j.video_id,'draft',(select v->'coverImages' from jsonb_array_elements(c.draft->'videos') v where v->>'id'=j.video_id),
      'published',(select v->'coverImages' from jsonb_array_elements(c.published->'videos') v where v->>'id'=j.video_id)));
  update private.content_snapshots set
    draft=jsonb_set(draft,'{videos}',(select jsonb_agg(case when v->>'id'=j.video_id and v->>'processingJobId'=j.id::text then v||jsonb_build_object('coverImages',images) else v end order by n) from jsonb_array_elements(draft->'videos') with ordinality t(v,n))),
    published=jsonb_set(published,'{videos}',(select jsonb_agg(case when v->>'id'=j.video_id then v||jsonb_build_object('coverImages',images) else v end order by n) from jsonb_array_elements(published->'videos') with ordinality t(v,n))),
    revision=revision+1,updated_at=now() where environment='production';
  delete from private.cover_refresh_leases where job_id=j.id;
  return jsonb_build_object('videoId',j.video_id,'revision',c.revision+1,'coverImages',images);
end $$;
revoke all on function public.service_commit_cover_refresh(uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.service_commit_cover_refresh(uuid,bigint,jsonb) to service_role;

-- Apply receipt validation to future worker commits, including null/duplicate
-- manifests. Only cover metadata is canonicalized; AI output is still review-only.
do $migration$
declare definition text;
begin
  definition:=pg_get_functiondef('public.processing_commit_leased_result_v2(uuid,uuid,text,text,jsonb,jsonb)'::regprocedure);
  definition:=replace(definition,'jsonb_typeof(p_manifest)<>''array''','jsonb_typeof(p_manifest) is distinct from ''array''');
  definition:=replace(definition,'if v_count<>jsonb_array_length(p_manifest)',
    'if (select count(distinct x->>''path'') from jsonb_array_elements(p_manifest) x)<>jsonb_array_length(p_manifest) or v_count<>jsonb_array_length(p_manifest)');
  if position('return public.processing_commit_result(p_job_id,p_result);' in definition)=0 then raise exception 'COVER_COMMIT_DRIFT'; end if;
  definition:=replace(definition,'return public.processing_commit_result(p_job_id,p_result);',
    'if p_result#>''{video,coverImages}'' is not null then
       p_result:=jsonb_set(p_result,''{video,coverImages}'',private.verified_cover_images(p_job_id,p_run_id,p_result#>''{video,coverImages}''));
     end if;
     return public.processing_commit_result(p_job_id,p_result);');
  execute definition;
end $migration$;

create or replace function public.resolve_processing_media(p_job_id uuid,p_path text)
returns table(object_key text) language sql stable security definer set search_path='' as $$
  select 'videos/'||substring(j.source_key from '^videos/([0-9a-f-]{36})/')||'/processed/'||j.id::text||'/'||
    case when j.output_run_id is null then resolved.path else 'runs/'||j.output_run_id::text||'/'||resolved.path end
  from public.processing_jobs j
  join private.content_snapshots c on c.environment='production'
  cross join lateral jsonb_array_elements(c.published->'videos') v
  left join lateral (select pv->>'label' as label from jsonb_array_elements(coalesce(v#>'{playback,variants}','[]'::jsonb)) pv
    where pv->>'label' in ('540p','720p') order by case pv->>'label' when '540p' then 0 else 1 end limit 1) rendition on true
  cross join lateral (select case when p_path='master.m3u8' then rendition.label||'/index.m3u8' else p_path end as path) resolved
  where j.id=p_job_id and j.status='REVIEW'
    and p_path~'^(master\.m3u8|cover(-320|-640|-960)?\.webp|(540|720)p/(index\.m3u8|segment_[0-9]{5}\.ts))$'
    and not exists(select 1 from private.content_video_trash t where t.environment='production' and t.video_id=j.video_id and t.restored_at is null)
    and coalesce((private.learning_access_v2(auth.uid())->>'canPlay')::boolean,false)
    and (j.output_run_id is null or exists(select 1 from private.processing_output_receipts r where r.job_id=j.id and r.run_id=j.output_run_id and r.path=resolved.path and r.size>0))
    and v->>'id'=j.video_id and v->>'status'='PUBLISHED' and v->>'processingJobId'=j.id::text
    and (p_path like 'cover%' or rendition.label=split_part(resolved.path,'/',1));
$$;

commit;
