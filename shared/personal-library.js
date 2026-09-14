// M06: account-scoped collection saves and creator follows.
(function () {
  'use strict';
  const pending = new Set();
  const failure = code => ({ error: { code } });
  function isPending(key, userId) {
    return pending.has(String(userId || '') + ':' + key);
  }

  async function saveMutation({ key, getUserId, save, commit }) {
    const userId = String(getUserId() || '');
    if (!userId || userId === 'signed-out') return failure('AUTH_REQUIRED');
    if (!key || typeof save !== 'function') return failure('SAVE_UNAVAILABLE');
    const requestKey = userId + ':' + key;
    if (pending.has(requestKey)) return failure('SAVE_PENDING');
    pending.add(requestKey);
    try {
      const result = await save(userId);
      if (String(getUserId()) !== userId) return failure('ACCOUNT_CHANGED');
      if (!result || result.error) return result?.error ? result : failure('SAVE_UNAVAILABLE');
      commit();
      return { error: null };
    } catch (error) {
      return { error };
    } finally {
      pending.delete(requestKey);
    }
  }

  async function saveSentence({ videoId, index, sentence, contentVersion, getUserId, data, cache }) {
    const key = 'favSentences:' + videoId;
    const active = !cache.get(key, []).includes(index);
    const input = { active, videoId, sentenceIndex: index, sentenceId: sentence.id || `${videoId}-${index + 1}`,
      english: sentence.en || '', chinese: sentence.zh || '', contentVersion };
    const result = await saveMutation({ key: key + ':' + index, getUserId,
      save: expectedUserId => data?.setFavorite?.({ ...input, expectedUserId }),
      commit: () => {
        const rows = new Set(cache.get(key, []));
        active ? rows.add(index) : rows.delete(index);
        cache.set(key, [...rows]);
      } });
    return { ...result, active };
  }

  async function saveVocabulary({ word, key, active, patch = {}, details = {}, getUserId, data, cache }) {
    const oldDetails = cache.get('vocabDetails', {})[key] || {};
    const savedDetails = { ...details, ...oldDetails };
    const oldMeta = cache.get('vocabMeta', {})[key] || { state: 'new', addedAt: Date.now(), correctStreak: 0 };
    const meta = { ...oldMeta, ...patch };
    const iso = value => { const time = value ? new Date(value).getTime() : NaN; return Number.isFinite(time) ? new Date(time).toISOString() : null; };
    const input = { active, wordKey: key, word, phonetic: savedDetails.phon || '', meaning: savedDetails.meaning || '',
      context: savedDetails.context || '', state: meta.state, correctStreak: meta.correctStreak,
      addedAt: iso(meta.addedAt), lastReviewedAt: iso(meta.lastReviewedAt), nextReviewAt: iso(meta.nextReviewAt),
      sourceVideoId: savedDetails.sourceVideoId || oldMeta.sourceVideoId || null,
      sourceSentenceId: savedDetails.sourceSentenceId || null, contentVersion: savedDetails.contentVersion };
    const result = await saveMutation({ key: 'vocab:' + key, getUserId,
      save: expectedUserId => data?.setVocabulary?.({ ...input, expectedUserId }),
      commit: () => {
        const words = new Set(cache.get('vocab', []).map(value => String(value || '').toLowerCase().replace(/[^a-z'\-]+/g, ' ').trim().replace(/\s+/g, ' '))), metas = cache.get('vocabMeta', {}), allDetails = cache.get('vocabDetails', {});
        if (active) { words.add(key); metas[key] = meta; allDetails[key] = savedDetails; }
        else { words.delete(key); delete metas[key]; delete allDetails[key]; }
        cache.set('vocab', [...words]); cache.set('vocabMeta', metas); cache.set('vocabDetails', allDetails);
      } });
    return { ...result, active };
  }

  async function saveToggle({ key, active, getUserId, data, cache }) {
    const prefix = key.startsWith('follow:') ? 'follow:' : key.startsWith('collectionSaved:') ? 'collectionSaved:' : '';
    const method = prefix === 'follow:' ? 'setCreatorFollow' : 'setCollectionSave';
    if (!prefix || !key.slice(prefix.length) || !data?.[method]) return failure('SAVE_UNAVAILABLE');
    return saveMutation({ key, getUserId,
      save: userId => data[method](key.slice(prefix.length), Boolean(active), userId),
      commit: () => cache.set(key, Boolean(active)) });
  }

  function selectFavorites({ videos, collections, sentences, getSaved }) {
    const ids = new Set(sentences.map(row => String(row.video.id)));
    const savedVideos = videos.filter(video => ids.has(String(video.id)));
    const savedCollections = collections.filter(collection => getSaved('collectionSaved:' + collection.id) === true);
    return { videos: savedVideos, collections: savedCollections, sentences,
      counts: { videos: savedVideos.length, collections: savedCollections.length, sentences: sentences.length } };
  }

  window.EastudyPersonalLibrary = Object.freeze({ saveToggle, saveMutation, saveSentence, saveVocabulary, selectFavorites, isPending });
})();
