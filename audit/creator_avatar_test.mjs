import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('assets/js/creator-avatars.js', 'utf8');
let requests = [], fail = true, sessionId = 'user1', timers = new Map(), serial = 0, revoked = [];
const img = { dataset: { avatarSrc: '/api/creator-avatars/creator/a.webp' }, hidden: true, isConnected: true, nextElementSibling: { hidden: false }, removeAttribute() { this.src = ''; } };
const document = { querySelectorAll: () => [img] };
const window = { addEventListener() {}, EastudyAuth: { client: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: sessionId }, access_token: sessionId + '-token' } } }) } }) } };
class TestURL extends URL { static createObjectURL() { return 'blob:' + sessionId; } static revokeObjectURL(url) { revoked.push(url); } }
vm.runInNewContext(source, { window, document, location: { href: 'https://example.test/', origin: 'https://example.test' }, URL: TestURL, AbortController,
  setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
  fetch: async (url, options) => { requests.push({ url, options }); if (fail) throw Error('offline'); return new Response('image', { headers: { 'content-type': 'image/webp' } }); }
});
const settle = () => new Promise(resolve => setImmediate(resolve));
window.EastudyAvatars.hydrate(); await settle();
assert.equal(img.hidden, true);
assert.ok([...timers.values()].some(timer => timer.ms < 15000), 'failed avatar must schedule bounded retry');
fail = false;
for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); }
await settle();
assert.equal(img.src, 'blob:user1'); img.onload(); assert.equal(img.hidden, false);
assert.equal(requests.length, 2);
assert.ok(requests.every(r => !r.url.includes('token') && r.options.headers.Authorization === 'Bearer user1-token'));
window.EastudyAvatars.clear();
assert.equal(img.hidden, true); assert.ok(revoked.includes('blob:user1'));
sessionId = 'user2'; window.EastudyAvatars.hydrate(); await settle();
assert.equal(img.src, 'blob:user2');
window.EastudyAvatars.clear(); fail = true;
window.EastudyAvatars.hydrate(); await settle();
for (let round = 0; round < 5; round++) { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } await settle(); }
assert.equal(timers.size, 0, 'offline retry must stop, not loop forever');
assert.equal(requests.length, 6);
window.EastudyAvatars.clear();
console.log('Creator avatars: transient failure recovery, bounded retries, private headers and account isolation passed.');
