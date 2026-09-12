import fs from 'node:fs';
import assert from 'node:assert/strict';

const read=path=>fs.readFileSync(path,'utf8');
const boundaries=read('docs/FUNCTIONAL_MODULES.md');
for(let index=1;index<=10;index+=1)assert.match(boundaries,new RegExp(`M${String(index).padStart(2,'0')}`),`missing module M${index}`);

const edgeLogin=read('supabase/functions/learner-auth/index.ts');
const edgeRegister=read('supabase/functions/invite-register/index.ts');
assert.ok(edgeLogin.includes("../_shared/login-identity.js"));
assert.ok(edgeRegister.includes("../_shared/login-identity.js"));
assert.ok(!edgeLogin.includes('function canonicalLoginKey('));
assert.ok(!edgeRegister.includes('function canonicalLoginKey('));

const session=read('functions/api/session.js');
const media=read('functions/api/processing/media/[[path]].js');
assert.ok(session.includes('service_resolve_playback_access_v2'));
assert.ok(session.includes('sealPlaybackTicket'));
assert.ok(!session.includes("eastudy_media_session='+encodeURIComponent(token)"));
assert.ok(media.includes('openPlaybackTicket'));
assert.ok(!media.includes('authenticate(request, env)'));

const client=read('shared/cloud-content.js');
const admin=read('admin/assets/admin.js');
assert.ok(client.includes('admin_list_processing_video_groups_v1'));
assert.ok(!client.includes("api.rpc('admin_list_processing_jobs'"));
assert.ok(admin.includes('pipelineVideoGroups()'));

console.log('Functional module boundary contracts passed.');
