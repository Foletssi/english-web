/* global supabase */
(function () {
  'use strict';

  const config = window.EASTUDY_SUPABASE_CONFIG || {};
  const available = Boolean(window.supabase && config.url && config.publishableKey);
  const clients = {};
  const empty = { user: null, session: null, profile: null, error: null };
  const REMEMBER_LOGIN_KEY = 'eastudy:student:remember-login';

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
    return ['learner', 'student'].includes(String(profile?.role || '').toLowerCase());
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
    const result = await api.auth.signInWithPassword({ phone, password: String(input.password || '') });
    if (!result.error && scope !== 'admin') void api.rpc('mark_my_password_set');
    return result;
  }

  async function sendPhoneOtp(input, scope) {
    const api = client(scope);
    const phone = cleanPhone(input.phone);
    const invalid = phoneError(phone);
    if (!api) return { data: null, error: new Error('SUPABASE_NOT_CONFIGURED') };
    if (invalid) return { data: null, error: new Error(invalid) };
    return api.auth.signInWithOtp({
      phone,
      options: {
        shouldCreateUser: input.shouldCreateUser !== false,
        data: { nickname: String(input.displayName || '').trim() || '新学员' }
      }
    });
  }

  async function verifyPhoneOtp(input, scope) {
    const api = client(scope);
    const phone = cleanPhone(input.phone);
    const invalid = phoneError(phone);
    const token = String(input.token || '').replace(/\D/g, '');
    if (!api) return { data: null, error: new Error('SUPABASE_NOT_CONFIGURED') };
    if (invalid) return { data: null, error: new Error(invalid) };
    if (!/^\d{6}$/.test(token)) return { data: null, error: new Error('INVALID_OTP') };
    const result = await api.auth.verifyOtp({ phone, token, type: 'sms' });
    if (!result.error && scope !== 'admin') void api.rpc('mark_my_phone_verified');
    return result;
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
    const result = await api.auth.updateUser({ password: next });
    if (result.error) return result;
    if (scope !== 'admin') await api.rpc('mark_my_password_set');
    return result;
  }

  async function signOut(scope) {
    const api = client(scope);
    if (api) await api.auth.signOut();
  }

  async function upsertProgress(input) {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || !isLearnerProfile(context.profile)) return { error: null };
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
    if (!api || !context.user || !isLearnerProfile(context.profile)) return { error: null };
    return input.active
      ? api.from('saved_sentences').upsert({ user_id: context.user.id, video_id: Number(input.videoId), sentence_index: Number(input.sentenceIndex), english: input.english || '', chinese: input.chinese || '' }, { onConflict: 'user_id,video_id,sentence_index' })
      : api.from('saved_sentences').delete().eq('user_id', context.user.id).eq('video_id', Number(input.videoId)).eq('sentence_index', Number(input.sentenceIndex));
  }

  async function setVocabulary(input) {
    const api = client('student');
    const context = await getContext('student');
    if (!api || !context.user || !isLearnerProfile(context.profile)) return { error: null };
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
    if (!api || !context.user || !isLearnerProfile(context.profile)) return { error: null };
    return api.from('study_events').insert({
      user_id: context.user.id,
      event_type: eventType,
      video_id: input?.videoId ? Number(input.videoId) : null,
      payload: input?.payload || {}
    });
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
    const [progress, favorites, vocabulary, learningGoal] = await Promise.all([
      api.from('user_progress').select('*').order('last_watched_at', { ascending: false }),
      api.from('saved_sentences').select('*'),
      api.from('user_vocabulary').select('*'),
      api.from('learner_goal_profiles').select('*').eq('user_id', context.user.id).maybeSingle()
    ]);
    if (!progress.error) {
      (progress.data || []).forEach(row => setLocal(context.user.id, 'progress:' + row.video_id, { time: row.position_seconds || 0, duration: row.duration_seconds || 0, percent: row.completion_percent || 0, completed: Boolean(row.completed_at), updatedAt: Date.parse(row.last_watched_at || '') || Date.now() }));
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
      vocabulary.data.forEach(row => {
        meta[row.word_key] = {
          state: row.state,
          addedAt: Date.parse(row.added_at || '') || Date.now(),
          lastReviewedAt: row.last_reviewed_at ? Date.parse(row.last_reviewed_at) : null,
          nextReviewAt: row.next_review_at ? Date.parse(row.next_review_at) : null,
          correctStreak: row.correct_streak || 0,
          sourceVideoId: null
        };
      });
      setLocal(context.user.id, 'vocabMeta', meta);
      setLocal(context.user.id, 'vocab', (vocabulary.data || []).map(row => row.word));
      setLocal(context.user.id, 'vocabRemoved', []);
    }
    if (!learningGoal.error && learningGoal.data) {
      setLocal(context.user.id, 'learningPlan', normalizeLearningGoalProfile(learningGoal.data));
    }
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

  window.EastudyAuth = Object.freeze({ available, client, cleanPhone, isLearnerProfile, getRememberLogin, setRememberLogin, getContext, signUpPhone, signInPhone, sendPhoneOtp, verifyPhoneOtp, ensureStudentProfile, updatePassword, signOut });
  window.EastudyData = Object.freeze({ upsertProgress, setFavorite, setVocabulary, logStudyEvent, hydrateStudentLearning, getLearningGoalProfile, saveLearningGoalProfile, getMembership, redeemMembership, getAdminAnalytics });
})();
