import fs from 'node:fs';
import assert from 'node:assert/strict';

const migration=fs.readFileSync('supabase/migrations/20260912190000_functional_module_contracts_v3.sql','utf8');
const client=fs.readFileSync('shared/cloud-content.js','utf8');
const admin=fs.readFileSync('admin/assets/admin.js','utf8');
assert.ok(migration.includes('admin_list_processing_video_groups_v1'));
assert.ok(migration.indexOf('distinct on (video_id)') < migration.indexOf('offset (v_page-1)*v_size'));
assert.ok(migration.indexOf('offset (v_page-1)*v_size') < migration.indexOf("'records',coalesce"));
assert.ok(migration.includes("where j.video_id=p.video_id"));
assert.ok(migration.includes("content_video_trash"));
assert.ok(client.includes("api.rpc('admin_list_processing_video_groups_v1'"));
assert.ok(admin.includes('CloudState.videoGroups=result.groups'));
assert.ok(admin.includes('const groups=pipelineVideoGroups()'));
console.log('Processing queue video-first pagination contract passed.');
