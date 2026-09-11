import fs from 'node:fs';
import assert from 'node:assert/strict';

const migration=fs.readFileSync('supabase/migrations/20260911153000_invite_admin_management_v1.sql','utf8');
const hotfix=fs.readFileSync('supabase/migrations/20260911154000_production_function_type_fixes.sql','utf8');
const learningFix=fs.readFileSync('supabase/migrations/20260911154500_learning_sync_numeric_fix.sql','utf8');
const rateLimit=fs.readFileSync('supabase/migrations/20260911155000_invite_generation_rate_limit.sql','utf8');
const copyable=fs.readFileSync('supabase/migrations/20260911163000_copyable_invite_codes.sql','utf8');
const admin=fs.readFileSync('admin/assets/admin.js','utf8');
const client=fs.readFileSync('shared/supabase-client.js','utf8');
const html=fs.readFileSync('admin/index.html','utf8');
const student=fs.readFileSync('assets/js/app.js','utf8');

for(const token of [
  'activation_code_audit','code_hint','revoked_at','disabled_at',
  'admin_generate_activation_codes_v2','admin_list_activation_codes_v1',
  'admin_revoke_activation_code_v1','admin_set_activation_batch_disabled_v1',
  'admin_reissue_activation_code_v1','CODE_RESERVED','CODE_ALREADY_USED'
]) assert.ok(migration.includes(token),`migration missing ${token}`);

assert.ok(migration.includes("p_status not in ('all', 'available', 'reserved', 'used', 'expired', 'revoked')"));
assert.ok(migration.includes("code.revoked_at is not null or batch.disabled_at is not null"));
assert.ok(migration.includes("v_code.revoked_at is not null"));
assert.ok(migration.includes("v_code.code_hash <> extensions.digest"));
assert.ok(!migration.includes('code_plain'));
assert.ok(!migration.includes('raw_code'));
assert.ok(hotfix.includes('on conflict on constraint membership_entitlements_pkey'));
assert.ok(hotfix.includes('p_duration::numeric'));
assert.ok(learningFix.includes('p_duration_seconds::numeric'));
assert.ok(rateLimit.includes('pg_advisory_xact_lock'));
assert.ok(rateLimit.includes('v_day_codes + new.code_count > 500'));
assert.ok(copyable.includes('code_value text'));
assert.ok(copyable.includes('admin_generate_activation_codes_v3'));
assert.ok(copyable.includes('admin_list_activation_codes_v2'));
assert.ok(copyable.includes('admin_reissue_activation_code_v2'));

for(const token of [
  'listInviteCodes','revokeInviteCode','setInviteBatchDisabled','reissueInviteCode'
]) assert.ok(client.includes(token),`client missing ${token}`);
for(const token of [
  'renderInvites','inviteStatsMarkup','inviteBatchMarkup','inviteAuditMarkup',
  'downloadInviteCodes','data-invite-copy','点击“复制”即可使用','换新并复制'
]) assert.ok(admin.includes(token),`admin UI missing ${token}`);
assert.ok(!admin.includes('列表只显示安全尾号'));
assert.ok(!admin.includes('明文只显示这一次'));

assert.ok(html.includes('href="#/invites"'));
assert.ok(student.includes("raw.includes('ATTEMPT_MISMATCH')"));
assert.ok(student.includes("$('#signinInviteCode')?.addEventListener('input'"));

console.log(JSON.stringify({ok:true,tests:31},null,2));
