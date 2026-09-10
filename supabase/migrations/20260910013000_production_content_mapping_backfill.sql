-- Backfill reviewed catalog mappings for the two existing production Vlogs.
-- Media objects and sentence data are not modified. A full snapshot backup is
-- retained in the private schema before the revision is changed.

create table if not exists private.content_snapshot_repair_backups (
  repair_id text primary key,
  environment text not null,
  draft jsonb not null,
  published jsonb not null,
  revision bigint not null,
  created_at timestamptz not null default now()
);

do $$
declare
  v_draft jsonb;
  v_published jsonb;
  v_revision bigint;
  v_creator_111 jsonb := jsonb_build_object(
    'id','creator-1788926081631-pbtry','name','111','bio','一周生活、工作与朋友日常 Vlog','status','ACTIVE','category','日常生活'
  );
  v_creator_sydney jsonb := jsonb_build_object(
    'id','creator-sydneyserena','name','SydneySerena','bio','忙碌日常、美妆购物与自然口语 Vlog','status','ACTIVE','category','日常生活'
  );
  v_collection jsonb := jsonb_build_object(
    'id',1001,'title','真实生活日常 Vlog','subtitle','在一周生活与忙碌日常中学习自然英语',
    'description','通过真实生活记录学习日常口语、人物交流与自然语速表达。',
    'cover','/api/processing/media/c295fa07-9d5f-4b3d-b1e1-1e915ac78249/cover.webp',
    'level','B1–B2','topicId','daily','category','日常生活','status','PUBLISHED'
  );
begin
  select draft,published,revision into v_draft,v_published,v_revision
  from private.content_snapshots where environment='production' for update;

  if v_revision is null then
    raise exception 'PRODUCTION_CONTENT_SNAPSHOT_MISSING';
  end if;

  insert into private.content_snapshot_repair_backups(repair_id,environment,draft,published,revision)
  values('beta6.29.0-catalog-mapping', 'production', v_draft, v_published, v_revision)
  on conflict(repair_id) do nothing;

  -- Do not overwrite later administrator edits if the production revision has moved.
  if v_revision <> 42 then
    raise notice 'Catalog backfill skipped: expected revision 42, found %',v_revision;
    return;
  end if;

  select jsonb_set(
    jsonb_set(
      jsonb_set(v_draft,'{schemaVersion}','3'::jsonb,true),
      '{videos}',
      (select jsonb_agg(
        case v->>'id'
          when '1788926081632' then v || jsonb_build_object(
            'creatorId','creator-1788926081631-pbtry','collectionIds',jsonb_build_array(1001),
            'tagIds',jsonb_build_array('vlog','daily-life','spoken-english','friendship','coffee-ordering'),
            'tagAssignments',jsonb_build_array(
              jsonb_build_object('id','vlog','reviewStatus','APPROVED','evidence','英文标题与逐字稿'),
              jsonb_build_object('id','daily-life','reviewStatus','APPROVED','evidence','一周真实生活记录'),
              jsonb_build_object('id','spoken-english','reviewStatus','APPROVED','evidence','自然聊天语速逐字稿'),
              jsonb_build_object('id','friendship','reviewStatus','APPROVED','evidence','与朋友喝咖啡和品牌活动'),
              jsonb_build_object('id','coffee-ordering','reviewStatus','APPROVED','evidence','喝咖啡场景')
            )
          )
          when '1788957611645' then v || jsonb_build_object(
            'creatorId','creator-sydneyserena','collectionIds',jsonb_build_array(1001),
            'tagIds',jsonb_build_array('vlog','daily-life','spoken-english','morning-routine','food'),
            'tagAssignments',jsonb_build_array(
              jsonb_build_object('id','vlog','reviewStatus','APPROVED','evidence','英文标题与逐字稿'),
              jsonb_build_object('id','daily-life','reviewStatus','APPROVED','evidence','忙碌一天生活记录'),
              jsonb_build_object('id','spoken-english','reviewStatus','APPROVED','evidence','自然口语逐字稿'),
              jsonb_build_object('id','morning-routine','reviewStatus','APPROVED','evidence','化妆、挑衣服与出门流程'),
              jsonb_build_object('id','food','reviewStatus','APPROVED','evidence','南瓜拿铁与晚间鸡汤场景')
            )
          )
          else v
        end order by ord
      ) from jsonb_array_elements(v_draft->'videos') with ordinality rows(v,ord)),true),
    '{creators}',jsonb_build_array(v_creator_111,v_creator_sydney),true
  ) into v_draft;
  v_draft := jsonb_set(v_draft,'{collections}',jsonb_build_array(v_collection),true);

  select jsonb_set(
    jsonb_set(
      jsonb_set(v_published,'{schemaVersion}','3'::jsonb,true),
      '{videos}',
      (select jsonb_agg(
        case v->>'id'
          when '1788926081632' then v || jsonb_build_object(
            'creatorId','creator-1788926081631-pbtry','collectionIds',jsonb_build_array(1001),
            'tagIds',jsonb_build_array('vlog','daily-life','spoken-english','friendship','coffee-ordering'),
            'tagAssignments',jsonb_build_array(
              jsonb_build_object('id','vlog','reviewStatus','APPROVED','evidence','英文标题与逐字稿'),
              jsonb_build_object('id','daily-life','reviewStatus','APPROVED','evidence','一周真实生活记录'),
              jsonb_build_object('id','spoken-english','reviewStatus','APPROVED','evidence','自然聊天语速逐字稿'),
              jsonb_build_object('id','friendship','reviewStatus','APPROVED','evidence','与朋友喝咖啡和品牌活动'),
              jsonb_build_object('id','coffee-ordering','reviewStatus','APPROVED','evidence','喝咖啡场景')
            )
          )
          when '1788957611645' then v || jsonb_build_object(
            'creatorId','creator-sydneyserena','collectionIds',jsonb_build_array(1001),
            'tagIds',jsonb_build_array('vlog','daily-life','spoken-english','morning-routine','food'),
            'tagAssignments',jsonb_build_array(
              jsonb_build_object('id','vlog','reviewStatus','APPROVED','evidence','英文标题与逐字稿'),
              jsonb_build_object('id','daily-life','reviewStatus','APPROVED','evidence','忙碌一天生活记录'),
              jsonb_build_object('id','spoken-english','reviewStatus','APPROVED','evidence','自然口语逐字稿'),
              jsonb_build_object('id','morning-routine','reviewStatus','APPROVED','evidence','化妆、挑衣服与出门流程'),
              jsonb_build_object('id','food','reviewStatus','APPROVED','evidence','南瓜拿铁与晚间鸡汤场景')
            )
          )
          else v
        end order by ord
      ) from jsonb_array_elements(v_published->'videos') with ordinality rows(v,ord)),true),
    '{creators}',jsonb_build_array(v_creator_111,v_creator_sydney),true
  ) into v_published;
  v_published := jsonb_set(v_published,'{collections}',jsonb_build_array(v_collection),true);

  update private.content_snapshots
  set draft=v_draft,published=v_published,revision=revision+1,updated_at=now(),published_at=now()
  where environment='production' and revision=42;
end $$;

