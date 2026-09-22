-- Reconcile previously completed processing results with the AI-authoritative
-- difficulty decision already used by the v3 finalization path.
begin;
set local lock_timeout='10s';
set local statement_timeout='60s';

do $migration$
declare row record; repaired jsonb;
begin
  for row in
    select id,run_id,result
    from public.processing_jobs
    where status='REVIEW'
      and jsonb_typeof(result->'video'->'difficulty')='object'
      and result->'video'->'difficulty'->>'source'='ai'
      and result->'video'->'difficulty'->>'reviewStatus'='review'
    for update
  loop
    repaired:=private.processing_finalize_ai_result_v1(row.result);
    if repaired is distinct from row.result then
      update public.processing_jobs
      set result=repaired, updated_at=clock_timestamp()
      where id=row.id;
      insert into private.processing_job_events(job_id,run_id,kind,stage,details)
      values(row.id,row.run_id,'REVIEW','REVIEW',jsonb_build_object(
        'source','20260922141000_processing_result_backfill',
        'reason','ai-difficulty-authoritative',
        'difficultyReviewStatus','approved'));
    end if;
  end loop;
end $migration$;

notify pgrst,'reload schema';
commit;
