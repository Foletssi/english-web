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
    const text = String(value ?? '').trim();
    return Boolean(text && text.length <= max && !PLACEHOLDER.test(text));
  }

  function sentenceIssues(sentence, options = {}) {
    const issues = [];
    const id = String(sentence?.id ?? '');
    const add = (code, field, message) => issues.push({code, field, sentenceId: id, message});
    if (!id) add('SENTENCE_ID_MISSING', 'id', '句子缺少稳定编号');
    if (!String(sentence?.english ?? '').trim()) add('ENGLISH_MISSING', 'english', '缺少英文字幕');
    if (!String(sentence?.chinese ?? '').trim()) add('TRANSLATION_MISSING', 'chinese', '缺少中文翻译');
    const keywords = Array.isArray(sentence?.keyWords) ? sentence.keyWords : [];
    const expressions = Array.isArray(sentence?.expressions) ? sentence.expressions : [];
    if (!Array.isArray(sentence?.keyWords)) add('KEYWORDS_INVALID', 'keyWords', '重点表达必须是数组');
    if (!Array.isArray(sentence?.expressions)) add('EXPRESSIONS_INVALID', 'expressions', '释义必须是数组');
    const keys = keywords.map(normalizeSurface);
    if (keys.some(key => !key)) add('KEYWORD_EMPTY', 'keyWords', '重点表达不能为空');
    if (new Set(keys).size !== keys.length) add('KEYWORD_DUPLICATE', 'keyWords', '重点表达不能重复');
    const source = ` ${normalizeSurface(sentence?.english)} `;
    for (const key of keys) {
      if (!source.includes(` ${key} `)) {
        add('KEYWORD_NOT_IN_SENTENCE', 'keyWords', `原句中找不到重点表达：${key}`);
        continue;
      }
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
    }
    for (const expression of expressions) {
      if (!keys.includes(normalizeSurface(expression?.surface)))
        add('EXPRESSION_ORPHAN', 'expressions', `释义没有对应重点表达：${String(expression?.surface || '空值')}`);
    }
    if (options.forPublish && sentence?.reviewStatus !== 'APPROVED')
      add('SENTENCE_REVIEW_REQUIRED', 'reviewStatus', '本句尚未确认');
    return issues;
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
    tagIssues, videoPublishIssues, firstMessage
  });
})(window);
