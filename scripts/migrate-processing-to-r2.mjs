import process from 'node:process';
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const exportFile = String(process.env.SUPABASE_EXPORT_FILE || '');
const controlUrl = String(process.env.PROCESSING_CONTROL_URL || 'https://english-web-lce.pages.dev/api/processing/control');
const workerSecret = String(process.env.EASTUDY_WORKER_SECRET || '');
const migrationSecret = String(process.env.PROCESSING_MIGRATION_SECRET || '');
if (!workerSecret || !migrationSecret || (!exportFile && (!supabaseUrl || !serviceKey))) throw new Error('EASTUDY_WORKER_SECRET, PROCESSING_MIGRATION_SECRET and either SUPABASE_EXPORT_FILE or SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are required');
let rows;
if (exportFile) {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(exportFile, 'utf8');
  const start = text.indexOf('{');
  if (start < 0) throw new Error('SUPABASE_EXPORT_FILE_INVALID');
  const payload = JSON.parse(text.slice(start));
  rows = payload?.rows?.[0]?.jobs || [];
} else {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/admin_list_processing_jobs`, { method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_limit: 500 }) });
  if (!response.ok) throw new Error(`SUPABASE_EXPORT_${response.status}`);
  rows = await response.json();
}
const jobs = (Array.isArray(rows) ? rows : []).map(row => ({ id: row.id || row.job_id, video_id: row.video_id, source_key: row.source_key || null, input: row.input || { kind: 'cloud_r2' }, requested_by: row.requested_by || null, idempotency_key: row.idempotency_key || row.id, status: row.status, stage: row.stage, progress: row.progress, result: row.result || null, error: row.error || null, run_id: row.run_id || null, output_run_id: row.output_run_id || null, work: row.work || {}, attempt: row.attempt || 0, created_at: row.created_at, updated_at: row.updated_at, heartbeat_at: row.heartbeat_at || row.last_heartbeat_at || null }));
const importedResults = [];
for (let index = 0; index < jobs.length; index += 1) {
  const job = jobs[index];
  const body = JSON.stringify({ action: 'processing-bootstrap', jobs: [job] });
  if (Buffer.byteLength(body, 'utf8') > 12 * 1024 * 1024) throw new Error(`R2_IMPORT_JOB_TOO_LARGE:${job.id}`);
  const imported = await fetch(controlUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-secret': workerSecret, 'x-control-admin': migrationSecret }, body });
  if (!imported.ok) throw new Error(`R2_IMPORT_${imported.status}:${job.id}: ${await imported.text()}`);
  importedResults.push(await imported.json());
  console.log(JSON.stringify({ index: index + 1, total: jobs.length, jobId: job.id, imported: true }));
}
console.log(JSON.stringify({ exported: jobs.length, imported: importedResults.length }, null, 2));
