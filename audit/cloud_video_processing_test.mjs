import assert from 'node:assert/strict';
import { parseVtt, stageProgress, validateLearning, validateMetadata } from '../supabase/functions/video-processing/core.ts';

const cues = parseVtt(`WEBVTT

00:00.000 --> 00:02.500
Good morning &amp; welcome.

2
00:00:02.500 --> 00:00:05.000 align:start
I have got a plan.
`, '42');

assert.deepEqual(cues, [
  { id: '42-1', startTime: 0, endTime: 2.5, english: 'Good morning & welcome.' },
  { id: '42-2', startTime: 2.5, endTime: 5, english: 'I have got a plan.' }
]);

const learning = validateLearning(cues, { sentences: [
  { id: '42-2', chinese: '我有一个计划。', keyWords: ['have got'], grammar: '现在完成形式在此表达持有。' },
  { id: '42-1', chinese: '早上好，欢迎。', keyWords: ['Good morning'], grammar: '祈使式问候语。' }
] });
assert.equal(learning[0].id, '42-1');
assert.equal(learning[1].keyWords[0], 'have got');
assert.throws(() => validateLearning(cues, { sentences: [
  { id: '42-1', chinese: '早上好', keyWords: ['invented phrase'], grammar: '问候' },
  { id: '42-2', chinese: '有计划', keyWords: [], grammar: '陈述句' }
] }), /AI_KEYWORD_NOT_IN_SOURCE/);

const metadata = validateMetadata({ titleZh: '晨间计划', descriptionZh: '一段关于晨间计划的英语视频。', level: 'A2',
  levelReason: '句式简短', topicIds: ['daily', 'bad'], goalMappings: [{ goalId: 'daily', sentenceIds: ['42-1'], reason: '日常问候' }] },
new Set(cues.map((row) => row.id)));
assert.deepEqual(metadata.topicIds, ['daily']);
assert.equal(metadata.goalMappings.length, 1);
assert.equal(stageProgress('REVIEW'), 100);

console.log('Cloud video processing core: PASS');
