(function (global) {
  'use strict';

  const clone = value => JSON.parse(JSON.stringify(value));
  const finiteId = value => {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  };

  function resultOf(job) {
    return job && job.result && typeof job.result === 'object' ? job.result : null;
  }

  function isUsable(job) {
    const result = resultOf(job), video = result?.video;
    return String(job?.status || '').toUpperCase() === 'REVIEW' &&
      video && typeof video === 'object' && String(video.mediaUrl || video.media_url || '').trim() &&
      Array.isArray(result.sentences) && result.sentences.length > 0;
  }

  function difficulty(value, reviewedAt) {
    if (!value || typeof value !== 'object') return value;
    if (!value.primaryTrack && !Array.isArray(value.targetTracks)) return clone(value);
    return {...clone(value), reviewStatus: 'approved', source: value.source || 'ai',
      reviewedAt: value.reviewedAt || reviewedAt};
  }

  function mergeIntoSnapshot(snapshot, job, options = {}) {
    if (!isUsable(job)) return {ok: false, code: 'PROCESSING_RESULT_INCOMPLETE'};
    const result = resultOf(job), rawVideo = result.video;
    const videoId = String(job.videoId ?? job.video_id ?? rawVideo.id ?? rawVideo.videoId ?? rawVideo.video_id ?? '');
    if (!videoId) return {ok: false, code: 'PROCESSING_VIDEO_ID_MISSING'};
    const next = clone(snapshot || {});
    next.videos = Array.isArray(next.videos) ? next.videos : [];
    next.sentences = next.sentences && typeof next.sentences === 'object' ? next.sentences : {};
    next.creators = Array.isArray(next.creators) ? next.creators : [];
    next.jobs = Array.isArray(next.jobs) ? next.jobs : [];
    const current = next.videos.find(row => String(row.id) === videoId) || {};
    const input = job.input && typeof job.input === 'object' ? job.input : {};
    const creatorName = String(rawVideo.creator || current.creator || input.creator || '待确认创作者').trim();
    let creator = next.creators.find(row => String(row.id) === String(current.creatorId || rawVideo.creatorId || '')) ||
      next.creators.find(row => String(row.name || '').trim() === creatorName);
    if (!creator) {
      creator = {id: `creator-processing-${videoId}`, name: creatorName,
        group: '独立创作者', bio: '处理结果自动关联，待运营补充', status: 'ACTIVE'};
      next.creators.push(creator);
    }
    const now = options.reviewedAt || new Date().toISOString();
    const runId = job.runId || job.run_id || null;
    const outputRunId = job.outputRunId || job.output_run_id || runId;
    const video = {...current, ...clone(rawVideo), mediaUrl: rawVideo.mediaUrl || rawVideo.media_url || current.mediaUrl || '', id: finiteId(videoId),
      creator: creator.name, creatorId: creator.id, status: 'REVIEW', pipelineStatus: 'READY',
      processingJobId: String(job.id), runId, outputRunId,
      processingEvidence: {...(current.processingEvidence || {}), ...(result.evidence || {})},
      difficulty: difficulty(rawVideo.difficulty ?? current.difficulty, now),
      updatedAt: now};
    // Voice manifests are durable R2 output and stay out of the catalog snapshot.
    // Keeping the multi-megabyte item list here would exceed the catalog size limit
    // once a batch contains multiple videos. Preserve an already registered manifest.
    if (!current.voiceManifest && !options.includeVoiceManifest) delete video.voiceManifest;
    const index = next.videos.findIndex(row => String(row.id) === videoId);
    if (index >= 0) next.videos[index] = video; else next.videos.unshift(video);
    next.sentences[videoId] = clone(result.sentences);
    const summary = {...clone(job), videoId: finiteId(videoId), result: undefined,
      resultSentenceCount: result.sentences.length, outputRunId, updatedAt: job.updatedAt || now};
    delete summary.result;
    const jobIndex = next.jobs.findIndex(row => String(row.id) === String(job.id));
    if (jobIndex >= 0) next.jobs[jobIndex] = summary; else next.jobs.unshift(summary);
    return {ok: true, snapshot: next, video, sentences: next.sentences[videoId]};
  }

  global.EastudyProcessingResult = Object.freeze({isUsable, mergeIntoSnapshot});
})(window);
