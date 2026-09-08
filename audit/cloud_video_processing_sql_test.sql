begin;

do $$
declare
  v_admin uuid;
  v_revision bigint;
  v_created jsonb;
  v_job_id uuid;
  v_claim jsonb;
  v_snapshot jsonb;
  v_new_revision bigint;
  v_status text;
  v_commit jsonb;
begin
  select m.user_id into v_admin from private.admin_memberships m where m.status='active' limit 1;
  if v_admin is null then
    select p.id into v_admin from public.profiles p where lower(coalesce(p.role,''))='admin' limit 1;
  end if;
  assert v_admin is not null, 'NO_ADMIN_TEST_PRINCIPAL';
  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_admin,'role','authenticated')::text, true);
  select c.revision into v_revision from private.content_snapshots c where c.environment='production';

  v_created := public.admin_create_processing_job(
    jsonb_build_object('id',9999999999001,'title','Transactional cloud processing test','creator','Contract test'),
    'videos/00000000-0000-0000-0000-000000000001/source.mp4',
    'sql-contract-' || txid_current()::text,
    v_revision
  );
  v_job_id := (v_created->'job'->>'id')::uuid;
  assert v_job_id is not null, 'JOB_CREATE_FAILED';

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select c.job into v_claim from public.processing_claim_jobs(1,90) c;
  assert v_claim->>'id'=v_job_id::text, 'JOB_CLAIM_FAILED';
  assert nullif(v_claim->>'lease_token','') is not null, 'JOB_LEASE_MISSING';

  perform set_config('request.jwt.claims', jsonb_build_object('sub',v_admin,'role','authenticated')::text, true);
  select t.snapshot,t.revision into v_snapshot,v_new_revision
  from public.admin_trash_content_videos(array['9999999999001'],(v_created->>'revision')::bigint) t;
  assert not exists(select 1 from jsonb_array_elements(v_snapshot->'videos') v where v->>'id'='9999999999001'), 'TRASH_SNAPSHOT_LEAK';
  select j.status into v_status from public.processing_jobs j where j.id=v_job_id;
  assert v_status='CANCELLED', 'TRASH_DID_NOT_CANCEL_JOB';

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_commit := public.processing_commit_result(v_job_id,'{}'::jsonb);
  assert v_commit->>'status'='CANCELLED', 'LATE_RESULT_REVIVED_VIDEO';
end;
$$;

rollback;
