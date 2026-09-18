import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const script = fs.readFileSync('admin/assets/local-processing-client.js', 'utf8');
const file = {name: 'original.mp4', size: 100};
const source = {...file, sha256: 'a'.repeat(64), coverSha256: null};
const cancelled = {code: 'P0001', message: 'LOCAL_INPUT_CANCELLED'};
const keyFor = recovery => 'eastudy:local-intake:v1:admin:' + (recovery || 'new') + ':' + source.sha256;

function fixture({existing = true, recovery = null, reserve, intake} = {}) {
  const saved = new Map(), calls = [];
  const key = keyFor(recovery);
  if (existing) saved.set(key, JSON.stringify({requestId: 'old-request', source, video: {title: 'Old title'}, ready: true}));
  const reservation = {job: {id: 'new-job', video_id: '42'}, inputSource: {sourceId: 'new-source'}, intakeTicket: 'secret-ticket'};
  const reserveInput = async input => {
    calls.push(input);
    return reserve ? reserve(input, calls.length, reservation) : {data: reservation};
  };
  const window = {
    EastudyAuth: {client: () => ({auth: {getSession: async () => ({data: {session: {user: {id: 'admin'}}}})}})},
    EastudyCloudContent: {localProcessingCapability: async () => ({data: {enabled: true}}), recoverLocalProcessingInput: reserveInput},
    EastudyAdminCloudBridge: {reserveLocal: reserveInput},
  };
  class HashWorker {
    postMessage() { queueMicrotask(() => this.onmessage({data: {sha256: source.sha256}})); }
    terminate() {}
  }
  vm.runInNewContext(script, {
    window, document: {currentScript: {src: 'https://test/admin/assets/local-processing-client.js'}},
    URL, Worker: HashWorker, crypto: webcrypto, location: {origin: 'https://test'}, AbortController, setTimeout, clearTimeout,
    localStorage: {getItem: k => saved.get(k), setItem: (k, value) => saved.set(k, value)},
    fetch: async url => url.endsWith('/capability')
      ? {ok: true, json: async () => ({protocolVersion: 1, ready: true, workerId: 'worker', challenge: 'challenge'})}
      : intake ? intake(url) : {ok: true, json: async () => ({state: 'READY'})},
  });
  return {saved, calls, receipt: () => JSON.parse(saved.get(key)),
    submit: () => window.EastudyLocalProcessing.submit({file, video: {title: 'New title'}, recoveryJobId: recovery})};
}

for (const throws of [true, false]) {
  const f = fixture({reserve: async (_, n, reservation) => {
    if (n === 1) { if (throws) throw cancelled; return {error: cancelled}; }
    return {data: reservation};
  }});
  await f.submit();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].requestId, 'old-request');
  assert.notEqual(f.calls[1].requestId, 'old-request');
  assert.equal(f.calls[1].video.title, 'New title');
  assert.equal(f.receipt().requestId, f.calls[1].requestId);
  assert.equal(f.receipt().jobId, 'new-job');
  assert.ok(![...f.saved.values()].some(value => value.includes('secret-ticket')));
}

const active = fixture();
await active.submit();
await active.submit();
assert.ok(active.calls.every(input => input.requestId === 'old-request'), 'healthy receipt must not create duplicates');

for (const code of ['NETWORK_ERROR', 'VIDEO_IN_TRASH', 'CONTENT_REVISION_CONFLICT', 'LOCAL_RESERVATION_CONFLICT']) {
  const f = fixture({reserve: async () => { throw {code: 'P0001', message: code}; }});
  await assert.rejects(f.submit());
  assert.equal(f.calls.length, 1, code);
  assert.equal(f.receipt().requestId, 'old-request', code);
}

for (const options of [{existing: false}, {recovery: 'cancelled-job'}]) {
  const f = fixture({...options, reserve: async () => { throw cancelled; }});
  await assert.rejects(f.submit(), error => error.code === 'LOCAL_INPUT_CANCELLED' && /任务已取消/.test(error.message));
  assert.equal(f.calls.length, 1, 'fresh cancellation or explicit recovery cannot start another job');
}

const repeated = fixture({reserve: async () => ({error: cancelled})});
await assert.rejects(repeated.submit(), error => error.code === 'LOCAL_INPUT_CANCELLED');
assert.equal(repeated.calls.length, 2, 'replacement is bounded to one attempt');

const lostResponse = fixture({reserve: async (_, n, reservation) => {
  if (n === 1) throw cancelled;
  if (n === 2) throw new Error('response lost');
  return {data: reservation};
}});
await assert.rejects(lostResponse.submit(), /response lost/);
const newId = lostResponse.receipt().requestId;
await lostResponse.submit();
assert.equal(lostResponse.calls[2].requestId, newId, 'replacement receipt survives an uncertain response');

const renewal = fixture({
  reserve: async (_, n, reservation) => { if (n > 1) throw cancelled; return {data: reservation}; },
  intake: async () => ({ok: false, status: 401, json: async () => ({error: 'INTAKE_TICKET_INVALID'})}),
});
await assert.rejects(renewal.submit(), error => error.code === 'LOCAL_INPUT_CANCELLED');
assert.equal(renewal.calls.length, 2);
assert.ok(renewal.calls.every(input => input.requestId === 'old-request'), 'mid-transfer cancellation must not restart');
console.log('Cancelled intake: new upload, error translation, bounded replacement, recovery, renewal and duplicate protection passed.');
