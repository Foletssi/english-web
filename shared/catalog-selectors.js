(function (global) {
  'use strict';

  const TOPIC_CATEGORIES = Object.freeze({
    daily: '日常生活', travel: '旅行', food: '美食', work: '职场', education: '教育',
    technology: '科技', nature: '自然', culture: '文化', health: '健康',
    growth: '个人成长', psychology: '心理'
  });

  function uniqueStrings(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(String).map(x => x.trim()).filter(Boolean))];
  }

  function publishedVideos(snapshotOrVideos) {
    const rows = Array.isArray(snapshotOrVideos) ? snapshotOrVideos : snapshotOrVideos?.videos;
    return (Array.isArray(rows) ? rows : []).filter(video =>
      video && video.status === 'PUBLISHED' && !video.deletedAt && Boolean(video.mediaUrl)
    );
  }

  function topicIds(video) {
    const ids = uniqueStrings(video?.topicIds);
    if (ids.length) return ids;
    const wanted = String(video?.category || '');
    return Object.entries(TOPIC_CATEGORIES).filter(([, label]) => label === wanted).map(([id]) => id);
  }

  function categoryLabel(video) {
    const id = topicIds(video)[0];
    return TOPIC_CATEGORIES[id] || String(video?.category || '待分类');
  }

  function tagIds(video) {
    const direct=Array.isArray(video?.tagIds)?video.tagIds.filter(Boolean):[];
    return uniqueStrings(direct.length?direct:(video?.tagAssignments || [])
      .filter(row => row && (row.reviewStatus === 'APPROVED' || row.approved === true))
      .map(row => row.tagId ?? row.id));
  }

  function queryVideos(videos, filters = {}) {
    return publishedVideos(videos).filter(video =>
      (!filters.track || global.EastudyTaxonomy?.approvedTracks(video).includes(String(filters.track))) &&
      (!filters.topicId || topicIds(video).includes(String(filters.topicId))) &&
      (!filters.tagId || tagIds(video).includes(String(filters.tagId))) &&
      (!filters.creatorId || String(video.creatorId || '') === String(filters.creatorId)) &&
      (!filters.collectionId || (video.collectionIds || []).some(id => String(id) === String(filters.collectionId)))
    );
  }

  function availableTags(videos, registry = []) {
    const counts = new Map();
    publishedVideos(videos).forEach(video => tagIds(video).forEach(id => counts.set(id, (counts.get(id) || 0) + 1)));
    const source = registry.length ? registry : [...counts.keys()].map(id => ({ id, labelZh: id }));
    return source.map(tag => ({ ...tag, videoCount: counts.get(String(tag.id)) || 0 }))
      .filter(tag => tag.videoCount > 0)
      .sort((a, b) => b.videoCount - a.videoCount || String(a.id).localeCompare(String(b.id)));
  }

  function uniqueTagPage(tags, offset = 0, pageSize = 10) {
    const unique = [...new Map((Array.isArray(tags) ? tags : [])
      .filter(tag => tag && tag.id != null)
      .map(tag => [String(tag.id), tag])).values()];
    const count = unique.length;
    const requested = Number(pageSize);
    const limit = Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : 10;
    const size = Math.min(limit, count);
    if (!size) return [];
    const raw = Number(offset);
    const safeOffset = Number.isFinite(raw) ? Math.trunc(raw) : 0;
    const start = ((safeOffset % count) + count) % count;
    return Array.from({ length: size }, (_, index) => unique[(start + index) % count]);
  }

  function collectionMembers(videos, collectionId) {
    return queryVideos(videos, { collectionId });
  }

  function collectionCover(collection, videos) {
    const members=collectionMembers(videos,collection.id);
    const source=collection.coverSource;
    if(source?.type==='video')return members.find(video=>String(video.id)===String(source.videoId))?.cover||members[0]?.cover||'assets/images/video_cover_pending.svg';
    if(source?.type==='asset')return collection.cover||'assets/images/video_cover_pending.svg';
    // A legacy managed URL is only a display fallback, not evidence of ownership.
    if(/\/api\/processing\/media\//.test(String(collection.cover||''))) {
      const match=members.find(video=>video.cover===collection.cover);
      return match?.cover||members[0]?.cover||'assets/images/video_cover_pending.svg';
    }
    return collection.cover||members[0]?.cover||'assets/images/video_cover_pending.svg';
  }

  function decodeRouteId(value) {
    try { return decodeURIComponent(String(value || '')); } catch (_) { return null; }
  }

  function creatorContent(videos, collections, creatorId) {
    const rows = queryVideos(videos, { creatorId });
    const ids = new Set(rows.flatMap(video => video.collectionIds || []).map(String));
    return { videos: rows, collections: collections.filter(collection => ids.has(String(collection.id))) };
  }

  function collectionStats(members, progressForVideo, sentencesForVideo) {
    const rows = publishedVideos(members);
    const durationSeconds = rows.reduce((sum, video) => sum + Math.max(0, Number(video.duration) || 0), 0);
    const completedVideoCount = rows.filter(video => Boolean(progressForVideo?.(video.id)?.completed)).length;
    const expressions = new Set();
    rows.forEach(video => (sentencesForVideo?.(video.id) || []).forEach(sentence => {
      const values = Array.isArray(sentence.expressions) && sentence.expressions.length
        ? sentence.expressions.filter(x => x.reviewStatus === 'APPROVED' || x.approved === true).map(x => x.surface)
        : sentence.keyWords || [];
      values.forEach(value => { if (String(value || '').trim()) expressions.add(String(value).toLowerCase().trim()); });
    }));
    return {
      videoCount: rows.length,
      durationSeconds,
      creatorCount: new Set(rows.map(video => video.creatorId).filter(Boolean).map(String)).size,
      expressionCount: expressions.size,
      completedVideoCount,
      completedPercent: rows.length ? Math.round(completedVideoCount / rows.length * 100) : 0
    };
  }

  global.EastudyCatalog = Object.freeze({
    TOPIC_CATEGORIES, uniqueStrings, publishedVideos, topicIds, categoryLabel, tagIds,
    queryVideos, availableTags, uniqueTagPage, collectionMembers, collectionStats, decodeRouteId, creatorContent, collectionCover
  });
})(window);
