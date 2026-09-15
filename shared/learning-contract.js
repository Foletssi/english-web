(function (global) {
  'use strict';

  const PLACEHOLDER = /释义待生成|尚未生成|等待生成|待补充/;
  const ALLOWED_TAGS = new Set([
    'daily-life', 'spoken-english', 'friendship', 'workplace', 'travel-scene',
    'food-culture', 'study-skills', 'culture', 'conversation'
  ]);

  function normalizeSurface(value) {
    return String(value ?? '').normalize('NFKC').replace(/[’‘]/g, "'")
      .replace(/[‐‑–—]/g, '-').toLowerCase().replace(/[^a-z'\-]+/g, ' ')
      .trim().replace(/\s+/g, ' ');
  }

  function meaningful(value, max) {
    const text = typeof value === 'string' ? value.trim() : '';
    return Boolean(text && text.length <= max && !PLACEHOLDER.test(text));
  }

  function sentenceIssues(sentence, options = {}) {
    const issues = [];
    const id = String(sentence?.id ?? '');
    let expressionKey = null;
    const add = (code, field, message) => issues.push({code, field, sentenceId: id, expressionKey, message});
    if (!id) add('SENTENCE_ID_MISSING', 'id', '句子缺少稳定编号');
    if (!String(sentence?.english ?? '').trim()) add('ENGLISH_MISSING', 'english', '缺少英文字幕');
    if (!String(sentence?.chinese ?? '').trim()) add('TRANSLATION_MISSING', 'chinese', '缺少中文翻译');
    const keywords = Array.isArray(sentence?.keyWords) ? sentence.keyWords : [];
    const expressions = Array.isArray(sentence?.expressions) ? sentence.expressions : [];
    if (!Array.isArray(sentence?.keyWords)) add('KEYWORDS_INVALID', 'keyWords', '重点表达必须是数组');
    if (!Array.isArray(sentence?.expressions)) add('EXPRESSIONS_INVALID', 'expressions', '释义必须是数组');
    if (keywords.length > 5) add('KEYWORDS_LIMIT', 'keyWords', '每句重点表达最多五项');
    if (keywords.some(key => typeof key !== 'string')) add('KEYWORDS_INVALID', 'keyWords', '重点表达必须是文本');
    const keys = keywords.map(normalizeSurface);
    if (keys.length !== expressions.length || keys.some((key, i) => key !== normalizeSurface(expressions[i]?.surface)))
      add('EXPRESSION_ORDER', 'expressions', '释义必须与重点表达逐项同序对应');
    const ranges = [];
    if (keys.some(key => !key)) add('KEYWORD_EMPTY', 'keyWords', '重点表达不能为空');
    if (new Set(keys).size !== keys.length) add('KEYWORD_DUPLICATE', 'keyWords', '重点表达不能重复');
    const source = ` ${normalizeSurface(sentence?.english)} `;
    for (const key of keys) {
      expressionKey = key || null;
      if (!source.includes(` ${key} `)) {
        add('KEYWORD_NOT_IN_SENTENCE', 'keyWords', `原句中找不到重点表达：${key}`);
        continue;
      }
      const start = source.indexOf(` ${key} `) + 1, end = start + key.length;
      if (ranges.some(([a, b]) => start < b && end > a)) add('EXPRESSION_OVERLAP', 'keyWords', '重点表达不能互相重叠');
      ranges.push([start, end]);
      const matches = expressions.filter(item => normalizeSurface(item?.surface) === key);
      if (matches.length !== 1) {
        add('EXPRESSION_MATCH', 'expressions', `缺少唯一对应释义：${key}`);
        continue;
      }
      const expression = matches[0];
      if (!meaningful(expression.coreMeaningZh, 300))
        add('CORE_MEANING_MISSING', `expressions.${key}.coreMeaningZh`, `${key} 缺少核心释义`);
      if (!meaningful(expression.contextMeaningZh, 500))
        add('CONTEXT_MEANING_MISSING', `expressions.${key}.contextMeaningZh`, `${key} 缺少本句语境释义`);
      if (!['word','phrasal_verb','collocation','idiom','pattern'].includes(String(expression.expressionType || '')))
        add('EXPRESSION_TYPE_INVALID', `expressions.${key}.expressionType`, `${key} 缺少正确的表达类型`);
      if (!meaningful(expression.lemma, 160))
        add('EXPRESSION_LEMMA_MISSING', `expressions.${key}.lemma`, `${key} 缺少词头或可迁移结构`);
      if (!meaningful(expression.selectionReasonZh, 300) || typeof expression.needsReview !== 'boolean')
        add('EXPRESSION_TEACHING_FIELDS_MISSING', `expressions.${key}`, `${key} 缺少教学选择依据`);
      if (options.forPublish && expression.reviewStatus !== 'APPROVED' && expression.approved !== true)
        add('EXPRESSION_REVIEW_REQUIRED', `expressions.${key}.reviewStatus`, `${key} 的释义尚未确认`);
      if (options.forPublish && expression.needsReview === true)
        add('EXPRESSION_UNCERTAIN', `expressions.${key}.needsReview`, `${key} 的教学含义仍待核对`);
      if (options.forPublish && (expression.sourceTextRevision == null ? Number(sentence.textRevision || 1) !== 1 : Number(expression.sourceTextRevision) !== Number(sentence.textRevision || 1)))
        add('EXPRESSION_STALE', `expressions.${key}.sourceTextRevision`, `${key} 的释义与当前英文版本不一致`);
    }
    for (const expression of expressions) {
      expressionKey = normalizeSurface(expression?.surface) || null;
      if (!keys.includes(normalizeSurface(expression?.surface)))
        add('EXPRESSION_ORPHAN', 'expressions', `释义没有对应重点表达：${String(expression?.surface || '空值')}`);
    }
    expressionKey = null;
    if (options.forPublish && sentence?.reviewStatus !== 'APPROVED')
      add('SENTENCE_REVIEW_REQUIRED', 'reviewStatus', '本句尚未确认');
    if (options.forPublish && sentence?.segmentationNeedsReview === true)
      add('SEGMENTATION_REVIEW_REQUIRED', 'segmentationNeedsReview', '本句分句或词级对齐仍需核对');
    return issues;
  }

  function approvedTeachingExpressions(sentence) {
    if (!sentence || !Array.isArray(sentence.keyWords)) return [];
    const source = ` ${normalizeSurface(sentence.english)} `;
    const revision = Number(sentence.textRevision || 1);
    const seen = new Set();
    return sentence.keyWords.flatMap(surface => {
      const key = normalizeSurface(surface);
      if (!key || seen.has(key) || !source.includes(` ${key} `)) return [];
      seen.add(key);
      const matches = (Array.isArray(sentence.expressions) ? sentence.expressions : []).filter(item => normalizeSurface(item?.surface) === key);
      if (matches.length !== 1) return [];
      const expression = matches[0];
      // Legacy published expressions may lack a stamp only before any text revision.
      const fresh = expression.sourceTextRevision == null ? revision === 1 : Number(expression.sourceTextRevision) === revision;
      const legacyApproved = revision === 1 && !sentence.teachingAnalysis?.promptVersion && expression.needsReview == null;
      if (!fresh || (expression.needsReview !== false && !legacyApproved) ||
          (expression.reviewStatus !== 'APPROVED' && expression.approved !== true) ||
          !meaningful(expression.coreMeaningZh, 300) || !meaningful(expression.contextMeaningZh, 500)) return [];
      return [{...expression, surface: String(surface)}];
    });
  }

  function teachingSelectionDiff(before, after) {
    const oldKeys = new Set((Array.isArray(before?.keyWords) ? before.keyWords : []).map(normalizeSurface));
    const newKeys = new Set((Array.isArray(after?.keyWords) ? after.keyWords : []).map(normalizeSurface));
    return {added: [...newKeys].filter(key => !oldKeys.has(key)),
      removed: [...oldKeys].filter(key => !newKeys.has(key)),
      retained: [...newKeys].filter(key => oldKeys.has(key)),
      review: (Array.isArray(after?.expressions) ? after.expressions : []).filter(item => item?.needsReview === true).map(item => item.surface)};
  }

  function tagIssues(video, sentences, options = {}) {
    const issues = [];
    const allowed = options.allowedTags || ALLOWED_TAGS;
    const sentenceIds = new Set((sentences || []).map(row => String(row?.id ?? '')));
    const assignments = Array.isArray(video?.tagAssignments) ? video.tagAssignments : [];
    const approved = assignments.filter(row => row?.reviewStatus === 'APPROVED' || row?.approved === true);
    if (!approved.length) issues.push({code: 'PUBLISHED_TAGS_MISSING', field: 'tagAssignments', message: '请确认至少一个内容标签'});
    const seen = new Set();
    for (const tag of approved) {
      const id = String(tag?.tagId ?? tag?.id ?? '');
      if (!allowed.has(id)) issues.push({code: 'TAG_UNKNOWN', field: 'tagAssignments', tagId: id, message: `未知标签：${id || '空值'}`});
      if (seen.has(id)) issues.push({code: 'TAG_DUPLICATE', field: 'tagAssignments', tagId: id, message: `标签重复：${id}`});
      seen.add(id);
      const evidence = Array.isArray(tag?.sentenceIds) ? tag.sentenceIds.map(String) : [];
      if (!evidence.length || evidence.some(sentenceId => !sentenceIds.has(sentenceId)))
        issues.push({code: 'TAG_EVIDENCE_INVALID', field: 'tagAssignments', tagId: id, message: `${id || '标签'} 缺少有效字幕依据`});
      if (!String(tag?.reasonZh ?? tag?.reason ?? '').trim())
        issues.push({code: 'TAG_REASON_MISSING', field: 'tagAssignments', tagId: id, message: `${id || '标签'} 缺少选择理由`});
    }
    return issues;
  }

  function videoPublishIssues(video, sentences) {
    const issues = [];
    if (!video) return [{code: 'VIDEO_NOT_FOUND', field: 'video', message: '视频不存在'}];
    if (!String(video.mediaUrl ?? '').trim()) issues.push({code: 'PUBLISHED_MEDIA_MISSING', field: 'mediaUrl', message: '缺少可播放视频'});
    if (!Array.isArray(sentences) || !sentences.length) issues.push({code: 'PUBLISHED_SUBTITLES_MISSING', field: 'sentences', message: '缺少学习字幕'});
    for (const sentence of sentences || []) issues.push(...sentenceIssues(sentence, {forPublish: true}));
    issues.push(...tagIssues(video, sentences || []));
    if (video.pipelineStatus && !['READY', 'SUCCESS'].includes(video.pipelineStatus))
      issues.push({code: 'PIPELINE_NOT_READY', field: 'pipelineStatus', message: '自动处理尚未完成'});
    return issues;
  }

  function firstMessage(errorOrIssues) {
    const issues = Array.isArray(errorOrIssues) ? errorOrIssues : errorOrIssues?.issues;
    return issues?.[0]?.message || String(errorOrIssues?.message || errorOrIssues || '未知错误');
  }

  global.EastudyLearningContract = Object.freeze({
    VERSION: 5, TEACHING_SCHEMA_VERSION: 3, ALLOWED_TAGS, normalizeSurface, meaningful, sentenceIssues,
    tagIssues, videoPublishIssues, firstMessage, approvedTeachingExpressions, teachingSelectionDiff
  });
})(window);
