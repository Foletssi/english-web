import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const values = new Map();
const localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key)
};
const sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const calls = [];
let failOnce = true;
const profileQuery = {
  select() { return this; },
  eq() { return this; },
  async maybeSingle() { return { data: { role: 'learner' }, error: null }; }
};
const api = {
  auth: { async getSession() { return { data: { session: { user: { id: 'learner-1' } } }, error: null }; } },
  from(table) { assert.equal(table, 'profiles'); return profileQuery; },
  async rpc(name, payload) {
    assert.equal(name, 'apply_study_event_v2');
    calls.push(structuredClone(payload));
    if (failOnce) { failOnce = false; return { data: null, error: new Error('offline') }; }
    return { data: { accepted: true }, error: null };
  }
};
const window = {
  localStorage,
  sessionStorage,
  addEventListener() {},
  EASTUDY_SUPABASE_CONFIG: { url: 'https://fixture.supabase.co', publishableKey: 'fixture' },
  supabase: { createClient: () => api }
};
const document = { hidden: false, addEventListener() {} };
const context = vm.createContext({ window, document, localStorage, sessionStorage, console, crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' }, structuredClone });
const source = fs.readFileSync(new URL('../shared/supabase-client.js', import.meta.url), 'utf8');
vm.runInContext(source, context);

const first = await window.EastudyData.recordStudyActivity({ videoId: 9, mediaVersion: 'run-7', position: 12, duration: 60, watchRanges: [[10, 12]], activeSeconds: 2 });
assert.equal(first.error.message, 'offline');
assert.equal(window.EastudyData.pendingStudyEvents(), 1, 'failed learning events must remain queued');
await window.EastudyData.flushStudyOutbox();
assert.equal(window.EastudyData.pendingStudyEvents(), 0, 'successful retry must remove the queued event');
assert.equal(calls.length, 2);
assert.equal(calls[0].p_session_id, calls[1].p_session_id, 'retry must preserve the original session id');
assert.equal(calls[0].p_sequence_no, calls[1].p_sequence_no, 'retry must preserve the original sequence number');
assert.equal(calls[1].p_media_version, 'run-7');
for (const table of ['user_progress', 'saved_sentences', 'user_vocabulary', 'daily_learning_stats', 'user_creator_follows', 'user_collection_saves']) {
  assert.match(source, new RegExp(`from\\('${table}'\\)\\.select\\([^\\n]+\\)\\.eq\\('user_id', requestUserId\\)`), `${table} hydration must explicitly scope the current learner`);
}
console.log('Study outbox contract: 13/13 checks passed.');
