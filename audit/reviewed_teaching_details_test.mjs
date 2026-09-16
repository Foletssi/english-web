import assert from 'node:assert/strict';
import {validateReviewedPatches, validateTeachingCoverage, validateTeachingDetails} from '../shared/reviewed-teaching-contract.mjs';
const clone = value => structuredClone(value);
function sentence(id, english) {
  return {id, english, chinese: '说得自然一点。', textRevision: 2, startTime: 0, endTime: 2,
    keyWords: [], expressions: [], reviewStatus: 'APPROVED',
    teachingAnalysis: {status: 'completed', promptVersion: 'adult-vlog-v9-20260916', reviewVersion: 'adult-selection-review-v1-20260916', sourceTextRevision: 2},
    wordLookup: {schemaVersion: 1, sourceTextRevision: 2, sourceEnglish: english,
      tokens: [...english.matchAll(/[A-Za-z]+(?:['’‘‐‑–—-][A-Za-z]+)*/g)].map((match, index) => ({
        tokenId: 't' + index, surface: match[0], start: match.index, end: match.index + match[0].length,
        coreMeaningZh: '本句中的含义', pronunciationHint: '/ɡoʊ/'}))},
    translationAnalysis: {status: 'completed', promptVersion: 'context-lookup-v2-20260916', reviewVersion: 'context-lookup-review-v2-20260916', sourceTextRevision: 2, sourceConcerns: []},
    coverageAnalysis: {schemaVersion: 1, status: 'completed', promptVersion: 'adjacent-coverage-v1-20260916', reviewVersion: 'adult-selection-review-v1-20260916', sourceTextRevision: 2, pairs: []}};
}
const rows = [sentence('s1', '😀 Go, go!'), sentence('s2', 'We can.')];
const report = {pairId: 'p0', sentenceIds: ['s1', 's2'], sourceTextRevisions: [2, 2], status: 'no_eligible_source', reasonZh: '两句只有基础呼语和情态表达，没有进阶用法。'};
rows.forEach(row => row.coverageAnalysis.pairs.push(clone(report)));
validateTeachingCoverage(rows);
assert.equal(rows[0].wordLookup.tokens[0].start, 3, 'UTF16 emoji counts twice');
for (const mutate of [
  r => r.wordLookup.tokens[1].tokenId = 't0',
  r => r.wordLookup.tokens[0].start = 2,
  r => r.wordLookup.tokens.pop(),
  r => r.wordLookup.sourceEnglish = 'Different',
  r => r.wordLookup.tokens[0].coreMeaningZh = '释义待生成',
  r => r.wordLookup.tokens[0].pronunciationHint = '',
  r => r.wordLookup.tokens[0].pronunciationHint = '/riːd/ or /rɛd/',
  r => r.translationAnalysis.promptVersion = 'context-lookup-v1-20260916',
  r => r.expressions.push({surface: 'read between the lines', pronunciationHint: ''}),
  r => delete r.translationAnalysis.reviewVersion,
  r => r.translationAnalysis.sourceTextRevision = 1,
  r => r.translationAnalysis.sourceConcerns.push('原文疑似漏词，尚不能消歧。'),
  r => r.translationAnalysis.status = 'source_unresolved',
]) {
  const bad = clone(rows[0]); mutate(bad); assert.throws(() => validateTeachingDetails(bad));
}
const uncertain = clone(rows[0]);
Object.assign(uncertain.translationAnalysis, {status: 'source_unresolved', sourceConcerns: ['原文疑似漏词，尚不能消歧。'], translationOrigin: 'retained_source'});
validateTeachingDetails(uncertain);
const uncertainPair = [uncertain, clone(rows[1])];
validateTeachingCoverage(uncertainPair);
uncertain.translationAnalysis.translationOrigin = 'reviewed_candidate';
validateTeachingDetails(uncertain);
delete uncertain.translationAnalysis.translationOrigin;
assert.throws(() => validateTeachingDetails(uncertain), /provenance/);
for (const mutate of [
  r => r[0].coverageAnalysis.pairs[0].reasonZh = 'Changed independently',
  r => r[0].coverageAnalysis.pairs[0].sentenceIds.reverse(),
  r => r.forEach(row => row.coverageAnalysis.pairs[0].status = 'locked'),
  r => r[0].coverageAnalysis.pairs = [],
  r => delete r[1].coverageAnalysis,
]) {
  const bad = clone(rows); mutate(bad); assert.throws(() => validateTeachingCoverage(bad));
}
const patchFor = row => Object.fromEntries(['id','keyWords','expressions','teachingAnalysis','chinese','wordLookup','translationAnalysis','coverageAnalysis'].map(k => [k, clone(row[k])]));
const patches = rows.map(patchFor);
assert.deepEqual(validateReviewedPatches(rows, clone(rows), patches), rows);
for (const side of ['published', 'draft']) {
  const pub = clone(rows), draft = clone(rows), locked = side === 'published' ? pub : draft;
  locked[0].translationLocked = true; locked[0].chinese = '人工译文';
  assert.throws(() => validateReviewedPatches(pub, draft, patches), /Translation locked/);
}
const changed = clone(patches); changed[0].english = 'injection';
assert.throws(() => validateReviewedPatches(rows, rows, changed), /Forbidden patch field/);
const missing = clone(patches); delete missing[0].wordLookup;
assert.throws(() => validateReviewedPatches(rows, rows, missing), /Incomplete details patch/);
const one = sentence('only', 'Fine.'); validateTeachingCoverage([one]);
console.log('Reviewed teaching details: source identity, UTF16, independent review, coverage, locks and field allowlist passed.');
