/* global fetch */
(function (global) {
  'use strict';

  const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
  const PART_BYTES = 8 * 1024 * 1024;

  function auth(scope) {
    return global.EastudyAuth?.client(scope);
  }

  async function sessionToken(scope) {
    const api = auth(scope);
    if (!api) throw new Error('SUPABASE_NOT_CONFIGURED');
    const { data, error } = await api.auth.getSession();
    if (error || !data.session?.access_token) throw error || new Error('AUTHENTICATION_REQUIRED');
    return data.session.access_token;
  }

  function firstRow(data) {
    return Array.isArray(data) ? data[0] || null : data || null;
  }

  async function pullPublished() {
    if(global.ZoContent?.localOnly)return {snapshot:null,revision:0,error:null};
    const api = auth('student');
    if (!api) return { snapshot: null, revision: 0, error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data, error } = await api.rpc('get_published_content');
    const row = firstRow(data);
    return { snapshot: row?.snapshot || null, revision: Number(row?.revision) || 0, publishedAt: row?.published_at || null, error: error || null };
  }

  async function pullAdmin() {
    if(global.ZoContent?.localOnly)return {snapshot:null,revision:0,error:null};
    const api = auth('admin');
    if (!api) return { snapshot: null, revision: 0, error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data, error } = await api.rpc('admin_get_content_snapshot');
    const row = firstRow(data);
    return { snapshot: row?.snapshot || null, revision: Number(row?.revision) || 0, updatedAt: row?.updated_at || null, error: error || null };
  }

  async function saveDraft(snapshot, expectedRevision) {
    if(global.ZoContent?.localOnly)return {error:new Error('LOCAL_CONTENT_CLOUD_WRITE_DISABLED')};
    const api = auth('admin');
    if (!api) return { error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data, error } = await api.rpc('admin_save_content_snapshot_v2', { p_snapshot: snapshot, p_expected_revision: Number(expectedRevision) });
    return { data: firstRow(data), error: error || null };
  }

  async function publish(snapshot, expectedRevision) {
    if(global.ZoContent?.localOnly)return {error:new Error('LOCAL_CONTENT_CLOUD_WRITE_DISABLED')};
    const api = auth('admin');
    if (!api) return { error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data, error } = await api.rpc('admin_publish_content_snapshot_v2', { p_snapshot: snapshot, p_expected_revision: Number(expectedRevision) });
    return { data: firstRow(data), error: error || null };
  }

  async function listTrash() {
    const api = auth('admin');
    if (!api) return { rows: [], error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data, error } = await api.rpc('admin_list_content_trash');
    return { rows: Array.isArray(data) ? data : [], error: error || null };
  }

  async function trashVideos(videoIds, expectedRevision) {
    const api = auth('admin');
    if (!api) return { error: new Error('SUPABASE_NOT_CONFIGURED') };
    const ids = [...new Set((videoIds || []).map(String).filter(Boolean))];
    const { data, error } = await api.rpc('admin_trash_content_videos', {
      p_video_ids: ids,
      p_expected_revision: Number(expectedRevision)
    });
    return { data: firstRow(data), error: error || null };
  }

  async function restoreVideo(videoId, expectedRevision) {
    const api = auth('admin');
    if (!api) return { error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data, error } = await api.rpc('admin_restore_content_video', {
      p_video_id: String(videoId),
      p_expected_revision: Number(expectedRevision)
    });
    return { data: firstRow(data), error: error || null };
  }

  async function syncMediaSession(scope) {
    const token = await sessionToken(scope === 'admin' ? 'admin' : 'student');
    const response = await fetch('/api/session', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    if (!response.ok) throw new Error('MEDIA_SESSION_FAILED');
    return true;
  }

  async function clearMediaSession() {
    await fetch('/api/session', { method: 'DELETE' }).catch(() => {});
  }

  async function apiRequest(path, init) {
    const token = await sessionToken('admin');
    const headers = new Headers(init?.headers || {});
    headers.set('Authorization', 'Bearer ' + token);
    const response = await fetch(path, { ...init, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || ('UPLOAD_HTTP_' + response.status));
    return payload;
  }

  async function uploadVideo(file, onProgress) {
    if (!(file instanceof File)) throw new Error('VIDEO_FILE_REQUIRED');
    if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('VIDEO_FILE_SIZE_INVALID');
    const started = await apiRequest('/api/admin/uploads/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, type: file.type || 'application/octet-stream' })
    });
    const parts = [];
    try {
      let uploaded = 0;
      for (let offset = 0, partNumber = 1; offset < file.size; offset += PART_BYTES, partNumber += 1) {
        const chunk = file.slice(offset, Math.min(file.size, offset + PART_BYTES));
        const result = await apiRequest('/api/admin/uploads/part?key=' + encodeURIComponent(started.key) + '&uploadId=' + encodeURIComponent(started.uploadId) + '&part=' + partNumber, {
          method: 'PUT', body: chunk, headers: { 'Content-Type': 'application/octet-stream' }
        });
        parts.push({ partNumber, etag: result.etag });
        uploaded += chunk.size;
        if (onProgress) onProgress(Math.round(uploaded / file.size * 100));
      }
      await apiRequest('/api/admin/uploads/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: started.key, uploadId: started.uploadId, parts })
      });
      return { key: started.key, url: '/api/media?key=' + encodeURIComponent(started.key), size: file.size, type: file.type };
    } catch (error) {
      void apiRequest('/api/admin/uploads/abort', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: started.key, uploadId: started.uploadId })
      }).catch(() => {});
      throw error;
    }
  }

  global.EastudyCloudContent = Object.freeze({ pullPublished, pullAdmin, saveDraft, publish, listTrash, trashVideos, restoreVideo, syncMediaSession, clearMediaSession, uploadVideo });
})(window);
