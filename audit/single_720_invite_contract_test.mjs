import fs from 'node:fs';
import assert from 'node:assert/strict';

const migration=fs.readFileSync('supabase/migrations/20260911120000_single_720p_and_invite_registration.sql','utf8');
const html=fs.readFileSync('index.html','utf8');
const app=fs.readFileSync('assets/js/app.js','utf8');
const css=fs.readFileSync('assets/css/app.css','utf8');
const worker=fs.readFileSync('services/cloud-worker/worker.py','utf8');
const pipeline=fs.readFileSync('services/local-studio/pipeline.py','utf8');
const media=fs.readFileSync('services/local-studio/media_tools.py','utf8');
const session=fs.readFileSync('functions/api/session.js','utf8');
const mediaRoute=fs.readFileSync('functions/api/processing/media/[[path]].js','utf8');

assert.ok(media.includes("'label': '720p'"));
assert.ok(media.includes('encoded_size = min(720'));
assert.ok(media.includes("'crf': 25"));
assert.ok(pipeline.includes("'policy': 'single-standard-v2'"));
assert.ok(!pipeline.includes("'original':"));
assert.ok(worker.includes("'policy': 'single-standard-v2'"));
assert.ok(!worker.includes("original['url']"));
assert.ok(!html.includes('id="qualitySelect"'));
assert.ok(!css.includes('.quality-control'));
assert.ok(app.includes("EastudyMediaPlayer.create({video,source:managed"));

assert.ok(migration.includes('private.single_720_snapshot'));
assert.ok(migration.includes("path !~ '^720p/'"));
assert.ok(migration.includes('SINGLE_720_PRECHECK_FAILED'));
assert.ok(migration.includes("receipt.path = '720p/index.m3u8'"));
assert.ok(migration.includes("p_path ~ '^(master\\.m3u8|cover\\.webp|720p/"));
assert.ok(migration.includes('private.registration_attempts'));
assert.ok(migration.includes('for update'));
assert.ok(migration.includes('reserve_invite_registration'));
assert.ok(migration.includes('finalize_invite_registration'));
assert.ok(migration.includes('membership_redemptions'));
assert.ok(migration.includes("auth.role() <> 'service_role'"));
assert.ok(migration.includes('gen_random_bytes(16)'));
assert.ok(html.includes('id="signinInviteCode"'));
assert.ok(html.includes('id="signinPasswordConfirm"'));
assert.ok(!html.includes('id="authGetCode"'));
assert.ok(session.includes("eastudy_playback='+encodeURIComponent(ticket)"));
assert.ok(session.includes("'eastudy_catalog=' + encodeURIComponent(ticket)"));
assert.ok(!session.includes("encodeURIComponent(token)+'; Path=/api"));
assert.ok(session.includes("Path=/api/processing/media/"));
assert.ok(mediaRoute.includes("openPlaybackTicket(cookieValue(request,'eastudy_playback')"));
assert.ok(!mediaRoute.includes('authenticate(request, env)'));
assert.ok(mediaRoute.includes("typeof waitUntil==='function'"));

assert.ok(html.includes('id="learningPlanEditor" hidden'));
assert.ok(html.includes('id="learningPlanProgress"'));
assert.ok(app.includes("$('#learningPlanAction')?.addEventListener('click',startGoalLearning)"));
assert.ok(!html.includes('id="learningTrackGrid"'));
assert.ok(!html.includes('id="todayPlanList"'));

console.log(JSON.stringify({ok:true,tests:28},null,2));
