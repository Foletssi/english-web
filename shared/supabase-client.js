/* global supabase */
(function () {
  'use strict';

  const config = window.EASTUDY_SUPABASE_CONFIG || {};
  const available = Boolean(window.supabase && config.url && config.publishableKey);
  const clients = {};
  const empty = { user: null, session: null, profile: null, error: null };
  const REMEMBER_LOGIN_KEY = 'eastudy:student:remember-login';
  const PAGE_STUDY_SESSION_ID = globalThis.crypto?.randomUUID?.() || '00000000-0000-4000-8000-' + String(Date.now()).padStart(12, '0').slice(-12);
  let studySequence = 0;
  let outboxFlushPromise = null;
  let studentIdentityId = null;
  let studentIdentityGeneration = 0;
  let stopActivityHeartbeat = null;

  function observeStudentIdentity(userId) {
    const next = userId ? String(userId) : null;
    if (next !== studentIdentityId) {
      studentIdentityId = next;
      studentIdentityGeneration += 1;
    }
    return studentIdentityGeneration;
  }

  function getRememberLogin() {
    try { return localStorage.getItem(REMEMBER_LOGIN_KEY) !== 'false'; } catch (_) { return false; }
  }

  function studentAuthStorage() {
    const target = () => getRememberLogin() ? localStorage : sessionStorage;
    return {
      getItem(key) { try { return target().getItem(key); } catch (_) { return null; } },
      setItem(key, value) { try { const keep = target(), drop = keep === localStorage ? sessionStorage : localStorage; keep.setItem(key, value); drop.removeItem(key); } catch (_) {} },
      removeItem(key) { try { localStorage.removeItem(key); sessionStorage.removeItem(key); } catch (_) {} }
    };
  }

  function setRememberLogin(enabled) {
    const persist = Boolean(enabled), key = 'eastudy-student-auth';
    try {
      localStorage.setItem(REMEMBER_LOGIN_KEY, String(persist));
      const from = persist ? sessionStorage : localStorage, to = persist ? localStorage : sessionStorage;
      const value = from.getItem(key);
      if (value) to.setItem(key, value);
      from.removeItem(key);
    } catch (_) {}
  }

  function client(scope) {
    if (!available) return null;
    const key = scope === 'admin' ? 'admin' : 'student';
    if (!clients[key]) {
      clients[key] = window.supabase.createClient(config.url, config.publishableKey, {
        auth: {
          storageKey: 'eastudy-' + key + '-auth',
          storage: key === 'student' ? studentAuthStorage() : localStorage,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      });
    }
    return clients[key];
  }

  function cleanPhone(value) {
    const compact = String(value || '').trim().replace(/[\s()\-]/g, '');
    if (/^1\d{10}$/.test(compact)) return '+86' + compact;
    if (/^861\d{10}$/.test(compact)) return '+' + compact;
    return compact;
  }

  function phoneError(phone) {
    return /^\+[1-9]\d{7,14}$/.test(phone) ? '' : '请使用国际手机号格式，例如 +8613812345678。';
  }

  function isLearnerProfile(profile) {
    return ['learner', 'student', 'admin'].includes(String(profile?.role || '').toLowerCase());
  }

  async function getContext(scope) {
    const api = client(scope);
    if (!api) return { ...empty, error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data: sessionData, error: sessionError } = await api.auth.getSession();
    if (sessionError || !sessionData.session) {
      if (scope !== 'admin') observeStudentIdentity(null);
      return { ...empty, error: sessionError || null };
    }
    const user = sessionData.session.user;
    if (scope !== 'admin') observeStudentIdentity(user.id);
    const { data: profile, error } = await api.from('profiles').select('*').eq('id', user.id).maybeSingle();
    return { user, session: sessionData.session, profile, error: error || null };
  }

  async function signInPhone(input, scope) {
    const api = client(scope);
    const phone = cleanPhone(input.phone);
    const invalid = phoneError(phone);
    if (!api) return { data: null, error: new Error('SUPABASE_NOT_CONFIGURED') };
    if (invalid) return { data: null, error: new Error(invalid) };
    return api.auth.signInWithPassword({ phone, password: String(input.password || '') });
  }

  async function applyServerSession(session, scope = 'student') {
    const api = client(scope);
    if (!api || !session?.access_token || !session?.refresh_token) {
      return { data: null, error: new Error('INVALID_AUTH_SESSION') };
    }
    return api.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  }

  function apiError(payload, fallback, status) {
    const error = new Error(payload?.error || fallback);
    error.code = payload?.error || fallback;
    error.status = Number(status) || 0;
    error.access = payload?.access || null;
    return error;
  }

  async function signInAccount(input, scope = 'student') {
    try {
      const response = await fetch(`${String(config.url || '').replace(/\/$/, '')}/functions/v1/learner-auth`, {
        method: 'POST', headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', account: String(input.account || '').trim(), password: String(input.password || '') })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return { data: null, error: apiError(payload, 'INVALID_LOGIN', response.status), access: payload.access || null };
      const result = await applyServerSession(payload.session, scope);
      return result.error ? result : { ...result, access: payload.access || null };
    } catch (error) { return { data: null, error }; }
  }

  async function activateAndLogin(input, scope = 'student') {
    try {
      const response = await fetch(`${String(config.url || '').replace(/\/$/, '')}/functions/v1/learner-auth`, {
        method: 'POST', headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'activate', account: String(input.account || '').trim(), password: String(input.password || ''), inviteCode: String(input.inviteCode || '').trim() })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return { data: null, error: apiError(payload, 'ACTIVATION_UNAVAILABLE', response.status), access: payload.access || null };
      const result = await applyServerSession(payload.session, scope);
      return result.error ? result : { ...result, access: payload.access || null };
    } catch (error) { return { data: null, error }; }
  }

  async function registerWithInvite(input, scope = 'student') {
    try {
      const edgeUrl = `${String(config.url || '').replace(/\/$/, '')}/functions/v1/invite-register`;
      const response = await fetch(edgeUrl, {
        method: 'POST', headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: String(input.account || '').trim(), password: String(input.password || ''),
          nickname: String(input.displayName || '').trim(), inviteCode: String(input.inviteCode || '').trim(),
          attemptId: String(input.attemptId || '')
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return { data: null, error: apiError(payload, 'REGISTRATION_UNAVAILABLE', response.status) };
      const result = await applyServerSession(payload.session, scope);
      return result.error ? result : { ...result, membership: payload.membership, account: payload.account, access: payload.access || null };
    } catch (error) { return { data: null, error }; }
  }

  async function ensureStudentProfile(displayName) {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || context.profile) return context;
    await api.from('profiles').insert({
      id: context.user.id,
      phone: context.user.phone || '',
      nickname: String(displayName || context.user.user_metadata?.nickname || '').trim() || '新学员',
      role: 'learner'
    });
    return getContext('student');
  }

  async function updatePassword(password, scope) {
    const api = client(scope);
    const next = String(password || '');
    if (!api) return { data: null, error: new Error('SUPABASE_NOT_CONFIGURED') };
    if (next.length < 6) return { data: null, error: new Error('PASSWORD_TOO_SHORT') };
    return api.auth.updateUser({ password: next });
  }

  async function signOut(scope) {
    const api = client(scope);
    if (api) await api.auth.signOut();
    if (scope !== 'admin') {
      window.EastudyAccessGuard?.stop();
      stopLearnerActivity();
      observeStudentIdentity(null);
    }
  }

  function outboxKey(userId) {
    return 'eastudy:study-outbox:v3:' + String(userId);
  }

  function readOutbox(userId) {
    try {
      const rows = JSON.parse(localStorage.getItem(outboxKey(userId)) || '[]');
      return Array.isArray(rows) ? rows.filter(row => row && row.userId === String(userId) && row.payload) : [];
    } catch (_) { return []; }
  }

  function writeOutbox(userId, rows) {
    try { localStorage.setItem(outboxKey(userId), JSON.stringify((rows || []).slice(-1000))); } catch (_) {}
  }

  function pendingStudyEvents() {
    if (!studentIdentityId) return 0;
    return readOutbox(studentIdentityId).length;
  }

  function queueStudyEvent(userId, payload) {
    const rows = readOutbox(userId);
    const event = {
      userId: String(userId),
      sessionId: PAGE_STUDY_SESSION_ID,
      sequenceNo: ++studySequence,
      queuedAt: new Date().toISOString(),
      payload
    };
    rows.push(event);
    writeOutbox(userId, rows);
    return event;
  }

  async function flushStudyOutbox() {
    if (outboxFlushPromise) return outboxFlushPromise;
    outboxFlushPromise = (async () => {
      const api = client('student'), context = await getContext('student');
      if (!api || !context.user || !isLearnerProfile(context.profile)) return { error: context.error || null };
      const userId = String(context.user.id), generation = studentIdentityGeneration;
      let rows = readOutbox(userId), lastData = null;
      while (rows.length) {
        const current = rows[0];
        if (studentIdentityGeneration !== generation || studentIdentityId !== userId) return { error: new Error('STUDENT_IDENTITY_CHANGED') };
        const { data, error } = await api.rpc('apply_study_event_v2', current.payload);
        if (error) return { data: lastData, error };
        lastData = data;
        const latest = readOutbox(userId);
        const index = latest.findIndex(row => row.sessionId === current.sessionId && Number(row.sequenceNo) === Number(current.sequenceNo));
        if (index >= 0) latest.splice(index, 1);
        writeOutbox(userId, latest);
        rows = latest;
      }
      return { data: lastData, error: null };
    })().finally(() => { outboxFlushPromise = null; });
    return outboxFlushPromise;
  }

  async function applyStudySync(input, activeSeconds, activityStartedAt, activityEndedAt) {
    const context = await getContext('student');
    const duration = Math.max(0, Number(input?.duration) || 0);
    if (!context.user || !isLearnerProfile(context.profile) || !duration) return { error: context.error || null };
    const clientRecordedAt = new Date().toISOString();
    const event = queueStudyEvent(context.user.id, {
      p_session_id: PAGE_STUDY_SESSION_ID,
      p_sequence_no: studySequence,
      p_video_id: Number(input.videoId),
      p_media_version: String(input.mediaVersion || 'unknown'),
      p_position_seconds: Math.max(0, Math.min(duration, Number(input.position) || 0)),
      p_duration_seconds: duration,
      p_watch_ranges: Array.isArray(input.watchRanges) ? input.watchRanges.slice(-500) : [],
      p_active_seconds: Math.max(0, Math.min(60, Math.round(Number(activeSeconds) || 0))),
      p_activity_started_at: activityStartedAt || null,
      p_activity_ended_at: activityEndedAt || null,
      p_client_recorded_at: clientRecordedAt
    });
    event.payload.p_sequence_no = event.sequenceNo;
    const rows = readOutbox(context.user.id), index = rows.findIndex(row => row.sessionId === event.sessionId && row.sequenceNo === event.sequenceNo);
    if (index >= 0) rows[index] = event;
    writeOutbox(context.user.id, rows);
    return flushStudyOutbox();
  }

  async function upsertProgress(input) {
    return applyStudySync(input, 0, null, null);
  }

  async function recordStudyActivity(input) {
    const seconds = Math.max(0, Math.min(60, Number(input?.activeSeconds) || 0));
    if (!seconds) return { error: null };
    const endedAt = input.activityEndedAt || new Date().toISOString();
    const startedAt = input.activityStartedAt || new Date(Date.parse(endedAt) - seconds * 1000).toISOString();
    return applyStudySync(input, seconds, startedAt, endedAt);
  }

  async function setFavorite(input) {
    const api = client('student');
    const context = await getContext('student');
    if (context.error || !api || !context.user || !isLearnerProfile(context.profile)) return { error: context.error || new Error('AUTH_REQUIRED') };
    if (input.expectedUserId && String(context.user.id) !== String(input.expectedUserId)) return { error: new Error('ACCOUNT_CHANGED') };
    return input.active
      ? api.from('saved_sentences').upsert({ user_id: context.user.id, video_id: Number(input.videoId), sentence_index: Number(input.sentenceIndex), sentence_id: String(input.sentenceId || ''), content_version: String(input.contentVersion || 'published-v1'), english: input.english || '', chinese: input.chinese || '' }, { onConflict: 'user_id,video_id,sentence_index' })
      : api.from('saved_sentences').delete().eq('user_id', context.user.id).eq('video_id', Number(input.videoId)).eq('sentence_index', Number(input.sentenceIndex));
  }

  async function setVocabulary(input) {
    const api = client('student');
    const context = await getContext('student');
    if (context.error || !api || !context.user || !isLearnerProfile(context.profile)) return { error: context.error || new Error('AUTH_REQUIRED') };
    if (input.expectedUserId && String(context.user.id) !== String(input.expectedUserId)) return { error: new Error('ACCOUNT_CHANGED') };
    const wordKey = String(input.wordKey || input.word || '').toLowerCase().trim();
    if (!wordKey) return { error: new Error('WORD_REQUIRED') };
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
      next_review_at: input.nextReviewAt || null,
      source_video_id: input.sourceVideoId ? Number(input.sourceVideoId) : null,
      source_sentence_id: input.sourceSentenceId ? String(input.sourceSentenceId) : null,
      source_token_id: input.sourceTokenId ? String(input.sourceTokenId) : null,
      source_text_revision: input.sourceTextRevision ?? null,
      content_version: String(input.contentVersion || 'published-v1')
    }, { onConflict: 'user_id,word_key' });
  }

  async function logStudyEvent(eventType, input) {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || !isLearnerProfile(context.profile)) return { error: null };
    return api.from('study_events').insert({
      user_id: context.user.id,
      event_type: eventType,
      video_id: input?.videoId ? Number(input.videoId) : null,
      payload: input?.payload || {}
    });
  }

  async function setCreatorFollow(creatorId, active, expectedUserId) {
    const api = client('student'), context = await getContext('student');
    if (context.error || !api || !context.user || !isLearnerProfile(context.profile)) return { error: context.error || new Error('AUTH_REQUIRED') };
    if (expectedUserId && String(context.user.id) !== String(expectedUserId)) return { error: new Error('ACCOUNT_CHANGED') };
    return api.from('user_creator_follows').upsert({ user_id: context.user.id, creator_id: String(creatorId), active: Boolean(active), updated_at: new Date().toISOString() }, { onConflict: 'user_id,creator_id' });
  }

  async function setCollectionSave(collectionId, active, expectedUserId) {
    const api = client('student'), context = await getContext('student');
    if (context.error || !api || !context.user || !isLearnerProfile(context.profile)) return { error: context.error || new Error('AUTH_REQUIRED') };
    if (expectedUserId && String(context.user.id) !== String(expectedUserId)) return { error: new Error('ACCOUNT_CHANGED') };
    return api.from('user_collection_saves').upsert({ user_id: context.user.id, collection_id: String(collectionId), active: Boolean(active), updated_at: new Date().toISOString() }, { onConflict: 'user_id,collection_id' });
  }

  async function saveLearningPreferences(settings, expectedUserId) {
    const api = client('student'), context = await getContext('student');
    if (context.error || !api || !context.user || !isLearnerProfile(context.profile)) return { error: context.error || new Error('AUTH_REQUIRED') };
    if (expectedUserId && String(context.user.id) !== String(expectedUserId)) return { error: new Error('ACCOUNT_CHANGED') };
    return api.rpc('patch_learning_preferences_v1', { p_patch: settings || {} });
  }

  function setLocal(userId, key, value) {
    try { localStorage.setItem('zs:user:' + String(userId) + ':' + key, JSON.stringify(value)); } catch (_) {}
  }

  function clearLocalPrefix(userId, keyPrefix) {
    try {
      const prefix = 'zs:user:' + String(userId) + ':' + keyPrefix;
      Object.keys(localStorage).filter(key => key.startsWith(prefix)).forEach(key => localStorage.removeItem(key));
    } catch (_) {}
  }

  function normalizeLearningGoalProfile(row) {
    if (!row) return null;
    return {
      track: row.primary_goal_id || 'general',
      dailyMinutes: Number(row.daily_minutes) || 20,
      selfLevel: row.self_level || 'unsure',
      timezone: row.timezone || 'Asia/Shanghai',
      onboardingVersion: Number(row.onboarding_version) || 1,
      revision: Number(row.revision) || 1,
      updatedAt: row.updated_at || null
    };
  }

  async function getLearningGoalProfile() {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || !isLearnerProfile(context.profile)) {
      return { profile: null, error: context.error || new Error('STUDENT_REQUIRED') };
    }
    const result = await api.from('learner_goal_profiles').select('*').eq('user_id', context.user.id).maybeSingle();
    return { profile: normalizeLearningGoalProfile(result.data), error: result.error || null };
  }

  async function saveLearningGoalProfile(input) {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || !isLearnerProfile(context.profile)) {
      return { profile: null, error: context.error || new Error('STUDENT_REQUIRED') };
    }
    const dailyMinutes = [10, 20, 40, 60].includes(Number(input?.dailyMinutes)) ? Number(input.dailyMinutes) : 20;
    const selfLevel = ['beginner', 'elementary', 'intermediate', 'advanced', 'unsure'].includes(input?.selfLevel) ? input.selfLevel : 'unsure';
    const row = {
      user_id: context.user.id,
      primary_goal_id: String(input?.track || 'general'),
      daily_minutes: dailyMinutes,
      self_level: selfLevel,
      timezone: String(input?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'),
      onboarding_version: Math.max(1, Number(input?.onboardingVersion) || 1)
    };
    setLocal(context.user.id, 'learningPlan', {
      track: row.primary_goal_id,
      dailyMinutes: row.daily_minutes,
      selfLevel: row.self_level,
      timezone: row.timezone,
      onboardingVersion: row.onboarding_version
    });
    const result = await api.from('learner_goal_profiles').upsert(row, { onConflict: 'user_id' }).select('*').single();
    if (!result.error && result.data) setLocal(context.user.id, 'learningPlan', normalizeLearningGoalProfile(result.data));
    return { profile: normalizeLearningGoalProfile(result.data) || normalizeLearningGoalProfile(row), error: result.error || null };
  }

  async function hydrateStudentLearning() {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || !isLearnerProfile(context.profile)) return context;
    const requestUserId = String(context.user.id), requestGeneration = studentIdentityGeneration;
    const [progress, favorites, vocabulary, learningGoal, daily, follows, collectionSaves, preferences, summary] = await Promise.all([
      api.from('user_progress').select('*').eq('user_id', requestUserId).order('last_watched_at', { ascending: false }),
      api.from('saved_sentences').select('*').eq('user_id', requestUserId),
      api.from('user_vocabulary').select('*').eq('user_id', requestUserId),
      api.from('learner_goal_profiles').select('*').eq('user_id', context.user.id).maybeSingle(),
      api.from('daily_learning_stats').select('study_date,learning_seconds').eq('user_id', requestUserId).order('study_date', { ascending: false }).limit(366),
      api.from('user_creator_follows').select('creator_id,active').eq('user_id', requestUserId),
      api.from('user_collection_saves').select('collection_id,active').eq('user_id', requestUserId),
      api.from('user_learning_preferences').select('settings').eq('user_id', requestUserId).maybeSingle(),
      api.rpc('get_my_learning_summary_v3')
    ]);
    const currentSession = await api.auth.getSession();
    if (requestGeneration !== studentIdentityGeneration || String(currentSession.data?.session?.user?.id || '') !== requestUserId) {
      return { ...context, error: new Error('STUDENT_IDENTITY_CHANGED') };
    }
    if (!progress.error) {
      (progress.data || []).forEach(row => {
        setLocal(context.user.id, 'progress:' + row.video_id, { time: row.position_seconds || 0, duration: row.duration_seconds || 0, percent: row.completion_percent || 0, watchCoveragePercent: row.watch_coverage_percent || 0, completed: Boolean(row.completed_at), updatedAt: Date.parse(row.last_watched_at || '') || Date.now() });
        setLocal(context.user.id, 'watchCoverage:' + row.video_id, Array.isArray(row.watch_ranges) ? row.watch_ranges : []);
      });
    }
    if (!favorites.error) {
      clearLocalPrefix(context.user.id, 'favSentences:');
      const byVideo = {};
      (favorites.data || []).forEach(row => {
        const key = String(row.video_id);
        if (!byVideo[key]) byVideo[key] = [];
        byVideo[key].push(Number(row.sentence_index));
      });
      Object.entries(byVideo).forEach(([videoId, indexes]) => setLocal(context.user.id, 'favSentences:' + videoId, indexes));
    }
    if (!vocabulary.error && vocabulary.data) {
      const meta = {};
      const details = {};
      vocabulary.data.forEach(row => {
        meta[row.word_key] = {
          state: row.state,
          addedAt: Date.parse(row.added_at || '') || Date.now(),
          lastReviewedAt: row.last_reviewed_at ? Date.parse(row.last_reviewed_at) : null,
          nextReviewAt: row.next_review_at ? Date.parse(row.next_review_at) : null,
          correctStreak: row.correct_streak || 0,
          sourceVideoId: row.source_video_id || null,
          sourceSentenceId: row.source_sentence_id || null,
          sourceTokenId: row.source_token_id || null,
          sourceTextRevision: row.source_text_revision ?? null
        };
        details[row.word_key] = { phon: row.phonetic || '', meaning: row.meaning || '', context: row.context || '', contentVersion: row.content_version, sourceVideoId: row.source_video_id || null, sourceSentenceId: row.source_sentence_id || null, sourceTokenId: row.source_token_id || null, sourceTextRevision: row.source_text_revision ?? null };
      });
      setLocal(context.user.id, 'vocabMeta', meta);
      setLocal(context.user.id, 'vocabDetails', details);
      setLocal(context.user.id, 'vocab', Object.keys(meta));
      setLocal(context.user.id, 'vocabRemoved', []);
    }
    if (!learningGoal.error && learningGoal.data) {
      setLocal(context.user.id, 'learningPlan', normalizeLearningGoalProfile(learningGoal.data));
    }
    if (!daily.error) {
      const sessions = {};
      (daily.data || []).forEach(row => { sessions[row.study_date] = Math.max(0, Number(row.learning_seconds) || 0); });
      setLocal(context.user.id, 'studySessions', sessions);
    }
    if (!follows.error) (follows.data || []).forEach(row => setLocal(context.user.id, 'follow:' + row.creator_id, Boolean(row.active)));
    if (!collectionSaves.error) (collectionSaves.data || []).forEach(row => setLocal(context.user.id, 'collectionSaved:' + row.collection_id, Boolean(row.active)));
    if (!preferences.error && preferences.data?.settings) setLocal(context.user.id, 'settings', preferences.data.settings);
    if (!summary.error && summary.data) {
      const row = Array.isArray(summary.data) ? summary.data[0] : summary.data;
      setLocal(context.user.id, 'learningSummary', {
        totalSeconds: Number(row?.totalSeconds ?? row?.total_seconds) || 0,
        learningDays: Number(row?.learningDays ?? row?.learning_days) || 0,
        completedVideos: Number(row?.completedVideos ?? row?.completed_videos) || 0,
        masteredWords: Number(row?.masteredWords ?? row?.mastered_words) || 0
      });
    }
    window.dispatchEvent(new CustomEvent('eastudy:learning-hydrated', { detail: { userId: context.user.id, vocabularyLoaded: !vocabulary.error } }));
    void flushStudyOutbox();
    return context;
  }

  function normalizeMembership(row) {
    const expiresAt = row?.expires_at || row?.expiresAt || null;
    const revokedAt = row?.revoked_at || row?.revokedAt || null;
    return {
      productId: row?.product_id || row?.productId || 'eastudy_pro',
      expiresAt,
      revokedAt,
      active: Boolean(expiresAt && !revokedAt && Date.parse(expiresAt) > Date.now())
    };
  }

  async function getMembership() {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || !isLearnerProfile(context.profile)) {
      return { membership: null, error: context.error || new Error('STUDENT_REQUIRED') };
    }
    const result = await api.from('membership_entitlements')
      .select('product_id,expires_at,revoked_at,updated_at')
      .eq('user_id', context.user.id)
      .eq('product_id', 'eastudy_pro')
      .maybeSingle();
    if (result.error) return { membership: null, error: result.error };
    return { membership: result.data ? normalizeMembership(result.data) : null, error: null };
  }

  async function getLearningAccess() {
    const api = client('student');
    if (!api) return { access: null, error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data, error } = await api.rpc('get_my_learning_access_v2');
    return { access: data || null, error: error || null };
  }

  async function redeemMembership(code) {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || !isLearnerProfile(context.profile)) {
      return { membership: null, error: context.error || new Error('STUDENT_REQUIRED') };
    }
    const normalized = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!normalized) return { membership: null, error: new Error('INVALID_ACTIVATION_CODE') };
    const result = await api.rpc('redeem_activation_code', { p_code: normalized });
    if (result.error) return { membership: null, error: result.error };
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    return { membership: normalizeMembership(row), error: null };
  }

  async function getAdminAnalytics() {
    const api = client('admin');
    const context = await getContext('admin');
    if (!api || !context.user || context.profile?.role !== 'admin') return { error: new Error('ADMIN_REQUIRED') };
    const [users, active, events] = await Promise.all([
      api.from('profiles').select('*', { count: 'exact', head: true }).in('role', ['learner', 'student']).eq('is_active', true),
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

  async function generateInviteCodes(input = {}) {
    const api = client('admin');
    const context = await getContext('admin');
    if (!api || !context.user || context.profile?.role !== 'admin') {
      return { codes: [], error: new Error('ADMIN_REQUIRED') };
    }
    const durationDays = Math.max(1, Math.min(3660, Number(input.durationDays) || 30));
    const count = Math.max(1, Math.min(100, Number(input.count) || 1));
    const validUntil = input.validUntil ? new Date(input.validUntil).toISOString() : null;
    const { data, error } = await api.rpc('admin_generate_activation_codes_v3', {
      p_label: String(input.label || '邀请码注册').trim().slice(0, 100),
      p_duration_days: durationDays, p_count: count, p_valid_until: validUntil,
      p_channel: String(input.channel || '').trim().slice(0, 60)
    });
    return { batchId: data?.batchId || null, codes: Array.isArray(data?.codes) ? data.codes : [], error: error || null };
  }

  async function listInviteCodes(params = {}) {
    const api = client('admin');
    const context = await getContext('admin');
    if (!api || !context.user || context.profile?.role !== 'admin') throw new Error('ADMIN_REQUIRED');
    const { data, error } = await api.rpc('admin_list_activation_codes_v2', {
      p_query: String(params.query || '').trim().slice(0, 100),
      p_status: String(params.status || 'all'),
      p_page: Math.max(1, Number(params.page) || 1),
      p_page_size: Math.max(1, Math.min(100, Number(params.pageSize) || 25)),
      p_batch_id: params.batchId || null
    });
    if (error) throw error;
    if (!data || !Array.isArray(data.items) || !Array.isArray(data.batches) || !data.stats) {
      throw new Error('INVALID_INVITE_RESPONSE');
    }
    return { ...data, total: Number(data.total) || 0, page: Number(data.page) || 1, pageSize: Number(data.pageSize) || 25 };
  }

  async function revokeInviteCode(codeId, reason = '') {
    const api = client('admin');
    const context = await getContext('admin');
    if (!api || !context.user || context.profile?.role !== 'admin') throw new Error('ADMIN_REQUIRED');
    const { data, error } = await api.rpc('admin_revoke_activation_code_v1', {
      p_code_id: String(codeId || ''), p_reason: String(reason || '').trim().slice(0, 200)
    });
    if (error) throw error;
    return data;
  }

  async function setInviteBatchDisabled(batchId, disabled, reason = '') {
    const api = client('admin');
    const context = await getContext('admin');
    if (!api || !context.user || context.profile?.role !== 'admin') throw new Error('ADMIN_REQUIRED');
    const { data, error } = await api.rpc('admin_set_activation_batch_disabled_v1', {
      p_batch_id: String(batchId || ''), p_disabled: Boolean(disabled),
      p_reason: String(reason || '').trim().slice(0, 200)
    });
    if (error) throw error;
    return data;
  }

  async function reissueInviteCode(codeId, validUntil = null) {
    const api = client('admin');
    const context = await getContext('admin');
    if (!api || !context.user || context.profile?.role !== 'admin') throw new Error('ADMIN_REQUIRED');
    const until = validUntil ? new Date(validUntil).toISOString() : null;
    const { data, error } = await api.rpc('admin_reissue_activation_code_v2', {
      p_code_id: String(codeId || ''), p_valid_until: until
    });
    if (error) throw error;
    return data;
  }

  async function listLearners(params = {}) {
    const api = client('admin');
    const context = await getContext('admin');
    if (!api || !context.user || context.profile?.role !== 'admin') throw new Error('ADMIN_REQUIRED');
    const input = {
      p_query: String(params.query || '').trim(),
      p_status: String(params.status || 'all'),
      p_page: Math.max(1, Number(params.page) || 1),
      p_page_size: Math.max(1, Math.min(100, Number(params.pageSize) || 25)),
      p_user_id: params.userId || null
    };
    const { data, error } = await api.rpc('admin_list_learners_v1', input);
    if (error) throw error;
    if (!data || !Array.isArray(data.items) || !Number.isFinite(Number(data.total))) {
      throw new Error('INVALID_LEARNER_RESPONSE');
    }
    return { ...data, total: Number(data.total), page: Number(data.page), pageSize: Number(data.pageSize) };
  }

  async function getLearnerDetail(userId, options = {}) {
    const api = client('admin');
    const context = await getContext('admin');
    if (!api || !context.user || context.profile?.role !== 'admin') throw new Error('ADMIN_REQUIRED');
    const today = new Date(), from = new Date(today);
    from.setDate(from.getDate() - 29);
    const day = value => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
    const { data, error } = await api.rpc('admin_get_learner_detail_v1', {
      p_user_id: String(userId || ''),
      p_from: options.from || day(from),
      p_to: options.to || day(today),
      p_history_page: Math.max(1, Number(options.historyPage) || 1),
      p_page_size: Math.max(1, Math.min(100, Number(options.pageSize) || 25))
    });
    if (error) throw error;
    if (!data?.learner || !Array.isArray(data.daily) || !Array.isArray(data.history?.items)) {
      throw new Error('INVALID_LEARNER_DETAIL_RESPONSE');
    }
    return data;
  }

  function stopLearnerActivity() {
    if (stopActivityHeartbeat) stopActivityHeartbeat();
    stopActivityHeartbeat = null;
  }

  function startLearnerActivity(expectedUserId) {
    stopLearnerActivity();
    const api = client('student'), expected = String(expectedUserId || '');
    if (!api || !expected) return () => {};
    let stopped = false, pending = false, lastAttempt = -Infinity;
    async function touch() {
      if (stopped || pending || document.hidden || !navigator.onLine || performance.now() - lastAttempt < 60000) return;
      pending = true;
      lastAttempt = performance.now();
      try {
        const session = await api.auth.getSession();
        if (String(session.data?.session?.user?.id || '') !== expected) return;
        const result = await api.rpc('touch_my_activity_v1');
        if (result.error && !stopped) console.warn('Activity heartbeat failed', result.error.code || result.error.message);
      } finally { pending = false; }
    }
    const wake = () => { void touch().catch(() => {}); };
    const timer = globalThis.setInterval(wake, 60000);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    wake();
    stopActivityHeartbeat = () => {
      if (stopped) return;
      stopped = true;
      globalThis.clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
    return stopActivityHeartbeat;
  }

  window.addEventListener?.('online', () => { void flushStudyOutbox(); });
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (!document.hidden) void flushStudyOutbox(); });

  window.EastudyAuth = Object.freeze({ available, client, cleanPhone, isLearnerProfile, getRememberLogin, setRememberLogin, getContext, signInAccount, activateAndLogin, registerWithInvite, signInPhone, ensureStudentProfile, updatePassword, signOut });
  window.EastudyData = Object.freeze({ upsertProgress, recordStudyActivity, pendingStudyEvents, flushStudyOutbox, setFavorite, setVocabulary, setCreatorFollow, setCollectionSave, saveLearningPreferences, logStudyEvent, hydrateStudentLearning, getLearningGoalProfile, saveLearningGoalProfile, getMembership, getLearningAccess, redeemMembership, getAdminAnalytics, generateInviteCodes, listInviteCodes, revokeInviteCode, setInviteBatchDisabled, reissueInviteCode, listLearners, getLearnerDetail, startLearnerActivity, stopLearnerActivity });
})();
