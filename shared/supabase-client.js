/* global supabase */
(function () {
  'use strict';

  const config = window.EASTUDY_SUPABASE_CONFIG || {};
  const available = Boolean(window.supabase && config.url && config.publishableKey);
  const clients = {};
  const empty = { user: null, session: null, profile: null, error: null };

  function client(scope) {
    if (!available) return null;
    const key = scope === 'admin' ? 'admin' : 'student';
    if (!clients[key]) {
      clients[key] = window.supabase.createClient(config.url, config.publishableKey, {
        auth: {
          storageKey: 'eastudy-' + key + '-auth',
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      });
    }
    return clients[key];
  }

  function cleanPhone(value) {
    return String(value || '').trim().replace(/[\s()\-]/g, '');
  }

  function phoneError(phone) {
    return /^\+[1-9]\d{7,14}$/.test(phone) ? '' : '请使用国际手机号格式，例如 +8613812345678。';
  }

  async function getContext(scope) {
    const api = client(scope);
    if (!api) return { ...empty, error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data: sessionData, error: sessionError } = await api.auth.getSession();
    if (sessionError || !sessionData.session) return { ...empty, error: sessionError || null };
    const user = sessionData.session.user;
    const { data: profile, error } = await api.from('profiles').select('*').eq('id', user.id).maybeSingle();
    return { user, session: sessionData.session, profile, error: error || null };
  }

  async function signUpPhone(input, scope) {
    const api = client(scope);
    const phone = cleanPhone(input.phone);
    const invalid = phoneError(phone);
    if (!api) return { data: null, error: new Error('SUPABASE_NOT_CONFIGURED') };
    if (invalid) return { data: null, error: new Error(invalid) };
    return api.auth.signUp({
      phone,
      password: String(input.password || ''),
      options: { data: { nickname: String(input.displayName || '').trim() || '新学员' } }
    });
  }

  async function signInPhone(input, scope) {
    const api = client(scope);
    const phone = cleanPhone(input.phone);
    const invalid = phoneError(phone);
    if (!api) return { data: null, error: new Error('SUPABASE_NOT_CONFIGURED') };
    if (invalid) return { data: null, error: new Error(invalid) };
    return api.auth.signInWithPassword({ phone, password: String(input.password || '') });
  }

  async function signOut(scope) {
    const api = client(scope);
    if (api) await api.auth.signOut();
  }

  async function upsertProgress(input) {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || context.profile?.role !== 'student') return { error: null };
    const now = new Date().toISOString();
    const row = {
      user_id: context.user.id,
      video_id: Number(input.videoId),
      position_seconds: Math.max(0, Number(input.position) || 0),
      duration_seconds: Math.max(0, Math.round(Number(input.duration) || 0)),
      completion_percent: Math.max(0, Math.min(100, Number(input.progressPercent) || 0)),
      last_watched_at: now,
      completed_at: input.completed ? now : null
    };
    return api.from('user_progress').upsert(row, { onConflict: 'user_id,video_id' });
  }

  async function setFavorite(input) {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || context.profile?.role !== 'student') return { error: null };
    return input.active
      ? api.from('saved_sentences').upsert({ user_id: context.user.id, video_id: Number(input.videoId), sentence_index: Number(input.sentenceIndex), english: input.english || '', chinese: input.chinese || '' }, { onConflict: 'user_id,video_id,sentence_index' })
      : api.from('saved_sentences').delete().eq('user_id', context.user.id).eq('video_id', Number(input.videoId)).eq('sentence_index', Number(input.sentenceIndex));
  }

  async function setVocabulary(input) {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || context.profile?.role !== 'student') return { error: null };
    const wordKey = String(input.wordKey || input.word || '').toLowerCase().trim();
    if (!wordKey) return { error: null };
    if (!input.active) return api.from('user_vocabulary').delete().eq('user_id', context.user.id).eq('word_key', wordKey);
    return api.from('user_vocabulary').upsert({
      user_id: context.user.id,
      word_key: wordKey,
      word: input.word,
      phonetic: input.phonetic || '',
      meaning: input.meaning || '',
      context: input.context || '',
      state: input.state || 'new',
      correct_streak: Number(input.correctStreak) || 0,
      added_at: input.addedAt || new Date().toISOString(),
      last_reviewed_at: input.lastReviewedAt || null,
      next_review_at: input.nextReviewAt || null
    }, { onConflict: 'user_id,word_key' });
  }

  async function logStudyEvent(eventType, input) {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || context.profile?.role !== 'student') return { error: null };
    return api.from('study_events').insert({
      user_id: context.user.id,
      event_type: eventType,
      video_id: input?.videoId ? Number(input.videoId) : null,
      payload: input?.payload || {}
    });
  }

  function setLocal(key, value) {
    try { localStorage.setItem('zs:' + key, JSON.stringify(value)); } catch (_) {}
  }

  async function hydrateStudentLearning() {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || context.profile?.role !== 'student') return context;
    const [progress, favorites, vocabulary] = await Promise.all([
      api.from('user_progress').select('*').order('last_watched_at', { ascending: false }),
      api.from('saved_sentences').select('*').eq('video_id', 2805),
      api.from('user_vocabulary').select('*')
    ]);
    if (!progress.error) {
      (progress.data || []).forEach(row => setLocal('progress:' + row.video_id, { time: row.position_seconds || 0, updatedAt: Date.parse(row.last_watched_at || '') || Date.now() }));
    }
    if (!favorites.error) setLocal('favSentences', (favorites.data || []).map(row => row.sentence_index));
    if (!vocabulary.error && vocabulary.data) {
      const meta = {};
      vocabulary.data.forEach(row => {
        meta[row.word_key] = {
          state: row.state,
          addedAt: Date.parse(row.added_at || '') || Date.now(),
          lastReviewedAt: row.last_reviewed_at ? Date.parse(row.last_reviewed_at) : null,
          nextReviewAt: row.next_review_at ? Date.parse(row.next_review_at) : null,
          correctStreak: row.correct_streak || 0,
          sourceVideoId: 2805
        };
      });
      setLocal('vocabMeta', meta);
      setLocal('vocab', (vocabulary.data || []).map(row => row.word));
      setLocal('vocabRemoved', []);
    }
    return context;
  }

  async function getAdminAnalytics() {
    const api = client('admin');
    const context = await getContext('admin');
    if (!api || !context.user || context.profile?.role !== 'admin') return { error: new Error('ADMIN_REQUIRED') };
    const [users, active, events] = await Promise.all([
      api.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'student'),
      api.from('user_progress').select('*', { count: 'exact', head: true }),
      api.from('study_events').select('*', { count: 'exact', head: true })
    ]);
    return {
      students: users.count || 0,
      activeLearners: active.count || 0,
      studyEvents: events.count || 0,
      error: users.error || active.error || events.error || null
    };
  }

  window.EastudyAuth = Object.freeze({ available, client, cleanPhone, getContext, signUpPhone, signInPhone, signOut });
  window.EastudyData = Object.freeze({ upsertProgress, setFavorite, setVocabulary, logStudyEvent, hydrateStudentLearning, getAdminAnalytics });
})();
