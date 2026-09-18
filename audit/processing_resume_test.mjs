import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let response;
const window = { EastudyAuth: { client: () => ({ rpc: async () => ({ data: response }) }) } };
vm.runInNewContext(readFileSync('shared/cloud-content.js', 'utf8'), { window });
vm.runInNewContext(readFileSync('admin/assets/processing-control.js', 'utf8'), { window, document: { addEventListener() {} } });
const pending = { verified: false, phase: 'validating', progress: 97 };
response = { id: 'job', video_id: '1', status: 'QUEUED', stage: 'LOCAL_UPLOAD', progress: 97,
  work: { message: 'checkpoint validation pending', resumePosition: pending } };
let job = await window.EastudyCloudContent.getProcessingJob('job');
assert.equal(job.message, response.work.message);
assert.deepEqual(job.resumePosition, pending);
assert.ok(job.steps.every(([, state]) => state !== 'SUCCESS'));
assert.ok(window.EastudyProcessingControl.steps(job).every(step => step.state !== 'SUCCESS'));
response.status = 'RUNNING';
response.work.telemetry = { resumePosition: { ...pending, phase: 'stages' },
  stepHistory: { media: { state: 'DONE' }, asr: { completedAt: '2026-09-19T01:00:00Z' } } };
job = await window.EastudyCloudContent.getProcessingJob('job');
assert.equal(job.steps.find(([name]) => name === 'transcode')[1], 'SUCCESS');
assert.notEqual(job.steps.find(([name]) => name === 'asr')[1], 'SUCCESS');
let steps = window.EastudyProcessingControl.steps(job);
assert.equal(steps.find(step => step.name === 'transcode').state, 'SUCCESS');
assert.notEqual(steps.find(step => step.name === 'asr').state, 'SUCCESS');
response.work.telemetry.resumePosition = { ...pending, verified: true, phase: 'final' };
job = await window.EastudyCloudContent.getProcessingJob('job');
assert.equal(job.resumePosition.verified, true);
steps = window.EastudyProcessingControl.steps(job);
assert.equal(steps.find(step => step.name === 'voice').state, 'SUCCESS');
assert.equal(steps.find(step => step.name === 'enrich').state, 'SUCCESS');
assert.equal(steps.find(step => step.name === 'output').state, 'RUNNING');

const source = readFileSync('admin/assets/admin.js', 'utf8');
const sandbox = { CloudState: { service: { ready: true } }, Store: { localOnly: false, getVideo: () => ({}) }, Date };
vm.createContext(sandbox);
for (const name of ['jobVideoState', 'deriveActivity', 'stageText']) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  vm.runInContext(source.slice(start, source.indexOf('\n', start)), sandbox);
}
job.lastHeartbeatAt = job.lastProgressAt = new Date().toISOString();
assert.equal(sandbox.deriveActivity(job).code, 'RESUME_FINAL');
job.resumePosition = pending;
assert.equal(sandbox.deriveActivity(job).code, 'RESUME_VALIDATING');
assert.match(sandbox.stageText(job), /97/);
assert.equal(sandbox.deriveActivity({ ...job, rawStatus: 'ERROR' }).code, 'ERROR');
assert.equal(sandbox.deriveActivity({ ...job, lastHeartbeatAt: null }).code, 'CONTACT_LOST');
sandbox.CloudState.jobsSyncError = true;
assert.equal(sandbox.deriveActivity(job).code, 'SYNC_UNKNOWN');
sandbox.CloudState.jobsSyncError = false;
sandbox.CloudState.service.ready = false;
assert.equal(sandbox.deriveActivity({ ...job, rawStatus: 'QUEUED' }).code, 'NODE_OFFLINE');
console.log('Resume progress, verified milestones and warning precedence contracts passed.');
