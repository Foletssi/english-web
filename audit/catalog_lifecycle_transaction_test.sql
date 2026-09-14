-- Execute in one transaction with the pending migration, then ROLLBACK.
-- No accounts or media are created/deleted; all fixture mutations roll back.
do $$
declare
  admin_id uuid;
  r bigint;
  s jsonb;
  before_doc jsonb;
  result_row record;
begin
  select p.id into admin_id from public.profiles p where p.role='admin' and p.is_active limit 1;
  if admin_id is null then raise exception 'TEST_ADMIN_REQUIRED'; end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  select revision into r from private.content_snapshots where environment='production' for update;
  s := '{"videos":[],"creators":[{"id":"audit-a","name":"A","status":"ACTIVE"},{"id":"audit-b","name":"B draft","status":"ACTIVE"}],"collections":[],"sentences":{},"jobs":[]}';
  update private.content_snapshots set draft=s,published=jsonb_set(s,'{creators,1,name}','"B public"') where environment='production';
  insert into private.content_video_trash(environment,video_id,payload,deleted_by) values
    ('production','9999999999901','{"draft":{"video":{"id":9999999999901,"creatorId":"audit-a","creator":"A","mediaKey":"must-stay"}},"published":{"video":{"id":9999999999901,"creatorId":"audit-a","creator":"A"}}}',admin_id);
  begin
    perform public.admin_set_creator_status_v1('audit-a','DELETED',null,r);
    raise exception 'TEST_TRASH_ONLY_REPLACEMENT_NOT_REQUIRED';
  exception when others then
    if sqlerrm<>'CREATOR_REPLACEMENT_REQUIRED' then raise; end if;
  end;
  begin
    perform public.admin_set_creator_status_v1('audit-a','DELETED','audit-b',r-1);
    raise exception 'TEST_STALE_REVISION_ACCEPTED';
  exception when others then
    if sqlerrm<>'CONTENT_REVISION_CONFLICT' then raise; end if;
  end;
  update private.content_snapshots set draft=jsonb_set(draft,'{creators,1,status}','"DELETED"') where environment='production';
  begin
    perform public.admin_set_creator_status_v1('audit-a','DELETED','audit-b',r);
    raise exception 'TEST_DELETED_DRAFT_REPLACEMENT_ACCEPTED';
  exception when others then
    if sqlerrm<>'CREATOR_REPLACEMENT_REQUIRED' then raise; end if;
  end;
  update private.content_snapshots set draft=s where environment='production';
  select * into result_row from public.admin_set_creator_status_v1('audit-a','DELETED','audit-b',r);
  r:=result_row.revision;
  if not exists(select 1 from private.content_video_trash where video_id='9999999999901' and restored_at is null
    and payload#>>'{draft,video,creatorId}'='audit-b' and payload#>>'{published,video,creatorId}'='audit-b'
    and payload#>>'{draft,video,mediaKey}'='must-stay' and payload#>>'{published,video,creator}'='B public') then
    raise exception 'TEST_TRASH_MAPPING_NOT_UPDATED';
  end if;
  if exists(select 1 from private.content_snapshots, jsonb_array_elements(published->'creators') v
    where environment='production' and (v->>'id'='audit-a' or v->>'name'='B draft')) then raise exception 'TEST_UNPUBLISHED_CREATOR_LEAKED'; end if;
  select * into result_row from public.admin_restore_content_video('9999999999901',r);
  r:=result_row.revision;
  if result_row.snapshot#>>'{videos,0,creatorId}'<>'audit-b' then raise exception 'TEST_RESTORED_VIDEO_WRONG_CREATOR'; end if;
  select draft->'videos' into before_doc from private.content_snapshots where environment='production';
  select * into result_row from public.admin_set_creator_status_v1('audit-a','ACTIVE',null,r);
  if result_row.snapshot->'videos' is distinct from before_doc then raise exception 'TEST_CREATOR_RESTORE_STOLE_VIDEOS'; end if;
  r:=result_row.revision;
  -- Active videos on both sides, unrelated collection and sentence drafts stay private.
  update private.content_snapshots set draft=jsonb_set(draft,'{videos,0,creatorId}','"audit-a"'),
    published=jsonb_set(published,'{videos}', '[{"id":9999999999902,"creatorId":"audit-a","mediaKey":"unchanged"}]') where environment='production';
  select published-'videos'-'creators' into before_doc from private.content_snapshots where environment='production';
  select * into result_row from public.admin_set_creator_status_v1('audit-a','DELETED','audit-b',r);
  if result_row.snapshot#>>'{videos,0,creatorId}'<>'audit-b' then raise exception 'TEST_DRAFT_MAPPING_NOT_UPDATED'; end if;
  if not exists(select 1 from private.content_snapshots where environment='production'
    and published#>>'{videos,0,creatorId}'='audit-b' and published#>>'{videos,0,mediaKey}'='unchanged'
    and published-'videos'-'creators'=before_doc) then raise exception 'TEST_PUBLISHED_MAPPING_CHANGED_UNRELATED_DATA'; end if;
  perform set_config('request.jwt.claim.sub','',true);
  begin
    perform public.admin_set_creator_status_v1('audit-a','ACTIVE',null,result_row.revision);
    raise exception 'TEST_ANONYMOUS_ACCEPTED';
  exception when others then
    if sqlerrm<>'ADMIN_REQUIRED' then raise; end if;
  end;
end $$;
select 'catalog lifecycle transaction assertions passed' as result;
