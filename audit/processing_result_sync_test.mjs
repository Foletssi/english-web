import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const window = {};
vm.runInNewContext(fs.readFileSync('shared/processing-result.js', 'utf8'), { window });
const sync = window.EastudyProcessingResult;
assert.ok(sync && typeof sync.mergeIntoSnapshot === 'object' || typeof sync?.mergeIntoSnapshot === 'function');

const jobId = '42d334fd-b661-42ab-bfb0-f279565eba43';
const videoId = '178995670129595';
const sentences = Array.from({ length: 328 }, (_, index) => ({
  id: `${jobId}-${index + 1}`, order: index, startTime: index, endTime: index + 1,
  english: `Sentence ${index + 1}.`, chinese: `第${index + 1}句`, keyWords: [], expressions: [], reviewStatus: 'REVIEW'
}));
const snapshot = {
  schemaVersion: 3,
  creators: [{ id: 'creator-existing', name: 'Sydney Serena', status: 'ACTIVE' }],
  videos: [{ id: Number(videoId), title: '旧标题', titleZh: '旧标题', creatorId: 'creator-existing',
    pipelineStatus: 'WAITING', status: 'DRAFT', mediaUrl: '', difficulty: { schemaVersion: 1, primaryTrack: 'cet4', targetTracks: ['cet4'], reviewStatus: 'review' } }],
  sentences: { [videoId]: [] }, jobs: []
};
const job = {
  id: jobId, video_id: videoId, status: 'REVIEW', progress: 100, run_id: 'run-1', output_run_id: 'run-1',
  input: { title: 'Sydney Serena', creator: 'Sydney Serena' },
  result: { video: { id: videoId, titleZh: 'Sydney Serena - 3. 语调地道流畅', media_url: '/api/processing/media/' + jobId + '/540p/index.m3u8',
      creator: 'Sydney Serena', difficulty: { schemaVersion: 1, primaryTrack: 'cet4', targetTracks: ['cet4'], reviewStatus: 'review' } }, sentences }
};
assert.equal(sync.isUsable(job), true);
const merged = sync.mergeIntoSnapshot(snapshot, job);
assert.equal(merged.ok, true);
assert.equal(merged.snapshot.videos.length, 1);
assert.equal(merged.snapshot.sentences[videoId].length, 328);
assert.equal(merged.video.pipelineStatus, 'READY');
assert.equal(merged.video.status, 'REVIEW');
assert.equal(merged.video.processingJobId, jobId);
assert.equal(merged.video.runId, 'run-1');
assert.equal(merged.video.mediaUrl, job.result.video.media_url);
assert.equal(merged.video.difficulty.reviewStatus, 'approved');
assert.equal(merged.snapshot.jobs.length, 1);
assert.equal(merged.snapshot.jobs[0].resultSentenceCount, 328);

const mergedAgain = sync.mergeIntoSnapshot(merged.snapshot, job);
assert.equal(mergedAgain.snapshot.videos.length, 1);
assert.equal(mergedAgain.snapshot.creators.length, 1);
assert.equal(mergedAgain.snapshot.jobs.length, 1);
assert.equal(mergedAgain.snapshot.sentences[videoId].length, 328);
assert.equal(sync.isUsable({ ...job, result: { ...job.result, sentences: [] } }), false);
console.log('PASS R2 REVIEW result sync promotes stale content to READY and remains idempotent');
