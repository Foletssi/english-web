-- M07 -> M03 atomic lifecycle. Does not publish unrelated drafts or delete media.
create or replace function public.admin_set_creator_status_v1(
  p_creator_id text, p_status text, p_replacement_id text, p_expected_revision bigint
)
returns table(revision bigint, snapshot jsonb)
language plpgsql security definer set search_path = ''
as $$
declare
  c private.content_snapshots%rowtype;
  creator jsonb;
  replacement jsonb;
  linked boolean;
  doc jsonb;
  scope text;
  trash_row record;
  trash_payload jsonb;
begin
  if public.is_admin() is distinct from true then raise exception 'ADMIN_REQUIRED'; end if;
  if p_status is null or p_status not in ('ACTIVE','DELETED') then raise exception 'INVALID_CREATOR_STATUS'; end if;
  select * into c from private.content_snapshots where environment='production' for update;
  if not found or c.revision is distinct from p_expected_revision then raise exception 'CONTENT_REVISION_CONFLICT'; end if;
  select value into creator from jsonb_array_elements(c.draft->'creators') where value->>'id'=p_creator_id;
  if creator is null then raise exception 'CREATOR_NOT_FOUND'; end if;
  if p_status='DELETED' then
    select exists(select 1 from jsonb_array_elements(coalesce(c.draft->'videos','[]') || coalesce(c.published->'videos','[]')) v where v->>'creatorId'=p_creator_id)
      or exists(select 1 from private.content_video_trash t where t.environment='production' and t.restored_at is null
        and lower(coalesce(t.payload->>'permanentDeleted','false'))<>'true'
        and not exists(select 1 from private.video_deletion_jobs d where d.environment=t.environment and d.video_id=t.video_id and d.confirmed_at is not null)
        and p_creator_id in (t.payload#>>'{draft,video,creatorId}',t.payload#>>'{published,video,creatorId}',t.payload#>>'{video,creatorId}'))
      into linked;
    if linked then
      if p_replacement_id is null or p_replacement_id=p_creator_id or not exists(
        select 1 from jsonb_array_elements(c.draft->'creators') v where v->>'id'=p_replacement_id and coalesce(v->>'status','ACTIVE')='ACTIVE'
      ) then raise exception 'CREATOR_REPLACEMENT_REQUIRED'; end if;
      -- Prefer the already published replacement: do not leak its unpublished edits.
      select value into replacement from jsonb_array_elements(coalesce(c.published->'creators','[]')) where value->>'id'=p_replacement_id and coalesce(value->>'status','ACTIVE')='ACTIVE';
      if replacement is null then
        select value into replacement from jsonb_array_elements(c.draft->'creators') where value->>'id'=p_replacement_id and coalesce(value->>'status','ACTIVE')='ACTIVE';
      end if;
      if replacement is null or p_replacement_id=p_creator_id then raise exception 'CREATOR_REPLACEMENT_REQUIRED'; end if;
      -- Same snapshot -> trash lock order as restore/permanent deletion.
      for trash_row in select t.* from private.content_video_trash t
        where t.environment='production' and t.restored_at is null
          and lower(coalesce(t.payload->>'permanentDeleted','false'))<>'true'
          and not exists(select 1 from private.video_deletion_jobs d where d.environment=t.environment and d.video_id=t.video_id and d.confirmed_at is not null)
          and p_creator_id in (t.payload#>>'{draft,video,creatorId}',t.payload#>>'{published,video,creatorId}',t.payload#>>'{video,creatorId}')
        for update
      loop
        trash_payload:=trash_row.payload;
        foreach scope in array array['draft','published'] loop
          if trash_payload#>>array[scope,'video','creatorId']=p_creator_id then
            trash_payload:=jsonb_set(trash_payload,array[scope,'video'],(trash_payload#>array[scope,'video']) || jsonb_build_object('creatorId',replacement->'id','creator',replacement->>'name'));
          end if;
        end loop;
        if trash_payload#>>'{video,creatorId}'=p_creator_id then
          trash_payload:=jsonb_set(trash_payload,'{video}',(trash_payload->'video') || jsonb_build_object('creatorId',replacement->'id','creator',replacement->>'name'));
        end if;
        update private.content_video_trash set payload=trash_payload where id=trash_row.id;
      end loop;
    end if;
  end if;
  creator:=creator || jsonb_build_object('status',p_status,'deletedAt',case when p_status='DELETED' then to_jsonb(now()) else 'null'::jsonb end);
  foreach scope in array array['draft','published'] loop
    doc:=case when scope='draft' then c.draft else c.published end;
    if scope='draft' or p_status='ACTIVE' then
      doc:=jsonb_set(doc,'{creators}',private.upsert_json_array_item(doc->'creators',creator,'id'));
    else
      doc:=jsonb_set(doc,'{creators}',coalesce((select jsonb_agg(value order by ord) from jsonb_array_elements(doc->'creators') with ordinality a(value,ord) where value->>'id' is distinct from p_creator_id),'[]'));
    end if;
    if replacement is not null then
      if scope='published' then doc:=jsonb_set(doc,'{creators}',private.upsert_json_array_item(doc->'creators',replacement,'id')); end if;
      doc:=jsonb_set(doc,'{videos}',coalesce((select jsonb_agg(case when value->>'creatorId'=p_creator_id then value || jsonb_build_object('creatorId',replacement->'id','creator',replacement->>'name') else value end order by ord) from jsonb_array_elements(doc->'videos') with ordinality a(value,ord)),'[]'));
    end if;
    perform private.validate_content_snapshot(doc);
    if scope='draft' then c.draft:=doc; else c.published:=doc; end if;
  end loop;
  update private.content_snapshots s set draft=c.draft,published=c.published,revision=s.revision+1,updated_at=now(),published_at=now(),updated_by=auth.uid() where s.environment='production';
  return query select s.revision,s.draft from private.content_snapshots s where s.environment='production';
end;
$$;
revoke all on function public.admin_set_creator_status_v1(text,text,text,bigint) from public,anon;
grant execute on function public.admin_set_creator_status_v1(text,text,text,bigint) to authenticated;
