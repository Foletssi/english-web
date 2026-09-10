-- Bound administrator invite generation without depending on an external service.
-- The advisory lock makes the rolling quota safe under concurrent requests.

create or replace function private.enforce_activation_batch_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day_codes bigint;
  v_recent_batches bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('eastudy-invites:' || new.created_by::text, 0));
  select coalesce(sum(batch.code_count), 0),
    count(*) filter(where batch.created_at > now() - interval '5 minutes')
  into v_day_codes, v_recent_batches
  from private.activation_code_batches batch
  where batch.created_by = new.created_by
    and batch.created_at > now() - interval '24 hours';
  if v_day_codes + new.code_count > 500 or v_recent_batches >= 20 then
    raise exception 'INVITE_RATE_LIMIT' using errcode = '54000';
  end if;
  return new;
end;
$$;

drop trigger if exists activation_batch_rate_limit
  on private.activation_code_batches;
create trigger activation_batch_rate_limit
before insert on private.activation_code_batches
for each row execute function private.enforce_activation_batch_rate_limit();

revoke all on function private.enforce_activation_batch_rate_limit()
  from public, anon, authenticated;
