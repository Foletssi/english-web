import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = file => fs.readFileSync(new URL('../admin/assets/' + file, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const requests = [], stored = new Map();
let click, rejectRequest, resolveRequest, refreshed = 0;
const window = {
  EastudyCloudContent: {controlProcessingJob(args) {
    requests.push(args);
    return new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
  }},
  EastudyStudioV2: {async refreshJobs() { refreshed++; }},
  dispatchEvent() {},
};
const context = vm.createContext({window, document: {addEventListener(type, fn) { click = fn; }},
  sessionStorage: {getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value)},
  crypto: {randomUUID: () => 'test-request-' + requests.length}, CustomEvent: class {},
});
vm.runInContext(source('processing-control.js'), context);
const button = {dataset: {jobId: 'job', runId: 'run', updatedAt: '2026-09-17', processingCommand: 'cancel'}};
const event = {target: {closest: () => button}};
click(event); click(event);
assert.equal(requests.length, 1, 'Double click must issue one command');
assert.equal(button.disabled, true);
rejectRequest(new Error('response lost')); await tick();
assert.equal(refreshed, 1);
assert.equal(button.disabled, false);
click(event);
assert.equal(requests[0].requestId, requests[1].requestId, 'Uncertain response must reuse receipt identity');
resolveRequest({ok: true}); await tick();
assert.equal(refreshed, 2);
button.dataset.runId = 'new-run';
click(event);
assert.notEqual(requests[2].requestId, requests[0].requestId, 'New lease needs a distinct command');
resolveRequest({ok: true}); await tick();
assert.equal(window.EastudyProcessingControl.actions({id: 'job', status: 'RUNNING'}, 'TRASHED'), '');
const missingInput = {id: 'missing-job', videoId: '42', status: 'WAITING', error: {code: 'LOCAL_SOURCE_MISSING'}};
window.EastudyStudioV2.isRetrying = id => id === 'missing-job';
window.EastudyStudioV2.recoveryMessage = () => '正在传入原视频 20%';
const recoveryButton = window.EastudyProcessingControl.actions(missingInput, 'ACTIVE');
assert.match(recoveryButton, /data-recover-local-input="missing-job"/);
assert.match(recoveryButton, /data-video-id="42" disabled/);
assert.match(recoveryButton, /正在传入原视频 20%/);
assert.match(recoveryButton, /data-processing-command="cancel"/, 'Receiving input remains independently cancellable');
const cancelledButton = window.EastudyProcessingControl.actions({...missingInput, status: 'CANCELLED'}, 'ACTIVE');
assert.doesNotMatch(cancelledButton, /data-recover-local-input/);
assert.match(cancelledButton, /data-processing-command="retry_failed_stage"/);

let calls = [], scenario = 'offline';
const local = {window: {}, AbortSignal, URLSearchParams, async fetch(url, options) {
  calls.push({url, options});
  if (scenario === 'offline') throw new Error('offline');
  if (url.endsWith('/capability')) return {ok: true, async json() { return {token: 'local-token'}; }};
  return {ok: scenario === 'saved'};
}};
vm.runInNewContext(source('local-source.js'), local);
const file = {size: 12}, receipt = {key: 'source/a b.mp4', etag: 'receipt-etag'};
assert.equal(await local.window.EastudyLocalSource.preserve(file, receipt), false);
assert.equal(calls.length, 1);
scenario = 'rejected'; calls = [];
assert.equal(await local.window.EastudyLocalSource.preserve(file, receipt), false);
scenario = 'saved'; calls = [];
assert.equal(await local.window.EastudyLocalSource.preserve(file, receipt), true);
assert.equal(calls[1].options.body, file);
assert.equal(calls[1].options.headers['X-Eastudy-Intake'], 'local-token');
const query = new URL(calls[1].url).searchParams;
assert.equal(query.get('key'), receipt.key);
assert.equal(query.get('etag'), receipt.etag);
assert.equal(query.get('size'), '12');
console.log('Processing control idempotency and optional local-source fallback passed.');
