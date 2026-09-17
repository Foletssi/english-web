import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = name => fs.readFileSync(`supabase/migrations/${name}.sql`, 'utf8');
const migration = read('20260917221500_local_source_consumers');
const planner = read('20260911173000_durable_video_deletion_v1').split('create or replace function public.admin_plan_permanent_video_delete')[1].split('end $$;')[0];
const anchor = migration.match(/v_anchor text:=\$anchor\$([\s\S]*?)\$anchor\$/)[1];
const filter = migration.match(/v_anchor\|\|\$filter\$([\s\S]*?)\$filter\$/)[1];
assert.equal(planner.split(anchor).length - 1, 2, 'patch must find both original-source candidate filters');
const patched = planner.replaceAll(anchor, () => anchor + filter);
const outputPrefixBody = sql => sql.split('into v_prefixes from (')[1];
assert.equal(outputPrefixBody(patched), outputPrefixBody(planner), 'all-run prefixes and shared-output guards must remain identical');
assert.equal(patched.replaceAll(filter, ''), planner, 'the only deletion change is local-original exclusion');
assert.match(filter, /localInputV1/);
assert.match(filter, /private\.processing_local_inputs/);
assert.match(migration, /private\.processing_input_descriptor_v1\(j\.id\)/);
assert.match(migration, /v_parent\.video_id is distinct from v_job\.video_id/);
assert.match(migration, /v_parent\.source_key is distinct from v_job\.source_key/);
assert.match(migration, /v_job\.id=any\(v_seen\)/);
const maintenanceAnchor = "'token',v_token,'previousDraftVideo',v_draft,'previousPublishedVideo',v_published);";
assert.equal(read('20260915090000_mobile_balanced_540').split(maintenanceAnchor).length - 1, 1,
  'maintenance descriptor patch must preserve existing successful lease response fields');
const resolver = read('20260917220000_local_first_inputs').split('create or replace function public.resolve_processing_source')[1];
assert.match(resolver, /t\.restored_at is null/);
assert.match(resolver, /d\.confirmed_at is not null/);
assert.match(resolver, /d\.source_keys \? j\.source_key/);
assert.match(resolver, /SOURCE_LOCAL_ONLY/);
console.log('Local source consumers: source-candidate-only patch, all-run/shared guards, ancestry and source authorization contracts passed.');
