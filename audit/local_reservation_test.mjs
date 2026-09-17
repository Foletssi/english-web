import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const window = {};
vm.runInNewContext(fs.readFileSync(new URL('../admin/assets/local-reservation.js', import.meta.url), 'utf8'), {window});
const {mergeEdits, reserve} = window.EastudyLocalReservation;
const plain = value => JSON.parse(JSON.stringify(value));
const before = {videos: [{id: 1, title: 'before', status: 'DRAFT'}, {id: 2, title: 'deleted'}]};
const current = {videos: [{id: 1, title: 'edited', status: 'DRAFT'}, {id: 2, title: 'edited after delete'}]};
const remote = {videos: [{id: 1, title: 'before', status: 'WAITING'}, {id: 3, title: 'remote new'}]};
assert.deepEqual(plain(mergeEdits(before, current, remote)), {
  videos: [{id: 1, title: 'edited', status: 'WAITING'}, {id: 3, title: 'remote new'}],
}, 'Local edits must preserve server state and never resurrect remotely removed videos');

let snapshot = before, imported, scheduled = 0;
const response = {data: {snapshot: remote, revision: 2, job: {id: 'job'}, intakeTicket: 'ticket', inputSource: {sourceId: 'source'}}};
const context = {
  snapshot: () => snapshot, revision: () => 1,
  cloud: {async reserveLocalProcessingJob(input, revision) {
    assert.equal(input.requestId, 'same-request');
    assert.equal(revision, 1);
    snapshot = current;
    return response;
  }},
  importMutation: value => { imported = value; }, saveLater: () => { scheduled++; },
};
assert.equal(await reserve({requestId: 'same-request'}, context), response);
assert.equal(imported.data.revision, 2);
assert.equal(imported.data.snapshot.videos[0].title, 'edited');
assert.equal(scheduled, 1);
let revision = 1, calls = 0, pulls = 0;
snapshot = before; scheduled = 0;
context.revision = () => revision;
context.importMutation = value => { snapshot = value.data.snapshot; revision = value.data.revision; };
context.cloud = {
  async reserveLocalProcessingJob(input, expectedRevision) {
    assert.equal(input.requestId, 'same-request');
    calls++;
    if (calls === 1) {
      snapshot = current;
      return {error: Object.assign(new Error('CONTENT_REVISION_CONFLICT'), {code: 'P0001'})};
    }
    assert.equal(expectedRevision, 2);
    return {data: {...response.data, revision: 3}};
  },
  async pullAdmin() { pulls++; return {snapshot: remote, revision: 2}; },
};
await reserve({requestId: 'same-request'}, context);
assert.equal(calls, 2); assert.equal(pulls, 1); assert.equal(revision, 3);
assert.equal(snapshot.videos[0].title, 'edited');
assert.equal(scheduled, 1);

calls = 0;
context.cloud.reserveLocalProcessingJob = async () => { calls++; return {error: new Error('CONTENT_REVISION_CONFLICT')}; };
context.cloud.pullAdmin = async () => ({snapshot: remote, revision: revision + 1});
await assert.rejects(reserve({requestId: 'same-request'}, context), /CONTENT_REVISION_CONFLICT/);
assert.equal(calls, 3, 'Conflicts must not cause an unlimited retry loop');
console.log('Local reservation preserves concurrent edits, server deletions, and bounded same-request recovery.');
