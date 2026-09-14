import assert from 'node:assert/strict';
import { onRequestGet, onRequestHead } from '../functions/api/processing/source.js';

const job = '00000000-0000-4000-8000-000000000001';
const token = 'x'.repeat(64);
let reads = 0;
const object = { size: 10, etag: 'fixed', httpEtag: '"fixed"', body: new Uint8Array(10), writeHttpMetadata(h) { h.set('Content-Type', 'video/mp4'); } };
const env = { VIDEO_BUCKET: { head: async () => { reads++; return object; }, get: async () => object } };
const request = (extra = '', headers = {}) => new Request(`https://site.test/api/processing/source?job=${job}&token=${token}${extra}`, { headers });
globalThis.fetch = async () => { throw new Error('upstream offline'); };
assert.equal((await onRequestGet({ request: request(), env })).status, 503, 'transport failures must be bounded retryable responses');
assert.equal(reads, 0, 'failed authorization cannot read storage');
globalThis.fetch = async (_url, options) => {
  assert.ok(options.signal, 'authorization requires a deadline');
  return new Response('{invalid');
};
assert.equal((await onRequestGet({ request: request(), env })).status, 503, 'malformed upstream JSON is handled');
globalThis.fetch = async url => {
  assert.match(String(url), /resolve_processing_reencode_cover$/);
  return Response.json([{ source_key: 'server-derived/cover.webp' }]);
};
const head = await onRequestHead({ request: request('&asset=cover'), env });
assert.equal(head.status, 200);
assert.equal(head.headers.get('cache-control'), 'private, no-store');
assert.equal(await head.text(), '');
globalThis.fetch = async () => Response.json([{ source_key: 'server-derived/source.mp4' }]);
assert.equal((await onRequestGet({ request: request('', { Range: 'bytes=2-4' }), env })).status, 206);
assert.equal((await onRequestGet({ request: request('', { Range: 'bytes=99-' }), env })).status, 416);
assert.equal((await onRequestGet({ request: request('&asset=other'), env })).status, 400);
globalThis.fetch = async () => Response.json([]);
const before = reads;
assert.equal((await onRequestGet({ request: request(), env })).status, 404);
assert.equal(reads, before);
console.log('Processing source: offline, malformed auth, timeout signal, cover HEAD, range and denied storage tests passed.');
