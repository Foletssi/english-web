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
  { id: 1, status: 'PUBLISHED', mediaUrl: '/1.mp4', goalIds: ['daily'], collectionIds: [10], publishedAt: '2026-01-03' },
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
equal(queue.next(one, 2).id, '2', 'single-item loop repeats explicitly');
const noLoop = queue.create({ videos, goalId: 'cet4', loop: false });
equal(queue.next(noLoop, 2).finished, true, 'single-item no-loop finishes');
const preferred = queue.create({ videos, goalId: 'daily', preferredVideoId: 2 });
equal(preferred.ids, ['2', '1'], 'direct video stays first before returning to goal pool');
equal(queue.next(preferred, 2).id, '1', 'direct entry continues into selected goal');
equal(queue.create({ videos, goalId: 'toefl' }).ids, [], 'unmapped goal stays empty');
equal(queue.create({ videos, goalId: 'toefl', collectionId: 10 }).ids, ['1', '2'], 'explicit collection uses only its published playable items');

const playbackWindow = load(new URL('../shared/playback-controller.js', import.meta.url));
let done = 0;
const controller = playbackWindow.EastudyPlayback.createCountdown({ seconds: 1, onDone: () => { done += 1; } });
controller.start({ id: 1 });
controller.cancel('route-change');
await new Promise(resolve => setTimeout(resolve, 1100));
equal(done, 0, 'cancel prevents late navigation');

console.log('Learning queue contract: 9/9 checks passed.');
