begin;

-- Worker heartbeat, telemetry, and teaching preflight all touch the same Job
-- row. The old 2s lock wait turned normal overlap into false retryable ERRORs.
-- Keep the wait bounded, but let the idempotent worker retry window absorb the
-- short critical section used by heartbeat/finalization.
alter function public.processing_validate_teaching_v2(uuid,uuid,text,text,jsonb)
  set statement_timeout='60s';
alter function public.processing_validate_teaching_v2(uuid,uuid,text,text,jsonb)
  set lock_timeout='10s';

commit;
