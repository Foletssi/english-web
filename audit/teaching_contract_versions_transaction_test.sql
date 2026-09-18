-- Execute after the forward migration in a caller-owned ROLLBACK transaction.
-- Synthetic sentence fixtures; the temporary snapshot replacement is rolled back.
create function pg_temp.snapshot_with_fixture_rows(p_snapshot jsonb,p_video_id text,p_rows jsonb)
returns jsonb language sql as $$
  select jsonb_set(jsonb_set(p_snapshot,array['sentences',p_video_id],p_rows),'{videos}',
    (select jsonb_agg(case when v->>'id'=p_video_id and v#>'{difficulty,evidence}' is not null then
      jsonb_set(v,'{difficulty,evidence}',(select jsonb_agg(jsonb_set(e,'{sentenceIds}',jsonb_build_array(p_rows#>>'{0,id}')) order by n)
        from jsonb_array_elements(v#>'{difficulty,evidence}') with ordinality x(e,n))) else v end order by position)
      from jsonb_array_elements(p_snapshot->'videos') with ordinality t(v,position)));
$$;
do $$
declare
  row1 jsonb; row2 jsonb; rows jsonb; report jsonb; bad jsonb; patches jsonb;
  c private.content_snapshots%rowtype; a private.content_snapshots%rowtype; fixture private.content_snapshots%rowtype;
  vid text; job uuid; result jsonb;
begin
  row1:='{"id":"detail-s1","english":"😀 Go, go!","chinese":"快走吧！","textRevision":2,"startTime":0,"endTime":2,"keyWords":[],"expressions":[],"reviewStatus":"APPROVED",
    "teachingAnalysis":{"status":"completed","promptVersion":"adult-vlog-v9-20260916","reviewVersion":"adult-selection-review-v1-20260916","sourceTextRevision":2},
    "wordLookup":{"schemaVersion":1,"sourceEnglish":"😀 Go, go!","sourceTextRevision":2,"tokens":[{"tokenId":"t0","surface":"Go","start":3,"end":5,"coreMeaningZh":"走","pronunciationHint":"/ɡoʊ/"},{"tokenId":"t1","surface":"go","start":7,"end":9,"coreMeaningZh":"快走","pronunciationHint":"/ɡoʊ/"}]},
    "translationAnalysis":{"status":"completed","promptVersion":"context-lookup-v2-20260916","reviewVersion":"context-lookup-review-v2-20260916","sourceTextRevision":2,"sourceConcerns":[]},
    "coverageAnalysis":{"schemaVersion":1,"status":"completed","promptVersion":"adjacent-coverage-v1-20260916","reviewVersion":"adult-selection-review-v1-20260916","sourceTextRevision":2,"pairs":[]}}'::jsonb;
  row2:=jsonb_set(row1,'{id}','"detail-s2"');
  report:='{"pairId":"p0","sentenceIds":["detail-s1","detail-s2"],"sourceTextRevisions":[2,2],"status":"no_eligible_source","reasonZh":"原文是简单的催促呼语，没有进阶用法。"}'::jsonb;
  row1:=jsonb_set(row1,'{coverageAnalysis,pairs}',jsonb_build_array(report));
  row2:=jsonb_set(row2,'{coverageAnalysis,pairs}',jsonb_build_array(report));
  rows:=jsonb_build_array(row1,row2);
  if not private.learning_coverage_valid_v1(rows) then raise exception 'Valid UTF16 details rejected'; end if;
  bad:=jsonb_set(jsonb_set(jsonb_set(row1,
    '{coverageAnalysis,promptVersion}','"adjacent-coverage-v2-20260916"'),
    '{coverageAnalysis,reviewVersion}','"adult-selection-review-v2-20260916"'),
    '{teachingAnalysis,reviewVersion}','"adult-selection-review-v2-20260916"');
  if not private.learning_details_valid_v1(bad) then raise exception 'Valid v2 details rejected'; end if;
  if private.learning_details_valid_v1(jsonb_set(bad,'{coverageAnalysis,promptVersion}','"unknown"'))
    or private.learning_details_valid_v1(jsonb_set(bad,'{coverageAnalysis,reviewVersion}','"adult-selection-review-v1-20260916"'))
    or private.learning_details_valid_v1(jsonb_set(bad,'{teachingAnalysis,reviewVersion}','"adult-selection-review-v1-20260916"'))
    or private.learning_details_valid_v1(bad#-'{coverageAnalysis,promptVersion}')
    or private.learning_details_valid_v1(jsonb_set(bad,'{wordLookup,tokens,0,coreMeaningZh}','"释义待生成"'))
    or private.learning_details_valid_v1(jsonb_set(bad,'{wordLookup,tokens,0,pronunciationHint}','""'))
    then raise exception 'Invalid v2 details accepted'; end if;
  bad:=jsonb_set(row1,'{translationAnalysis,sourceConcerns}','["原文疑似漏词，尚不能消歧。"]');
  if private.learning_details_valid_v1(bad) then raise exception 'Uncertain source falsely completed'; end if;
  bad:=jsonb_set(bad,'{translationAnalysis,status}','"source_unresolved"');
  if private.learning_details_valid_v1(bad) then raise exception 'Uncertain translation missing provenance'; end if;
  bad:=jsonb_set(bad,'{translationAnalysis,translationOrigin}','"retained_source"');
  if not private.learning_details_valid_v1(bad)
    or not private.learning_coverage_valid_v1(jsonb_build_array(bad,row2)) then raise exception 'Uncertain source discarded reliable teaching'; end if;
  if private.learning_details_valid_v1(jsonb_set(bad,'{translationAnalysis,sourceConcerns}','[]'))
    then raise exception 'Unresolved source accepted without evidence'; end if;
  if private.learning_details_valid_v1(jsonb_set(row1,'{wordLookup,tokens,0,start}','2'))
    or private.learning_details_valid_v1(jsonb_set(row1,'{wordLookup,tokens,1,tokenId}','"t0"'))
    or private.learning_details_valid_v1(row1#-'{translationAnalysis,reviewVersion}')
    or private.learning_details_valid_v1(jsonb_set(row1,'{translationAnalysis,sourceTextRevision}','1'))
    or private.learning_details_valid_v1(jsonb_set(row1,'{wordLookup,tokens,0,coreMeaningZh}','"释义待生成"'))
    or private.learning_details_valid_v1(jsonb_set(row1,'{wordLookup,tokens,0,pronunciationHint}','""'))
    or private.learning_details_valid_v1(jsonb_set(row1,'{wordLookup,tokens,0,pronunciationHint}','"/riːd/ or /rɛd/"'))
    or private.learning_details_valid_v1(jsonb_set(row1,'{expressions}','[{"surface":"read between the lines","pronunciationHint":""}]'))
    then raise exception 'Invalid teaching detail accepted'; end if;
  if private.learning_coverage_valid_v1(jsonb_set(rows,'{0,coverageAnalysis,pairs,0,reasonZh}','"mismatch"'))
    or private.learning_coverage_valid_v1(jsonb_set(rows,'{0,coverageAnalysis,pairs,0,status}','"locked"'))
    or private.learning_coverage_valid_v1(jsonb_set(rows,'{0,coverageAnalysis,pairs}','[]'))
    then raise exception 'Invalid coverage accepted'; end if;
  bad:=private.merge_learning_sentence_v5(jsonb_set(row1,'{chinese}','"旧翻译"'),row1,'reextract');
  if bad->'chinese' is distinct from row1->'chinese' or bad->'wordLookup' is distinct from row1->'wordLookup'
    or bad->'translationAnalysis' is distinct from row1->'translationAnalysis'
    or bad->'coverageAnalysis' is distinct from row1->'coverageAnalysis' then raise exception 'Merge lost independently reviewed details'; end if;
  perform pg_temp.expect_failure(format('select private.merge_learning_sentence_v5(%L,%L,%L)',
    row1||'{"translationLocked":true,"chinese":"人工翻译"}'::jsonb,row1,'reextract'),'TEACHING_TRANSLATION_LOCKED');

end $$;
do $$
declare row_value jsonb; rows jsonb; manifest jsonb; receipts jsonb; item jsonb; path text;
 j public.processing_jobs%rowtype; actor uuid; i integer;
begin
 select requested_by into actor from public.processing_jobs where requested_by is not null limit 1;
 insert into public.processing_jobs(video_id,source_key,input,requested_by,idempotency_key,status,stage,progress,input_revision,output_run_id)
 values('999999999999999','videos/00000000-1111-2222-3333-444444444444/source.mp4','{"kind":"LEARNING_REPAIR"}',actor,
 'rollback-contract-'||gen_random_uuid(),'REVIEW','REVIEW',100,1,gen_random_uuid()) returning * into j;
 insert into private.processing_job_runs(job_id,run_id,worker_id,outcome) values(j.id,j.output_run_id,'rollback-test','REVIEW');
  row_value:='{"id":"voice-s1","english":"Go, go!","chinese":"快走吧！","textRevision":2,"startTime":0,"endTime":2,"keyWords":[],"expressions":[],"reviewStatus":"APPROVED",
    "teachingAnalysis":{"status":"completed","promptVersion":"adult-vlog-v9-20260916","reviewVersion":"adult-selection-review-v1-20260916","sourceTextRevision":2},
    "wordLookup":{"schemaVersion":1,"sourceEnglish":"Go, go!","sourceTextRevision":2,"tokens":[{"tokenId":"t0","surface":"Go","start":0,"end":2,"coreMeaningZh":"走","pronunciationHint":"/ɡoʊ/"},{"tokenId":"t1","surface":"go","start":4,"end":6,"coreMeaningZh":"快走","pronunciationHint":"/ɡoʊ/"}]},
    "translationAnalysis":{"status":"completed","promptVersion":"context-lookup-v2-20260916","reviewVersion":"context-lookup-review-v2-20260916","sourceTextRevision":2,"sourceConcerns":[]},
    "coverageAnalysis":{"schemaVersion":1,"status":"completed","promptVersion":"adjacent-coverage-v1-20260916","reviewVersion":"adult-selection-review-v1-20260916","sourceTextRevision":2,"pairs":[]}}'::jsonb;
  manifest:=jsonb_build_object('schemaVersion',1,'status','complete','videoId',j.video_id,'contentRevision','rollback-voice','items','[]'::jsonb);
  receipts:='[]'::jsonb;
  for i in 0..1 loop
    path:='voice/'||repeat((i+1)::text,64)||'.mp3';
    item:=jsonb_build_object('videoId',j.video_id,'contentRevision','rollback-voice','sentenceId','voice-s1','sourceTextRevision',2,
      'kind','token','tokenId','t'||i,'itemId',repeat((i+3)::text,64),'fingerprint',repeat((i+1)::text,64),'storagePath',path,
      'text',row_value#>>array['wordLookup','tokens',i::text,'surface'],'status','ready','bytes',1000,'contentHash',repeat('a',64));
    manifest:=jsonb_set(manifest,'{items}',manifest->'items'||jsonb_build_array(item));
    receipts:=receipts||jsonb_build_array(jsonb_build_object('path',path,'size',1000,'sha256',repeat('a',64),'etag','rollback-only'));
  end loop;

 insert into private.processing_output_receipts(job_id,run_id,path,size,sha256,etag)
 select j.id,j.output_run_id,r->>'path',(r->>'size')::bigint,r->>'sha256',r->>'etag' from jsonb_array_elements(receipts) r;
 rows:=jsonb_build_array(row_value);
 perform private.register_teaching_voice_v1(j.id,j.output_run_id,j.id,j.video_id,rows,manifest);
 row_value:=jsonb_set(jsonb_set(jsonb_set(row_value,'{coverageAnalysis,promptVersion}','"adjacent-coverage-v2-20260916"'),
 '{coverageAnalysis,reviewVersion}','"adult-selection-review-v2-20260916"'),'{teachingAnalysis,reviewVersion}','"adult-selection-review-v2-20260916"');
 rows:=jsonb_build_array(row_value);
 perform private.register_teaching_voice_v1(j.id,j.output_run_id,j.id,j.video_id,rows,manifest);
 perform pg_temp.expect_failure(format('select private.register_teaching_voice_v1(%L,%L,%L,%L,%L,%L)',
 j.id,j.output_run_id,j.id,j.video_id,jsonb_set(rows,'{0,wordLookup,tokens,0,pronunciationHint}','""'),manifest),'TEACHING_DETAILS_INVALID');
 perform pg_temp.expect_failure(format('select private.register_teaching_voice_v1(%L,%L,%L,%L,%L,%L)',
 j.id,j.output_run_id,j.id,j.video_id,rows,jsonb_set(manifest,'{items,0,sourceTextRevision}','1')),'VOICE_SOURCE_STALE');
 perform pg_temp.expect_failure(format('select private.register_teaching_voice_v1(%L,%L,%L,%L,%L,%L)',
 j.id,j.output_run_id,j.id,j.video_id,rows,jsonb_set(manifest,'{items,0,contentHash}',to_jsonb(repeat('b',64)))),'VOICE_RECEIPT_MISSING');
 perform pg_temp.expect_failure(format('select private.register_teaching_voice_v1(%L,%L,%L,%L,%L,%L)',
 gen_random_uuid(),j.output_run_id,j.id,j.video_id,rows,manifest),'VOICE_JOB_MISMATCH');
end $$;
