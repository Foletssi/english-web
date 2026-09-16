import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function load(file) {
  const filename = fileURLToPath(file);
  const window = { setTimeout, clearTimeout };
  window.window = window;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { window }, { filename });
  return window;
}

const win = load(new URL('../shared/learning-queue.js', import.meta.url));
const queue = win.EastudyLearningQueue;
const videos = [
  { id: 1, status: 'PUBLISHED', mediaUrl: '/1.mp4', goalMappings: [{ goalId: 'daily', status: 'APPROVED' }], collectionIds: [10], publishedAt: '2026-01-03' },
  { id: 2, status: 'PUBLISHED', mediaUrl: '/2.mp4', goalMappings: [{ goalId: 'cet4', approved: true }], collectionIds: [10, 20], publishedAt: '2026-01-02' },
  { id: 3, status: 'DRAFT', mediaUrl: '/3.mp4', goalIds: ['cet4'] },
  { id: 4, status: 'PUBLISHED', mediaUrl: '', goalIds: ['cet4'] }
];

function equal(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

equal(queue.eligibleVideos(videos, 'cet4').map(v => v.id), [2], 'exam pool only includes reviewed playable mappings');
equal(queue.eligibleVideos(videos, 'general').map(v => v.id), [1, 2], 'general pool includes all playable published content');
const one = queue.create({ videos, goalId: 'cet4', loop: true });
const all = queue.create({ videos, goalId: 'cet4', source: 'direct', preferredVideoId: 1, loop: false });
equal(all.ids, ['1', '2'], 'ordinary viewing includes all published playable videos across goals');
equal(all.goalId, 'general', 'ordinary viewing reports the all-video scope');
equal(queue.next(all, 1).id, '2', 'ordinary viewing advances to the other goal video');
equal(queue.next(all, 2).finished, true, 'all-video queue stops when repeat is disabled');
equal(queue.next({ ...all, loop: true }, 2).id, '1', 'all-video queue repeats only when enabled');
equal(queue.next(one, 2).id, '2', 'single-item loop repeats explicitly');
const noLoop = queue.create({ videos, goalId: 'cet4', loop: false });
equal(queue.next(noLoop, 2).finished, true, 'single-item no-loop finishes');
const preferred = queue.create({ videos, goalId: 'daily', preferredVideoId: 2 });
equal(preferred.ids, ['1'], 'preferred video cannot bypass the selected goal');
equal(queue.next(preferred, 1).finished, true, 'eligible single entry stops without explicit loop');
equal(queue.next({ ...preferred, loop: true }, 1).id, '1', 'eligible single entry loops explicitly');
equal(queue.create({ videos, goalId: 'toefl' }).ids, [], 'unmapped goal stays empty');
equal(queue.create({ videos, goalId: 'toefl', collectionId: 10 }).ids, ['1', '2'], 'explicit collection uses only its published playable items');
equal(queue.eligibleVideos([{ id: 5, status: 'PUBLISHED', mediaUrl: '/5.mp4', goalIds: ['toefl'], goalMappings: [{ goalId: 'toefl', approved: false, status: 'REVIEW' }] }], 'toefl').length, 0, 'legacy goalIds cannot bypass review');
equal(queue.create({ videos, goalId: 'daily', collectionId: 20, preferredVideoId: 1 }).ids, ['2'], 'preferred video cannot bypass collection membership');
equal(queue.create({ videos, goalId: 'cet4', source: 'direct', preferredVideoId: 2 }).cursor, 1, 'preferred video selects cursor without reordering queue');
equal(queue.previous(queue.create({ videos, goalId: 'cet4', source: 'direct' }), 2).id, '1', 'previous returns prior video');

let visited = queue.commit({ ...all, loop: true }, '2');
const preview = queue.next(visited, '2');
equal(visited.history, ['2'], 'preview does not mutate successful visits');
visited = queue.commit(preview.queue, '1');
equal(queue.previous(visited, '1').id, '2', 'wrapped playback returns to actual last video');
visited = queue.commit(queue.previous(visited, '1').queue, '2');
equal(visited.history, ['2'], 'back consumes history without adding a forward visit');
equal(queue.commit(visited, 'missing').history, ['2'], 'invalid destination cannot enter history');
equal(queue.create({ videos, source: 'direct' }).history, [], 'new queue has independent history');
for(let i=0;i<150;i++) visited=queue.commit(visited, i%2?'1':'2');
equal(visited.history.length,100,'successful history is bounded');
equal(queue.previous({...visited,ids:['1']},'1').id,null,'removed videos are excluded from history');

const playbackWindow = load(new URL('../shared/playback-controller.js', import.meta.url));
let done = 0;
const controller = playbackWindow.EastudyPlayback.createCountdown({ seconds: 1, onDone: () => { done += 1; } });
controller.start({ id: 1 });
controller.cancel('route-change');
await new Promise(resolve => setTimeout(resolve, 1100));
equal(done, 0, 'cancel prevents late navigation');

console.log('Learning queue contract: all checks passed.');
