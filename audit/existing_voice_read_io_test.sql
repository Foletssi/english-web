-- Caller-owned transaction after 20260920051000; all data is synthetic/temp.
create function pg_temp.voice_snapshot_original(doc jsonb,a private.teaching_voice_assets,sha text)
returns boolean language sql immutable as $$
 select exists(select 1 from jsonb_array_elements(doc->'videos') v
 cross join lateral jsonb_array_elements(coalesce(v#>'{voiceManifest,items}','[]')) item
 cross join lateral jsonb_array_elements(coalesce(doc->'sentences'->a.video_id,'[]')) sentence
 where v->>'id'=a.video_id and v->>'status'='PUBLISHED' and v->>'processingJobId'=a.playback_job_id::text
 and v#>>'{voiceManifest,status}'='complete' and item->>'status'='ready'
 and item->>'itemId'=a.item_id and item->>'ownerJobId'=a.owner_job_id::text and item->>'runId'=a.run_id::text
 and item->>'fingerprint'=a.fingerprint and item->>'storagePath'=a.path and item->>'contentHash'=sha
 and sentence->>'id'=a.sentence_id and coalesce(sentence->>'textRevision','1')=a.source_text_revision::text
 and sentence->>'english'=a.source_english and private.voice_source_item_v1(sentence,a.kind,a.local_id)=a.source_item)
$$;
create temp table voice_io_cases(name text,doc jsonb,asset private.teaching_voice_assets,expected boolean) on commit drop;
do $$
declare asset private.teaching_voice_assets; doc jsonb; changed jsonb; source jsonb; field text; sentence jsonb; fixture_item jsonb; fixture_video jsonb;
begin
 source:='{"tokenId":"t0","surface":"Go","coreMeaningZh":"走"}';
 asset:=jsonb_populate_record(null::private.teaching_voice_assets,jsonb_build_object(
 'owner_job_id','00000000-0000-4000-8000-000000000001','playback_job_id','00000000-0000-4000-8000-000000000002',
 'run_id','00000000-0000-4000-8000-000000000003','video_id','7','sentence_id','s0','source_text_revision',1,
 'kind','token','local_id','t0','source_english','Go!','source_item',source,'item_id','item0','fingerprint','fingerprint0','path','voice/file.mp3'));
 sentence:=jsonb_build_object('id','s0','english','Go!','wordLookup',jsonb_build_object('tokens',jsonb_build_array(source)));
 fixture_item:=jsonb_build_object('status','ready','itemId','item0','ownerJobId',asset.owner_job_id,
  'runId',asset.run_id,'fingerprint',asset.fingerprint,'storagePath',asset.path,'contentHash','hash0');
 fixture_video:=jsonb_build_object('id',7,'status','PUBLISHED','processingJobId',asset.playback_job_id,
  'voiceManifest',jsonb_build_object('status','complete','items',jsonb_build_array(fixture_item)));
 doc:=jsonb_build_object('videos',jsonb_build_array(fixture_video),'sentences',jsonb_build_object('7',jsonb_build_array(sentence)));
 insert into voice_io_cases values('valid numeric id and absent revision',doc,asset,true),('null',null,asset,false),('empty','{}',asset,false);
 foreach field in array array['status','processingJobId','id'] loop
  insert into voice_io_cases values('video '||field,jsonb_set(doc,array['videos','0',field],'"wrong"'),asset,false);
 end loop;
 insert into voice_io_cases values('manifest status',jsonb_set(doc,'{videos,0,voiceManifest,status}','"pending"'),asset,false);
 foreach field in array array['status','itemId','ownerJobId','runId','fingerprint','storagePath','contentHash'] loop
  insert into voice_io_cases values('item '||field,jsonb_set(doc,array['videos','0','voiceManifest','items','0',field],'"wrong"'),asset,false);
  insert into voice_io_cases values('missing item '||field,doc#-array['videos','0','voiceManifest','items','0',field],asset,false);
 end loop;
 foreach field in array array['id','english','textRevision'] loop
  insert into voice_io_cases values('sentence '||field,jsonb_set(doc,array['sentences','7','0',field],'"wrong"'),asset,false);
 end loop;
 insert into voice_io_cases values('changed meaning',jsonb_set(doc,'{sentences,7,0,wordLookup,tokens,0,coreMeaningZh}','"different"'),asset,false),
 ('changed token identity',jsonb_set(doc,'{sentences,7,0,wordLookup,tokens,0,tokenId}','"t1"'),asset,false),
 ('missing manifest',doc#-'{videos,0,voiceManifest}',asset,false),
 ('string video id',jsonb_set(doc,'{videos,0,id}','"7"'),asset,true),
 ('later valid duplicate video',jsonb_set(doc,'{videos}',jsonb_build_array(jsonb_set(doc#>'{videos,0}','{status}','"DRAFT"'),doc#>'{videos,0}')),asset,true),
 ('later valid duplicate sentence',jsonb_set(doc,'{sentences,7}',jsonb_build_array(jsonb_set(sentence,'{english}','"old"'),sentence)),asset,true);
 changed:=jsonb_set(doc,'{videos,0,voiceManifest,items}',jsonb_build_array(jsonb_set(doc#>'{videos,0,voiceManifest,items,0}','{fingerprint}','"old"'),doc#>'{videos,0,voiceManifest,items,0}'));
 insert into voice_io_cases values('later valid duplicate item',changed,asset,true);
 asset.kind:='expression';asset.local_id:='e0';asset.source_item:='{"surface":"Go","coreMeaningZh":"走","reviewStatus":"APPROVED"}';
 changed:=jsonb_set(doc,'{sentences,7,0,expressions}',jsonb_build_array(asset.source_item));
 insert into voice_io_cases values('expression fallback id',changed,asset,true),
 ('rejected expression',jsonb_set(changed,'{sentences,7,0,expressions,0,reviewStatus}','"REJECTED"'),asset,false);
end $$;
do $$
declare test record; old_value boolean; new_value boolean;
begin
 for test in select * from voice_io_cases loop
  old_value:=pg_temp.voice_snapshot_original(test.doc,test.asset,'hash0');
  new_value:=private.processing_voice_snapshot_matches_v1(test.doc,test.asset,'hash0');
  if old_value is distinct from test.expected or new_value is distinct from old_value then raise exception 'VOICE_ACCESS_CHANGED: %',test.name; end if;
 end loop;
 if has_function_privilege('anon','private.processing_voice_snapshot_matches_v1(jsonb,private.teaching_voice_assets,text)','EXECUTE')
  or has_function_privilege('service_role','private.processing_voice_snapshot_matches_v1(jsonb,private.teaching_voice_assets,text)','EXECUTE') then raise exception 'VOICE_HELPER_EXPOSED'; end if;
end $$;
create temp table voice_io_payload as
 select jsonb_set(doc,'{videos}',jsonb_build_array(
   jsonb_build_object('id',6,'voiceManifest',jsonb_build_object('padding',repeat('x',3145728))),
   jsonb_set(doc#>'{videos,0}','{voiceManifest,padding}',to_jsonb(repeat('x',3145728)))
 )) as doc,asset
 from voice_io_cases where name='valid numeric id and absent revision';
create temp table voice_io_benchmark(name text,ms numeric,temp_written_blocks bigint) on commit drop;
do $$
declare plan jsonb;
begin
 execute 'explain(analyze,buffers,format json) select pg_temp.voice_snapshot_original(doc,asset,''hash0'') from voice_io_payload' into plan;
 insert into voice_io_benchmark values('original voice check',(plan#>>'{0,Execution Time}')::numeric,coalesce((plan#>>'{0,Plan,Temp Written Blocks}')::bigint,0));
 execute 'explain(analyze,buffers,format json) select private.processing_voice_snapshot_matches_v1(doc,asset,''hash0'') from voice_io_payload' into plan;
 insert into voice_io_benchmark values('revised voice check',(plan#>>'{0,Execution Time}')::numeric,coalesce((plan#>>'{0,Plan,Temp Written Blocks}')::bigint,0));
 if coalesce((plan#>>'{0,Plan,Temp Written Blocks}')::bigint,0)<>0 then raise exception 'VOICE_CHECK_STILL_SPILLS'; end if;
end $$;
select jsonb_build_object('access_cases',(select count(*) from voice_io_cases),'benchmark',(select jsonb_agg(to_jsonb(b)) from voice_io_benchmark b)) as voice_checks;
