begin;

-- Retry recovery must never be rolled back by a concurrent content snapshot
-- write. The job can resume from its durable checkpoint; the next progress or
-- finalization sync will refresh the admin projection.
do $patch$
declare definition text;
begin
  definition := pg_get_functiondef('private.sync_processing_retry_snapshot_v1(public.processing_jobs)'::regprocedure);
  if position('for update;' in definition) = 0 then
    raise exception 'RETRY_SNAPSHOT_LOCK_PATCH_DRIFT';
  end if;
  execute replace(definition, 'for update;', 'for update skip locked;');
end $patch$;

commit;
