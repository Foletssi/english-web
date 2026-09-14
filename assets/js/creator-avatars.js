/* Private creator images: authenticated requests, account-scoped memory only. */
(function (global) {
  'use strict';
  const entries = new Map();
  const retries = new Set();
  let owner = '', generation = 0;

  function clear() {
    generation++;
    for (const timer of retries) clearTimeout(timer);
    retries.clear();
    for (const entry of entries.values()) {
      entry.controller.abort();
      if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    }
    entries.clear();
    owner = '';
    document.querySelectorAll('img[data-avatar-src]').forEach(img => {
      img.removeAttribute('src'); img.hidden = true;
      delete img.dataset.avatarLoading;
      delete img.dataset.avatarAttempts;
      if (img.nextElementSibling) img.nextElementSibling.hidden = false;
    });
  }

  async function hydrateOne(img) {
    if (img.dataset.avatarLoading) return;
    img.dataset.avatarLoading = 'true';
    let epoch = generation;
    const failed = () => {
      if (epoch !== generation || !img.isConnected) return;
      img.hidden = true;
      if (img.nextElementSibling) img.nextElementSibling.hidden = false;
      const attempt = Number(img.dataset.avatarAttempts || 0);
      if (attempt >= 2) return;
      img.dataset.avatarAttempts = String(attempt + 1);
      const timer = setTimeout(() => {
        retries.delete(timer);
        if (epoch !== generation || !img.isConnected) return;
        delete img.dataset.avatarLoading;
        void hydrateOne(img);
      }, attempt ? 3000 : 1000);
      retries.add(timer);
    };
    try {
      const url = new URL(img.dataset.avatarSrc, location.href);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('AVATAR_URL_INVALID');
      let src = url.href;
      if (url.origin === location.origin && url.pathname.startsWith('/api/creator-avatars/')) {
        const api = global.EastudyAuth?.client?.('student');
        const result = await api?.auth.getSession();
        const session = result?.data?.session;
        if (epoch !== generation) return;
        if (result?.error || !session?.access_token || !session.user?.id) throw new Error('AUTHENTICATION_REQUIRED');
        if (owner && owner !== session.user.id) clear();
        owner = session.user.id; epoch = generation;
        const key = owner + ':' + src;
        let entry = entries.get(key);
        if (!entry) {
          entry = { controller: new AbortController(), objectUrl: null };
          entries.set(key, entry);
          entry.promise = (async () => {
            const timer = setTimeout(() => entry.controller.abort(), 15000);
            try {
              const response = await fetch(src, { headers: { Authorization: 'Bearer ' + session.access_token }, cache: 'no-store', signal: entry.controller.signal });
              if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('AVATAR_UNAVAILABLE');
              const blob = await response.blob();
              if (epoch !== generation) throw new Error('AVATAR_SESSION_CHANGED');
              entry.objectUrl = URL.createObjectURL(blob);
              return entry.objectUrl;
            } finally { clearTimeout(timer); }
          })().catch(error => {
            if (entries.get(key) === entry) entries.delete(key);
            throw error;
          });
        }
        src = await entry.promise;
      }
      if (epoch !== generation || !img.isConnected) return;
      img.onload = () => { if (epoch === generation) { img.hidden = false; if (img.nextElementSibling) img.nextElementSibling.hidden = true; } };
      img.onerror = failed;
      img.src = src;
    } catch (_) {
      failed();
    }
  }
  function hydrate(root = document) { root.querySelectorAll('img[data-avatar-src]').forEach(img => void hydrateOne(img)); }
  global.addEventListener('pagehide', clear);
  global.addEventListener('pageshow', () => hydrate());
  global.EastudyAvatars = Object.freeze({ hydrate, clear });
})(window);
