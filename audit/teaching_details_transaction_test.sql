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

  select * into c from private.content_snapshots where environment='production' for update;
  select v->>'id',(v->>'processingJobId')::uuid into vid,job from jsonb_array_elements(c.published->'videos') v where v->>'status'='PUBLISHED' limit 1;
  if vid is null then raise exception 'Published video fixture required'; end if;
  update private.content_snapshots set published=pg_temp.snapshot_with_fixture_rows(published,vid,rows),draft=pg_temp.snapshot_with_fixture_rows(draft,vid,rows) where environment='production';
  select * into fixture from private.content_snapshots where environment='production';
  select jsonb_agg(r-array['english','textRevision','startTime','endTime','reviewStatus'] order by n) into patches from jsonb_array_elements(rows) with ordinality a(r,n);
  perform set_config('request.jwt.claim.role','service_role',true);
  bad:=jsonb_set(rows,'{0,translationLocked}','true');
  update private.content_snapshots set published=jsonb_set(published,array['sentences',vid],bad) where environment='production';
  perform pg_temp.expect_failure(format('select public.service_commit_reviewed_teaching(%L,%L,%s,%L,%L,%L)',
    vid,job,c.revision,bad,rows,jsonb_set(patches,'{0,chinese}','"修改人工翻译"')),'TEACHING_TRANSLATION_LOCKED');
  update private.content_snapshots set published=jsonb_set(published,array['sentences',vid],rows),draft=jsonb_set(draft,array['sentences',vid],bad) where environment='production';
  perform pg_temp.expect_failure(format('select public.service_commit_reviewed_teaching(%L,%L,%s,%L,%L,%L)',
    vid,job,c.revision,rows,bad,jsonb_set(patches,'{0,chinese}','"修改人工翻译"')),'TEACHING_TRANSLATION_LOCKED');
  update private.content_snapshots set draft=jsonb_set(draft,array['sentences',vid],rows) where environment='production';
  result:=public.service_commit_reviewed_teaching(vid,job,c.revision,rows,rows,patches);
  select * into a from private.content_snapshots where environment='production';
  if a.published->'sentences'->vid is distinct from rows or a.draft->'sentences'->vid is distinct from rows
    or a.revision<>c.revision+1 then raise exception 'Detail publication not exact'; end if;
  if a.published-'sentences'<>fixture.published-'sentences' or a.draft-'sentences'<>fixture.draft-'sentences'
    then raise exception 'Details changed unrelated catalog fields'; end if;
  if has_function_privilege('service_role','private.service_commit_reviewed_teaching_base_v1(text,uuid,bigint,jsonb,jsonb,jsonb)','execute')
    or has_function_privilege('service_role','private.processing_commit_learning_repair_legacy_v4(uuid,uuid,text,text,jsonb)','execute')
    or has_function_privilege('service_role','private.processing_commit_learning_repair_base_v5(uuid,uuid,text,text,jsonb)','execute')
    then raise exception 'Unvalidated base RPC accessible'; end if;
  -- The guard must reject a v5 job before attempting lease/token validation.
  update public.processing_jobs set input=input||'{"contractVersion":5,"teachingSchemaVersion":3}'::jsonb where id=job;
  perform pg_temp.expect_failure(format('select public.processing_commit_learning_repair_v4(%L,%L,%L,%L,%L)',
    job,'00000000-0000-0000-0000-000000000000','none','rollback-test','{}'),'LEARNING_REPAIR_V5_REQUIRED');
  -- Restore the exact pre-test snapshot; the caller also rolls back backups/jobs.
  update private.content_snapshots set published=c.published,draft=c.draft,revision=c.revision,updated_at=c.updated_at where environment='production';
end $$;
