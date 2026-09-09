import fs from 'node:fs';
import vm from 'node:vm';

function load(path) {
  const window = {}; window.window = window;
  vm.runInNewContext(fs.readFileSync(path, 'utf8'), { window });
  return window;
}
function equal(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

const catalog = load(new URL('../shared/catalog-selectors.js', import.meta.url)).EastudyCatalog;
const utils = load(new URL('../shared/study-utils.js', import.meta.url)).EastudyStudyUtils;
const videos = [
  { id: 1, status: 'PUBLISHED', mediaUrl: '/1.m3u8', topicIds: ['daily', 'food'], tagIds: ['coffee', 'morning', 'friendship'], creatorId: 'c1', collectionIds: [7], duration: 60 },
  { id: 2, status: 'ARCHIVED', mediaUrl: '/2.m3u8', topicIds: ['travel'], tagIds: ['trip'], creatorId: 'c2', collectionIds: [7], duration: 80 }
];
equal(catalog.publishedVideos(videos).map(v => v.id), [1], 'only published playable videos are exposed');
equal(catalog.queryVideos(videos, { topicId: 'food', tagId: 'coffee' }).map(v => v.id), [1], 'topic and tag filters share one catalog');
equal(catalog.categoryLabel(videos[0]), '日常生活', 'stable topic id maps to Chinese label');
equal(catalog.availableTags(videos, [{ id: 'coffee', labelZh: '咖啡点单' }, { id: 'trip', labelZh: '旅行' }]).map(x => [x.id, x.videoCount]), [['coffee', 1]], 'empty tags are hidden');
equal(catalog.collectionStats(videos, () => ({ completed: true }), () => [{ keyWords: ['regular coffee'] }]), { videoCount: 1, durationSeconds: 60, creatorCount: 1, expressionCount: 1, completedVideoCount: 1, completedPercent: 100 }, 'collection stats are derived');
equal(utils.allocateSeconds(600, [4, 3, 2, 1]), [240, 180, 120, 60], 'ten-minute plan remains ten minutes');
equal(utils.mergeWatchRanges([[0, 10]], [[5, 15]], 100), [[0, 15]], 'overlapping ranges merge once');
console.log('Learning content contract: 7/7 checks passed.');
