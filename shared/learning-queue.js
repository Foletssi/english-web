(function (global) {
  'use strict';

  function mappedGoalIds(video) {
    const reviewed = Array.isArray(video?.goalMappings)
      ? video.goalMappings.filter(row => row && (row.approved === true || row.status === 'APPROVED' || row.reviewStatus === 'APPROVED')).map(row => row.goalId || row.goal_id)
      : [];
    return [...new Set(reviewed.map(String).filter(Boolean))];
  }

  function eligibleVideos(videos, goalId) {
    const target = String(goalId || 'general');
    const compatible = target === 'ielts' ? new Set(['ielts', 'ielts_academic', 'ielts_general']) : new Set([target]);
    return (Array.isArray(videos) ? videos : []).filter(video => {
      if (!video || video.status !== 'PUBLISHED') return false;
      if (!video.mediaUrl) return false;
      return target === 'general' || mappedGoalIds(video).some(id => compatible.has(id));
    });
  }

  function create(input) {
    const goalId = input?.source === 'direct' ? 'general' : String(input?.goalId || 'general');
    const preferred = input?.preferredVideoId == null ? '' : String(input.preferredVideoId);
    const collectionId = input?.collectionId == null ? null : String(input.collectionId);
    const pool = collectionId
      ? (Array.isArray(input?.videos) ? input.videos : []).filter(video => (video?.collectionIds || []).map(String).includes(collectionId))
      : input?.videos;
    const candidates = eligibleVideos(pool, collectionId ? 'general' : goalId).slice().sort((a, b) => {
      const pa = Number(a.teacherOrder ?? a.goalOrder ?? Number.MAX_SAFE_INTEGER);
      const pb = Number(b.teacherOrder ?? b.goalOrder ?? Number.MAX_SAFE_INTEGER);
      return pa - pb || String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')) || String(a.id).localeCompare(String(b.id));
    });
    const ids = [...new Set(candidates.map(video => String(video.id)))];
    const preferredIndex = preferred ? ids.indexOf(preferred) : -1;
    return {
      goalId,
      source: input?.source || 'goal',
      collectionId,
      ids,
      cursor: preferredIndex >= 0 ? preferredIndex : (ids.length ? 0 : -1),
      cycle: 0,
      loop: input?.loop === true
    };
  }

  function locate(queue, videoId) {
    return Array.isArray(queue?.ids) ? queue.ids.indexOf(String(videoId)) : -1;
  }

  function next(queue, videoId) {
    const ids = Array.isArray(queue?.ids) ? queue.ids : [];
    if (!ids.length) return { id: null, finished: true, wrapped: false, queue };
    const index = locate(queue, videoId);
    const current = index < 0 ? Number(queue?.cursor) || 0 : index;
    if (current + 1 < ids.length) {
      const updated = { ...queue, cursor: current + 1 };
      return { id: ids[current + 1], finished: false, wrapped: false, queue: updated };
    }
    if (queue?.loop) {
      const updated = { ...queue, cursor: 0, cycle: (Number(queue.cycle) || 0) + 1 };
      return { id: ids[0], finished: false, wrapped: true, queue: updated };
    }
    return { id: null, finished: true, wrapped: false, queue: { ...queue, cursor: current } };
  }

  function previous(queue, videoId) {
    const ids = Array.isArray(queue?.ids) ? queue.ids : [];
    if (!ids.length) return { id: null, boundary: true, queue };
    const index = locate(queue, videoId);
    const current = index < 0 ? Number(queue?.cursor) || 0 : index;
    if (current > 0) {
      const updated = { ...queue, cursor: current - 1 };
      return { id: ids[current - 1], boundary: false, queue: updated };
    }
    return { id: null, boundary: true, queue: { ...queue, cursor: 0 } };
  }

  global.EastudyLearningQueue = Object.freeze({ mappedGoalIds, eligibleVideos, create, locate, next, previous });
})(window);
