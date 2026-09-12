-- Run inside BEGIN + migration definitions + this file + ROLLBACK via official Supabase CLI.
select set_config('request.jwt.claim.role','service_role',true);
do $$
declare
  before_row private.content_snapshots%rowtype;
  after_row private.content_snapshots%rowtype;
  lease jsonb;
  manifest jsonb;
  path text;
  variant jsonb:='{"label":"720p","path":"720p/index.m3u8","width":1280,"height":720,"frameRate":30}';
  original_id uuid:='c295fa07-9d5f-4b3d-b1e1-1e915ac78249';
  before_video jsonb;
  after_video jsonb;
  keys text[]:=array['processingJobId','mediaUrl','playback','cover','mediaEncodingProfile','playbackBytes'];
begin
  select * into before_row from private.content_snapshots where environment='production';
  begin
    perform public.service_begin_balanced_reencode('00000000-0000-0000-0000-000000000000');
    raise exception 'TEST_INVALID_SOURCE_ACCEPTED';
  exception when others then
    if sqlerrm<>'ORIGINAL_MEDIA_NOT_READY' then raise; end if;
  end;
  lease:=public.service_begin_balanced_reencode(original_id);
  if lease->>'completed'='true' then raise exception 'TEST_REQUIRES_PRE_ROLLOUT_STATE'; end if;
  begin
    perform public.service_begin_balanced_reencode(original_id);
    raise exception 'TEST_DUPLICATE_ACCEPTED';
  exception when others then
    if sqlerrm<>'REENCODE_ALREADY_RUNNING' then raise; end if;
  end;
  begin
    perform public.service_commit_balanced_reencode((lease#>>'{job,id}')::uuid,(lease#>>'{job,run_id}')::uuid,lease->>'token','[]',variant);
    raise exception 'TEST_EMPTY_MANIFEST_ACCEPTED';
  exception when others then
    if sqlerrm<>'OUTPUT_MANIFEST_INCOMPLETE' then raise; end if;
  end;
  foreach path in array array['master.m3u8','cover.webp','720p/index.m3u8','720p/segment_00000.ts'] loop
    insert into private.processing_output_receipts(job_id,run_id,path,size,sha256,etag)
      values((lease#>>'{job,id}')::uuid,(lease#>>'{job,run_id}')::uuid,path,10,repeat('a',64),'test-only');
  end loop;
  select jsonb_agg(jsonb_build_object('path',r.path,'size',r.size,'sha256',r.sha256)) into manifest
    from private.processing_output_receipts r where r.job_id=(lease#>>'{job,id}')::uuid;
  begin
    perform public.service_commit_balanced_reencode((lease#>>'{job,id}')::uuid,(lease#>>'{job,run_id}')::uuid,repeat('x',64),manifest,variant);
    raise exception 'TEST_BAD_TOKEN_ACCEPTED';
  exception when others then
    if sqlerrm<>'JOB_LEASE_LOST_OR_CANCELLED' then raise; end if;
  end;
  begin
    perform public.service_commit_balanced_reencode((lease#>>'{job,id}')::uuid,(lease#>>'{job,run_id}')::uuid,lease->>'token',manifest,variant||'{"height":1080,"width":1920}');
    raise exception 'TEST_1080_ACCEPTED';
  exception when others then
    if sqlerrm<>'BALANCED_VARIANT_INVALID' then raise; end if;
  end;
  perform public.service_commit_balanced_reencode((lease#>>'{job,id}')::uuid,(lease#>>'{job,run_id}')::uuid,lease->>'token',manifest,variant);
  select * into after_row from private.content_snapshots where environment='production';
  if (before_row.draft-'videos') is distinct from (after_row.draft-'videos')
    or (before_row.published-'videos') is distinct from (after_row.published-'videos')
    then raise exception 'TEST_NON_MEDIA_CONTENT_CHANGED'; end if;
  for before_video in select value from jsonb_array_elements(before_row.draft->'videos') loop
    select value into after_video from jsonb_array_elements(after_row.draft->'videos') where value->>'id'=before_video->>'id';
    if before_video->>'id'=lease#>>'{job,video_id}' then
      if before_video-keys is distinct from after_video-keys then raise exception 'TEST_DRAFT_VIDEO_METADATA_CHANGED'; end if;
    elsif before_video is distinct from after_video then raise exception 'TEST_OTHER_VIDEO_CHANGED'; end if;
  end loop;
  for before_video in select value from jsonb_array_elements(before_row.published->'videos') loop
    select value into after_video from jsonb_array_elements(after_row.published->'videos') where value->>'id'=before_video->>'id';
    if before_video->>'id'=lease#>>'{job,video_id}' then
      if before_video-keys is distinct from after_video-keys then raise exception 'TEST_PUBLISHED_VIDEO_METADATA_CHANGED'; end if;
    elsif before_video is distinct from after_video then raise exception 'TEST_OTHER_PUBLISHED_VIDEO_CHANGED'; end if;
  end loop;
  if public.service_begin_balanced_reencode(original_id)->>'completed'<>'true' then raise exception 'TEST_NOT_IDEMPOTENT'; end if;
  perform set_config('request.jwt.claim.role','anon',true);
  begin
    perform public.service_begin_balanced_reencode(original_id);
    raise exception 'TEST_ANON_ACCEPTED';
  exception when others then
    if sqlerrm<>'SERVICE_ROLE_REQUIRED' then raise; end if;
  end;
end $$;
select 'balanced media transaction tests passed; all fixture mutations will be rolled back' as result;
