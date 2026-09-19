import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';

let handler, reply;
const source = stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/video-processing/index.ts', import.meta.url), 'utf8'));
vm.runInNewContext(source, {
  Request, Response, Error, crypto,
  Deno: { env: { get: name => ({ WORKER_SECRET: 'fixture-secret', SUPABASE_SERVICE_ROLE_KEY: 'fixture-key', SUPABASE_URL: 'https://fixture' })[name] }, serve: fn => { handler = fn; } },
  fetch: async () => new Response(JSON.stringify(reply), { status: 500 })
});
for (const [code, expected] of Object.entries({
  '57014': 'SUPABASE_503:DB_STATEMENT_TIMEOUT',
  '55P03': 'SUPABASE_503:DB_LOCK_TIMEOUT',
  '40001': 'SUPABASE_503:DB_SERIALIZATION_RETRY',
  '40P01': 'SUPABASE_503:DB_DEADLOCK_RETRY',
  'P0001': 'SUPABASE_500:TEACHING_DETAILS_INVALID'
})) {
  reply = { code, message: 'TEACHING_DETAILS_INVALID' };
  const response = await handler(new Request('https://fixture', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-secret': 'fixture-secret' },
    body: JSON.stringify({ action: 'worker-complete-v2', workerId: 'fixture-worker', jobId: '00000000-0000-4000-8000-000000000001', runId: '00000000-0000-4000-8000-000000000002', token: 'x'.repeat(64), result: {}, manifest: [] })
  }));
  assert.equal((await response.json()).error, expected);
}
console.log('PASS Edge SQLSTATE retry classification and business-error preservation');
