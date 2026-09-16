// Server-side publication checks; no UI state or provider credentials.
import assert from 'node:assert/strict';
export const DETAIL_FIELDS = ['chinese', 'wordLookup', 'translationAnalysis', 'coverageAnalysis'];
const present = (row, field) => Object.hasOwn(row, field);
const revision = row => row.textRevision ?? 1;
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/释义待生成|尚未生成|等待生成|待补充/.test(value);
const ipa = value => typeof value === 'string' && value.length <= 300 && /^\/[A-Za-zæçðøŋœθβχ\u0250-\u02ff\u0300-\u036f\u1d00-\u1d7f .ˈˌːˑ-]+\/$/u.test(value);
const ambiguous = /\b(?:read|live|wind|lead|tear|bow|close|does|bass|minute|wound|record|present|object|subject|invalid|refuse|content|produce|permit|desert)\b/i;
export function validateTeachingDetails(row) {
  if (!DETAIL_FIELDS.slice(1).some(field => present(row, field))) return false;
  assert(DETAIL_FIELDS.every(field => present(row, field)), 'Incomplete teaching details');
  assert(Number.isInteger(revision(row)) && revision(row) >= 1, 'Invalid text revision');
  assert(text(row.chinese, 1000), 'Invalid contextual translation');
  const lookup = row.wordLookup, translation = row.translationAnalysis, coverage = row.coverageAnalysis;
  assert.equal(lookup.schemaVersion, 1);
  assert.equal(lookup.sourceEnglish, row.english);
  assert.equal(lookup.sourceTextRevision, revision(row));
  const expected = [...row.english.matchAll(/[A-Za-z]+(?:['’‘‐‑–—-][A-Za-z]+)*/g)];
  assert(Array.isArray(lookup.tokens) && lookup.tokens.length === expected.length, 'Token count mismatch');
  expected.forEach((match, index) => {
    const token = lookup.tokens[index];
    assert.equal(token.tokenId, 't' + index);
    assert.equal(token.surface, match[0]);
    assert.equal(token.start, match.index);
    assert.equal(token.end, match.index + match[0].length);
    assert(text(token.coreMeaningZh, 160), 'Missing contextual word meaning');
    assert(ipa(token.pronunciationHint), 'Missing single contextual IPA');
  });
  for (const expression of row.expressions ?? []) {
    if (['REJECTED', 'DELETED'].includes(String(expression.reviewStatus ?? '').toUpperCase())) continue;
    const hint = expression.pronunciationHint ?? '';
    assert(hint === '' && !ambiguous.test(expression.surface) || ipa(hint), 'Invalid phrase contextual IPA');
  }
  for (const [analysis, prompt, review] of [
    [translation, 'context-lookup-v2-20260916', 'context-lookup-review-v2-20260916'],
    [coverage, 'adjacent-coverage-v1-20260916', 'adult-selection-review-v1-20260916'],
  ]) {
    assert.equal(analysis.status, analysis === translation && translation.sourceConcerns?.length ? 'source_unresolved' : 'completed');
    assert.equal(analysis.promptVersion, prompt);
    assert.equal(analysis.reviewVersion, review);
    assert.equal(analysis.sourceTextRevision, revision(row));
  }
  assert(Array.isArray(translation.sourceConcerns) && translation.sourceConcerns.length <= 5);
  assert(translation.sourceConcerns.every(concern => text(concern, 300)));
  if (translation.status === 'source_unresolved') {
    assert(['retained_source', 'reviewed_candidate'].includes(translation.translationOrigin), 'Missing uncertain translation provenance');
  }
  assert.equal(coverage.schemaVersion, 1);
  assert(Array.isArray(coverage.pairs) && coverage.pairs.length <= 2);
  assert.equal(row.teachingAnalysis?.reviewVersion, 'adult-selection-review-v1-20260916');
  return true;
}
export function validateTeachingCoverage(rows) {
  const detailed = rows.map(validateTeachingDetails);
  if (!detailed.some(Boolean)) return;
  assert(detailed.every(Boolean), 'Mixed teaching detail generations');
  rows.forEach((row, index) => {
    const indices = [index - 1, index].filter(i => i >= 0 && i < rows.length - 1);
    assert.equal(row.coverageAnalysis.pairs.length, indices.length);
    indices.forEach((pairIndex, reportIndex) => {
      const pair = rows.slice(pairIndex, pairIndex + 2);
      const report = row.coverageAnalysis.pairs[reportIndex];
      assert.equal(report.pairId, 'p' + pairIndex);
      assert.deepEqual(report.sentenceIds, pair.map(r => r.id));
      assert.deepEqual(report.sourceTextRevisions, pair.map(revision));
      const status = pair.some(r => r.keyWords.length) ? 'covered' : pair.every(r => r.selectionLocked === true) ? 'locked' : 'no_eligible_source';
      assert.equal(report.status, status);
      assert(text(report.reasonZh, 600), 'Missing pair review evidence');
      assert.deepEqual(report, pair[0].coverageAnalysis.pairs.find(p => p.pairId === report.pairId));
      assert.deepEqual(report, pair[1].coverageAnalysis.pairs.find(p => p.pairId === report.pairId));
    });
  });
}
export function validateReviewedPatches(published, draft, patches) {
  assert(Array.isArray(published) && Array.isArray(draft) && Array.isArray(patches));
  assert.equal(patches.length, published.length);
  assert.equal(draft.length, published.length);
  for (const rows of [published, draft]) {
    assert.equal(new Set(rows.map(row => String(row.id))).size, rows.length, 'Duplicate source ID');
    assert(rows.every(row => row.id !== null && row.id !== undefined && String(row.id) !== ''));
  }
  const merged = published.map((row, index) => {
    const patch = patches[index], editable = draft.find(d => String(d.id) === String(row.id));
    assert.deepEqual(patch.id, row.id);
    assert(editable, 'Draft sentence missing');
    assert(Object.keys(patch).every(key => ['id', 'keyWords', 'expressions', 'teachingAnalysis', ...DETAIL_FIELDS].includes(key)), 'Forbidden patch field');
    assert(Array.isArray(patch.keyWords) && Array.isArray(patch.expressions));
    assert.equal(patch.teachingAnalysis?.status, 'completed');
    assert(text(patch.teachingAnalysis?.promptVersion, 160) && text(patch.teachingAnalysis?.reviewVersion, 160));
    assert.equal(patch.teachingAnalysis.sourceTextRevision, revision(row));
    for (const key of ['english', 'startTime', 'endTime']) assert.deepEqual(editable[key], row[key]);
    assert.equal(revision(editable), revision(row));
    const suppliedDetails = DETAIL_FIELDS.some(key => present(patch, key));
    if (suppliedDetails) assert(DETAIL_FIELDS.every(key => present(patch, key)), 'Incomplete details patch');
    for (const original of [row, editable]) {
      if (original.selectionLocked) {
        assert.deepEqual(patch.keyWords, original.keyWords, 'Selection locked');
        assert.deepEqual(patch.expressions, original.expressions, 'Selection locked');
      }
      if (original.translationLocked && present(patch, 'chinese')) assert.equal(patch.chinese, original.chinese, 'Translation locked');
    }
    const next = {...row, ...patch};
    validateTeachingDetails(next);
    return next;
  });
  validateTeachingCoverage(merged);
  return merged;
}
