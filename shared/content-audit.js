(function (global) {
  'use strict';
  const labels = {
    DUPLICATE_VIDEO_ID: '视频编号重复', VIDEO_TITLE_EMPTY: '缺少视频标题',
    VIDEO_TITLE_ZH_MISSING: '尚未填写中文标题', VIDEO_CREATOR_MISSING: '未关联有效创作者',
    INVALID_SENTENCE_RANGE: '字幕结束时间必须晚于开始时间', SENTENCE_OVERLAP: '字幕时间与上一句重叠',
    INVALID_WORD_TIMING: '单词时间超出字幕范围', KEY_EXPRESSION_MISSING: '重点表达尚未完成分析',
    GRAMMAR_ANALYSIS_MISSING: '语法说明尚未完成分析', ANALYSIS_FAILED: '教学分析失败，请到处理记录重试',
    ANALYSIS_PENDING: '教学分析尚未完成', PUBLISHED_MEDIA_MISSING: '视频缺少播放文件地址'
  };
  const text = issue => issue.message || labels[issue.code] || '内容需要检查，请打开对应内容；技术详情可用于排查';
  function analysisComplete(row) {
    const a = row?.teachingAnalysis;
    return a?.status === 'completed' && Boolean(String(a.promptVersion || '').trim()) &&
      Number(a.sourceTextRevision) === Math.max(1, Number(row.textRevision) || 1);
  }
  function deduplicate(issues) {
    const unique = new Map();
    for (const issue of issues) {
      const key = JSON.stringify([issue.videoId, issue.sentenceId || null, issue.expressionKey || null,
        issue.tagId || null, issue.field || '', issue.code]);
      if (!unique.has(key) || issue.severity === 'ERROR') unique.set(key, issue);
    }
    return [...unique.values()];
  }
  function processingIntegrity(video, rows, job) {
    const raw = String(job?.rawStatus || job?.status || '').toUpperCase();
    if (!['REVIEW', 'ERROR'].includes(raw)) return {ok: true, issues: []};
    const issues = [];
    if (raw === 'ERROR') {
      issues.push({severity: 'ERROR', code: 'PROCESSING_JOB_ERROR', field: 'job', message: job?.error?.message || '处理任务已失败，不能进入审核'});
      return {ok: false, issues};
    }
    if (!video) issues.push({severity: 'ERROR', code: 'PROCESSING_VIDEO_MISSING', field: 'video', message: '任务已结束但视频记录不存在'});
    else {
      if (String(video.processingJobId || '') !== String(job?.id || '')) issues.push({severity: 'ERROR', code: 'PROCESSING_JOB_LINK_MISMATCH', field: 'processingJobId', message: '任务与内容快照的关联不一致'});
      if (!['READY', 'SUCCESS'].includes(String(video.pipelineStatus || ''))) issues.push({severity: 'ERROR', code: 'PROCESSING_SNAPSHOT_NOT_READY', field: 'pipelineStatus', message: '任务已结束但内容快照仍未就绪'});
      if (!String(video.mediaUrl || '').trim()) issues.push({severity: 'ERROR', code: 'PROCESSING_MEDIA_MISSING', field: 'mediaUrl', message: '任务已结束但快照没有可播放媒体'});
    }
    if (!Array.isArray(rows) || !rows.length) issues.push({severity: 'ERROR', code: 'PROCESSING_SUBTITLES_MISSING', field: 'sentences', message: '任务已结束但快照没有字幕'});
    const resultCount = Number(job?.resultSentenceCount ?? job?.result?.sentences?.length ?? 0);
    if (resultCount > 0 && Array.isArray(rows) && resultCount !== rows.length) issues.push({severity: 'ERROR', code: 'PROCESSING_SENTENCE_COUNT_MISMATCH', field: 'sentences', message: `任务结果 ${resultCount} 句，快照 ${rows.length} 句`});
    return {ok: issues.length === 0, issues};
  }
  function inspect(snapshot, contract = global.EastudyLearningContract, jobs = []) {
    if (!contract) throw new Error('LEARNING_CONTRACT_UNAVAILABLE');
    const found = [], ids = new Set(), videos = snapshot.videos || [];
    for (const video of videos) {
      const videoId = String(video.id), rows = snapshot.sentences?.[videoId] || [];
      const add = (issue, row, index) => found.push({severity: 'ERROR', ...issue,
        videoId, sentenceId: row ? String(row.id) : issue.sentenceId || null,
        sentenceIndex: row ? index + 1 : null,
        message: text(issue)});
      if (ids.has(videoId)) add({code: 'DUPLICATE_VIDEO_ID'});
      ids.add(videoId);
      if (!video.title) add({code: 'VIDEO_TITLE_EMPTY'});
      if (!video.titleZh) add({code: 'VIDEO_TITLE_ZH_MISSING', severity: 'WARN'});
      if (!(snapshot.creators || []).some(c => String(c.id) === String(video.creatorId))) add({code: 'VIDEO_CREATOR_MISSING'});
      if (video.status === 'PUBLISHED') {
        for (const issue of contract.videoPublishIssues(video, rows).filter(i => !Object.prototype.hasOwnProperty.call(i,'sentenceId'))) add(issue);
      }
      let prevEnd = -1;
      rows.forEach((row, index) => {
        for (const issue of contract.sentenceIssues(row, {forPublish: true})) add(issue, row, index);
        if (!(Number(row.endTime) > Number(row.startTime))) add({code: 'INVALID_SENTENCE_RANGE', field: 'endTime'}, row, index);
        if (Number(row.startTime) < prevEnd - .001) add({code: 'SENTENCE_OVERLAP', severity: 'WARN', field: 'startTime'}, row, index);
        prevEnd = Math.max(prevEnd, Number(row.endTime));
        if (!analysisComplete(row)) {
          const status = row.teachingAnalysis?.status;
          if (status === 'failed') add({code: 'ANALYSIS_FAILED', field: 'teachingAnalysis'}, row, index);
          else if (status) add({code: 'ANALYSIS_PENDING', field: 'teachingAnalysis', severity: 'WARN'}, row, index);
          else {
            if (!row.keyWords?.length) add({code: 'KEY_EXPRESSION_MISSING', field: 'keyWords', severity: 'WARN'}, row, index);
            if (!String(row.grammar || row.grammarNote || '').trim()) add({code: 'GRAMMAR_ANALYSIS_MISSING', field: 'grammar', severity: 'WARN'}, row, index);
          }
        }
        for (const word of row.wordTimings || []) {
          if (!Number.isFinite(Number(word.start)) || !Number.isFinite(Number(word.end)) ||
              word.start < row.startTime - .001 || word.end > Number(row.endTime) + .001 || word.end <= word.start)
            add({code: 'INVALID_WORD_TIMING', field: 'wordTimings'}, row, index);
        }
      });
    }
    const jobByVideo = new Map((Array.isArray(jobs) ? jobs : []).map(job => [String(job.videoId ?? job.video_id), job]));
    for (const video of videos) {
      const job = jobByVideo.get(String(video.id));
      if (!job) continue;
      for (const issue of processingIntegrity(video, snapshot.sentences?.[String(video.id)] || [], job).issues)
        found.push({severity: 'ERROR', ...issue, videoId: String(video.id), sentenceId: null, sentenceIndex: null});
    }
    const issues = deduplicate(found), wordCards = new Set(), pending = new Set();
    for (const issue of issues) {
      if (issue.expressionKey && issue.code !== 'EXPRESSION_REVIEW_REQUIRED')
        wordCards.add(JSON.stringify([issue.videoId, issue.sentenceId, issue.expressionKey]));
      if (/^(SENTENCE|EXPRESSION)_REVIEW_REQUIRED$/.test(issue.code)) pending.add(JSON.stringify([issue.videoId, issue.sentenceId]));
    }
    const groups = videos.map(video => ({video, issues: issues.filter(i => i.videoId === String(video.id))})).filter(g => g.issues.length);
    return {ok: !issues.some(i => i.severity === 'ERROR'), issues, groups,
      summary: {affectedVideos: new Set(issues.map(i => i.videoId)).size, wordCards: wordCards.size, pendingSentences: pending.size}};
  }
  // Local preview only. Production consumes the same categories calculated over all server videos.
  function processingSummary(jobs) {
    const groups = new Map();
    for (const j of jobs) {
      const id = String(j.videoId ?? j.video_id), state = j.rawStatus || j.status;
      const priority = ['RUNNING', 'QUEUED', 'WAITING'].includes(state) ? 2 : state === 'CANCELLED' ? 0 : 1;
      const previous = groups.get(id), updated = String(j.updatedAt || j.updated_at || '');
      if (!previous || priority > previous.priority || (priority === previous.priority && updated > previous.updated))
        groups.set(id, {state, priority, updated});
    }
    const result = {active: 0, failed: 0, review: 0, completed: 0, cancelled: 0, total: groups.size};
    for (const {state} of groups.values()) result[['RUNNING','QUEUED','WAITING'].includes(state) ? 'active' :
      state === 'ERROR' ? 'failed' : state === 'REVIEW' ? 'review' : state === 'CANCELLED' ? 'cancelled' : 'completed']++;
    return result;
  }
  global.EastudyContentAudit = Object.freeze({inspect, processingIntegrity, deduplicate, text, analysisComplete, processingSummary});
})(window);
