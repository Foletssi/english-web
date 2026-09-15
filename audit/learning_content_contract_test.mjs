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
const learningContract = load(new URL('../shared/learning-contract.js', import.meta.url)).EastudyLearningContract;
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
equal(learningContract.normalizeSurface('  Don’t—stop  '), "don't-stop", 'surface normalization matches cloud rules');
const validSentence = { id: '1-1', english: "Don't stop", chinese: '不要停。', keyWords: ["Don't stop"], reviewStatus: 'APPROVED', expressions: [
  { surface: "don't stop", lemma: "don't stop", expressionType: 'pattern', coreMeaningZh: '不要停', contextMeaningZh: '在本句中用于鼓励继续', selectionReasonZh: '常用祈使表达', needsReview: false, reviewStatus: 'APPROVED' }
] };
equal(learningContract.sentenceIssues(validSentence, { forPublish: true }), [], 'approved complete learning content can publish');
equal(learningContract.sentenceIssues({...validSentence, expressions: [{...validSentence.expressions[0], coreMeaningZh: '释义待生成'}]}).map(x=>x.code), ['CORE_MEANING_MISSING'], 'placeholder meanings are rejected');
equal(learningContract.sentenceIssues({...validSentence, expressions: [{...validSentence.expressions[0], reviewStatus: 'REVIEW'}]}, {forPublish:true}).map(x=>x.code), ['EXPRESSION_REVIEW_REQUIRED'], 'sentence approval never bypasses expression approval');
const taggedVideo = {mediaUrl:'/1.m3u8',pipelineStatus:'READY',tagAssignments:[{tagId:'daily-life',reviewStatus:'APPROVED',reasonZh:'日常对话',sentenceIds:['1-1']}]};
equal(learningContract.videoPublishIssues(taggedVideo,[validSentence]), [], 'video publication accepts approved controlled tags with evidence');
equal(learningContract.videoPublishIssues({...taggedVideo,tagAssignments:[]},[validSentence]).map(x=>x.code), ['PUBLISHED_TAGS_MISSING'], 'publication blocks missing approved tags');
console.log('Learning content contract: 13/13 checks passed.');

equal(learningContract.approvedTeachingExpressions({...validSentence, textRevision: 2}), [], 'unstamped old expression must not follow revised English');
equal(learningContract.approvedTeachingExpressions({...validSentence, keyWords: []}), [], 'empty selection stays empty');
equal(learningContract.approvedTeachingExpressions({...validSentence, expressions: [{...validSentence.expressions[0], needsReview: true}]}), [], 'uncertain expression never highlights');
equal(learningContract.meaningful({meaning:'fake'},300), false, 'objects cannot masquerade as meanings');
const overlap = {...validSentence, keyWords: ["Don't stop", 'stop'], expressions: [...validSentence.expressions, {...validSentence.expressions[0], surface:'stop'}]};
if(!learningContract.sentenceIssues(overlap).some(x=>x.code==='EXPRESSION_OVERLAP')) throw new Error('overlap accepted');
console.log('Teaching selector and malformed-content regressions passed.');

const legacyExpression = {...validSentence.expressions[0]};
delete legacyExpression.needsReview;
const legacySentence = {...validSentence, expressions:[legacyExpression]};
equal(learningContract.approvedTeachingExpressions(legacySentence).length, 1, 'legacy approved content remains visible before text changes');
equal(learningContract.approvedTeachingExpressions({...legacySentence, teachingAnalysis:{promptVersion:'adult-vlog-v7-20260915'}}), [], 'new teaching content cannot use legacy compatibility');
equal(learningContract.approvedTeachingExpressions({...legacySentence, textRevision:2}), [], 'legacy content cannot follow revised source');
equal(learningContract.approvedTeachingExpressions({...legacySentence, expressions:[{...legacyExpression, reviewStatus:'REVIEW'}]}), [], 'legacy compatibility never approves an unreviewed expression');
console.log('Legacy published teaching compatibility: 4/4 passed.');
