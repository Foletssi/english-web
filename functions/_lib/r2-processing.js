const CONTROL_ROOT = '__eastudy/control/v1';
const JOBS_ROOT = `${CONTROL_ROOT}/jobs`;
const INDEX_KEY = `${CONTROL_ROOT}/index.json`;

const UUID = /^[0-9a-f-]{36}$/i;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,220}$/;
function now() { return new Date().toISOString(); }
export function controlJobKey(jobId) { return `${JOBS_ROOT}/${jobId}.json`; }
export function controlAssetKey(jobId, runId, path) {
  if (!UUID.test(jobId) || !UUID.test(runId) || !SAFE_PATH.test(path) || path.includes('..')) throw new Error('OUTPUT_PATH_INVALID');
  return `jobs/${jobId}/runs/${runId}/${path}`;
}
async function readObject(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return { value: null, etag: null };
  const text = await object.text();
  try { return { value: JSON.parse(text), etag: object.etag || null }; }
  catch { throw new Error('CONTROL_OBJECT_INVALID'); }
}
async function writeObject(bucket, key, value, etag = null) {
  const options = { httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' } };
  if (etag) options.onlyIf = { etagMatches: etag };
  const written = await bucket.put(key, JSON.stringify(value), options);
  if (etag && !written) throw new Error('CONTROL_CONFLICT');
  return written;
}
async function mutateObject(bucket, key, mutate, fallback) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await readObject(bucket, key);
    const next = await mutate(current.value == null ? fallback() : current.value);
    try { await writeObject(bucket, key, next, current.etag); return next; }
    catch (error) { if (error.message !== 'CONTROL_CONFLICT' || attempt === 5) throw error; }
  }
  throw new Error('CONTROL_CONFLICT');
}
function emptyIndex() { return { version: 1, updatedAt: now(), jobs: [] }; }
export async function readIndex(bucket) { const { value } = await readObject(bucket, INDEX_KEY); return value && Array.isArray(value.jobs) ? value : emptyIndex(); }
export async function readJob(bucket, jobId) { if (!UUID.test(jobId)) throw new Error('JOB_ID_INVALID'); return (await readObject(bucket, controlJobKey(jobId))).value; }
async function saveJob(bucket, job, expectedEtag = null) { if (!job || !UUID.test(job.id)) throw new Error('JOB_ID_INVALID'); return writeObject(bucket, controlJobKey(job.id), job, expectedEtag); }
async function upsertIndex(bucket, job) {
  await mutateObject(bucket, INDEX_KEY, index => {
    const jobs = Array.isArray(index.jobs) ? index.jobs.slice() : [];
    const summary = { id: job.id, video_id: job.video_id || job.videoId || null, status: job.status, stage: job.stage, progress: Number(job.progress || 0), run_id: job.run_id || null, updated_at: job.updated_at || now() };
    const position = jobs.findIndex(item => item.id === job.id);
    if (position >= 0) jobs[position] = summary; else jobs.push(summary);
    jobs.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return { version: 1, updatedAt: now(), jobs };
  }, emptyIndex);
}
export async function replaceJob(bucket, job) { const current = await readObject(bucket, controlJobKey(job.id)); if (!current.value) throw new Error('JOB_NOT_FOUND'); const next = { ...job, updated_at: now() }; await saveJob(bucket, next, current.etag); await upsertIndex(bucket, next); return next; }

export async function createOrImportJob(bucket, input) {
  const id = String(input.id || crypto.randomUUID());
  if (!UUID.test(id)) throw new Error('JOB_ID_INVALID');
  const existing = await readJob(bucket, id); if (existing) { await upsertIndex(bucket, existing); return existing; }
  const job = {
    id, video_id: input.video_id || input.videoId || null, source_key: input.source_key || input.sourceKey || null,
    input: input.input && typeof input.input === 'object' ? input.input : { kind: 'cloud_r2' }, requested_by: input.requested_by || input.requestedBy || null,
    idempotency_key: input.idempotency_key || input.idempotencyKey || id, status: input.status || 'QUEUED', stage: input.stage || 'LOCAL_UPLOAD',
    progress: Number.isFinite(Number(input.progress)) ? Number(input.progress) : 0, result: input.result || null, error: input.error || null,
    run_id: input.run_id || input.runId || null, output_run_id: input.output_run_id || input.outputRunId || null,
    work: input.work && typeof input.work === 'object' ? input.work : {}, receipt_count: Number(input.receipt_count || 0), attempt: Number(input.attempt || 0),
    created_at: input.created_at || now(), updated_at: now(), heartbeat_at: input.heartbeat_at || null, lease_until: null, lease_token_hash: null, worker_id: null
  };
  await saveJob(bucket, job); await upsertIndex(bucket, job); return job;
}
function tokenDigest(value) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then(bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')); }
function randomToken() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function leaseExpired(job) { return !job.lease_until || Date.parse(job.lease_until) <= Date.now(); }
export async function claimJob(bucket, { workerId, capabilities = {}, localOnly = false }) {
  const index = await readIndex(bucket);
  const candidates = index.jobs.filter(item => ['QUEUED', 'WAITING'].includes(item.status) || (item.status === 'RUNNING' && leaseExpired(item)));
  for (const candidate of candidates) {
    const job = await readJob(bucket, candidate.id);
    if (!job || (!['QUEUED', 'WAITING'].includes(job.status) && !(job.status === 'RUNNING' && leaseExpired(job)))) continue;
    if (localOnly && job.input?.kind !== 'local' && job.input?.kind !== 'LOCAL_UPLOAD') continue;
    if (!localOnly && job.input?.kind === 'local' && job.input?.localOnly === true) continue;
    const runId = job.run_id || crypto.randomUUID(); const token = randomToken();
    const claimed = { ...job, status: 'RUNNING', stage: job.stage || 'LOCAL_UPLOAD', run_id: runId, output_run_id: job.output_run_id || runId, worker_id: workerId, capabilities, lease_token_hash: await tokenDigest(token), lease_until: new Date(Date.now() + 600000).toISOString(), heartbeat_at: now(), updated_at: now(), attempt: Number(job.attempt || 0) + 1 };
    const current = await readObject(bucket, controlJobKey(job.id));
    try { await saveJob(bucket, claimed, current.etag); await upsertIndex(bucket, claimed); return { job: claimed, token }; }
    catch (error) { if (error.message === 'CONTROL_CONFLICT') continue; throw error; }
  }
  return { job: null, token: null };
}
export async function authorizeJob(bucket, { jobId, runId, token, workerId }) {
  const job = await readJob(bucket, jobId); if (!job) throw new Error('JOB_NOT_FOUND');
  if (runId && job.run_id !== runId) throw new Error('RUN_ID_MISMATCH');
  if (workerId && job.worker_id && job.worker_id !== workerId) throw new Error('WORKER_MISMATCH');
  if (!job.lease_until || Date.parse(job.lease_until) <= Date.now()) throw new Error('JOB_LEASE_LOST_OR_CANCELLED');
  if (!token || await tokenDigest(token) !== job.lease_token_hash) throw new Error('JOB_TOKEN_INVALID');
  return job;
}
export async function updateJob(bucket, jobId, runId, token, workerId, patch) {
  const job = await authorizeJob(bucket, { jobId, runId, token, workerId });
  const current = await readObject(bucket, controlJobKey(jobId)); const next = { ...job, ...patch, updated_at: now() };
  await saveJob(bucket, next, current.etag); await upsertIndex(bucket, next); return next;
}
export async function resolveOutput(bucket, args) { const job = await authorizeJob(bucket, args); return { job, objectKey: controlAssetKey(job.id, job.run_id, args.path) }; }
export async function resolveSource(bucket, args) { const job = await authorizeJob(bucket, args); if (!job.source_key) throw new Error('SOURCE_NOT_FOUND'); return { job, objectKey: job.source_key }; }
export async function recordReceipts(bucket, { jobId, runId, token, workerId, receipts }) {
  const job = await authorizeJob(bucket, { jobId, runId, token, workerId }); const current = await readObject(bucket, controlJobKey(jobId));
  const merged = new Map((Array.isArray(job.receipts) ? job.receipts : []).map(item => [item.path, item]));
  for (const receipt of Array.isArray(receipts) ? receipts : []) merged.set(receipt.path, { ...receipt, recordedAt: now() });
  const next = { ...job, receipts: [...merged.values()], receipt_count: merged.size, updated_at: now() };
  await saveJob(bucket, next, current.etag); await upsertIndex(bucket, next); return { ok: true, count: merged.size };
}
export async function health(bucket) { const index = await readIndex(bucket); return { ready: true, controlPlane: 'r2', version: 1, jobCount: index.jobs.length }; }
export async function listJobs(bucket, limit = 100) { const index = await readIndex(bucket); return Promise.all(index.jobs.slice(0, Math.min(Math.max(Number(limit) || 1, 1), 500)).map(item => readJob(bucket, item.id))); }

