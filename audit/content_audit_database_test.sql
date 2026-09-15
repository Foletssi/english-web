-- Run only inside BEGIN/ROLLBACK, with the candidate migration before this file.
do $test$
declare cur jsonb; patch jsonb; merged jsonb; actor uuid; other_actor uuid; vid text;
rev bigint; before_published jsonb; first_job jsonb; reused jsonb; totals jsonb; jobs_before bigint;
begin
 cur:='{"id":"test","english":"We put off the task.","chinese":"人工翻译","startTime":0,"endTime":3,"textRevision":7,"selectionLocked":true,"keyWords":["put off"],"expressions":[{"surface":"put off","coreMeaningZh":"人工核心释义","source":"manual","needsReview":true}],"wordTimings":[{"text":"We","start":0,"end":0.2}]}'::jsonb;
 patch:='{"id":"test","english":"We put off the task.","chinese":"AI翻译","keyWords":["put off"],"expressions":[{"surface":"put off","coreMeaningZh":"推迟","contextMeaningZh":"推迟任务","lemma":"put off","expressionType":"phrasal_verb","selectionReasonZh":"常用可迁移动词短语","needsReview":false}],"teachingAnalysis":{"status":"completed","promptVersion":"test-real","sourceTextRevision":7}}'::jsonb;
 merged:=private.merge_learning_sentence_v5(cur,patch,'fill_missing');
 if merged->'expressions'->0->>'coreMeaningZh'<>'人工核心释义' or merged->>'chinese'<>'人工翻译'
 or merged->'wordTimings' is distinct from cur->'wordTimings'
 or merged->'expressions'->0->>'expressionType'<>'phrasal_verb'
 or merged->'expressions'->0->>'needsReview'<>'true'
 or merged->'expressions'->0->>'approved'<>'false'
 or merged->>'reviewStatus'<>'REVIEW' then raise exception 'FIELD_PRESERVATION_FAILED'; end if;
 if not private.learning_analysis_complete_v1(merged) then raise exception 'ACTUAL_ANALYSIS_LOST'; end if;
 if private.learning_analysis_complete_v1(merged||'{"textRevision":8}'::jsonb) then raise exception 'STALE_ANALYSIS_ACCEPTED'; end if;
 merged:=private.merge_learning_sentence_v5(cur||'{"keyWords":[],"expressions":[]}'::jsonb,patch,'reextract');
 if merged->'keyWords'<>'[]'::jsonb or merged->'expressions'<>'[]'::jsonb then raise exception 'LOCKED_EMPTY_CHANGED'; end if;
 merged:=private.merge_learning_sentence_v5(cur,patch-'teachingAnalysis','fill_missing');
 if merged ? 'teachingAnalysis' then raise exception 'OLD_WORKER_FALSE_PROVENANCE'; end if;
 select p.id into actor from public.profiles p where p.is_active and (lower(p.role)='admin' or exists(select 1 from private.admin_memberships m where m.user_id=p.id and m.status='active')) limit 1;
 if actor is null then raise exception 'ADMIN_FIXTURE_UNAVAILABLE'; end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 select revision,published,draft->'videos'->0->>'id' into rev,before_published,vid from private.content_snapshots where environment='production' for update;
 select count(*) into jobs_before from public.processing_jobs;
 begin
   perform public.admin_create_learning_repair_job_v5(vid,rev-1,'fill_missing');
   raise exception 'STALE_CREATE_ACCEPTED';
 exception when others then if sqlerrm<>'CONTENT_REVISION_CONFLICT' then raise; end if; end;
 first_job:=public.admin_create_learning_repair_job_v5(vid,rev,'fill_missing');
 reused:=public.admin_create_learning_repair_job_v5(vid,rev,'fill_missing');
 if reused->>'reused'<>'true' or reused->'job'->>'id'<>first_job->'job'->>'id' then raise exception 'IDEMPOTENCY_FAILED'; end if;
 select id into other_actor from auth.users where id<>actor limit 1;
 if other_actor is not null then
  -- Existing job owned by another user must still be reused by this administrator.
  update public.processing_jobs set requested_by=other_actor where id=(first_job->'job'->>'id')::uuid;
  reused:=public.admin_create_learning_repair_job_v5(vid,rev,'fill_missing');
  if reused->'job'->>'id'<>first_job->'job'->>'id' then raise exception 'CROSS_ADMIN_DUPLICATE'; end if;
 end if;
 if (select count(*) from public.processing_jobs)<>jobs_before+1 then raise exception 'DUPLICATE_JOB_CREATED'; end if;
 begin
   perform public.admin_create_learning_repair_job_v5(vid,rev,'reextract');
   raise exception 'CONFLICTING_MODE_ACCEPTED';
 exception when others then if sqlerrm<>'VIDEO_PROCESSING_ACTIVE' then raise; end if; end;
 totals:=public.admin_list_processing_video_groups_v1(1,1);
 if (totals->'summary'->>'active')::integer<>1 or jsonb_array_length(totals->'items')<>1
 or (totals->>'total')::integer<>2 then raise exception 'GLOBAL_SUMMARY_FAILED:%',totals->'summary'; end if;
 if totals->'summary' is distinct from public.admin_list_processing_video_groups_v1(2,1)->'summary' then raise exception 'PAGINATION_CHANGED_TOTALS'; end if;
 if (select published from private.content_snapshots where environment='production') is distinct from before_published then raise exception 'PUBLISHED_CHANGED'; end if;
 -- Commit source-conflict guards are reviewed separately; this fixture tests merge and task creation.
end $test$;
