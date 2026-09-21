begin;
-- Recover expired in-flight local jobs before starting untouched queued work.
-- This clears stale UI state promptly after a Worker restart while preserving
-- the existing run fence, checkpoints, hashes and upload receipts.
do $migration$
declare
  v_def text;
  v_anchor text := 'order by j.next_run_at,j.created_at';
  v_replacement text := 'order by (j.status=''RUNNING'') desc,j.next_run_at,j.created_at';
begin
  v_def := pg_get_functiondef('private.processing_claim_local_input_v1(text,text,integer)'::regprocedure);
  if strpos(v_def,v_replacement)>0 then return; end if;
  if strpos(v_def,v_anchor)=0 then raise exception 'LOCAL_RECOVERY_PRIORITY_PATCH_TARGET_MISMATCH'; end if;
  v_def := replace(v_def,v_anchor,v_replacement);
  execute v_def;
end $migration$;
comment on function private.processing_claim_local_input_v1(text,text,integer) is
  'Claims READY local inputs; expired RUNNING jobs are recovered before untouched queued work.';
commit;