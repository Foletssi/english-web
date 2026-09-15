/* global fetch */
(function (global) {
  'use strict';

  const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
  const PART_BYTES = 8 * 1024 * 1024;
  const mediaSessions = Object.create(null);
  const mediaSessionRequests = Object.create(null);
  const mediaSessionTimers = { student: null, admin: null };
  const activeMediaSessionKeys = { student: '', admin: '' };
  const mediaSessionGeneration = { student: 0, admin: 0 };
  const usedMediaJobIds = new Set();

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

  async function publishEntity(entityType, entity, expectedRevision) {
    if(global.ZoContent?.localOnly)return {error:new Error('LOCAL_CONTENT_CLOUD_WRITE_DISABLED')};
    const api=auth('admin');
    if(!api)return {error:new Error('SUPABASE_NOT_CONFIGURED')};
    const {data,error}=await api.rpc('admin_publish_content_entity_v3',{
      p_entity_type:String(entityType||''),p_entity:entity||{},p_expected_revision:Number(expectedRevision)
    });
    return {data:firstRow(data),error:error||null};
  }

  async function setCreatorStatus(creatorId, status, replacementId, expectedRevision) {
    if(global.ZoContent?.localOnly)return {error:new Error('LOCAL_CONTENT_CLOUD_WRITE_DISABLED')};
    const api=auth('admin');
    if(!api)return {error:new Error('SUPABASE_NOT_CONFIGURED')};
    const {data,error}=await api.rpc('admin_set_creator_status_v1',{
      p_creator_id:String(creatorId),p_status:String(status),p_replacement_id:replacementId?String(replacementId):null,p_expected_revision:Number(expectedRevision)
    });
    return {data:firstRow(data),error:error||null};
  }

  async function setVideoPublication(videoId, status, expectedRevision) {
    if(global.ZoContent?.localOnly)return {error:new Error('LOCAL_CONTENT_CLOUD_WRITE_DISABLED')};
    const api=auth('admin');
    if(!api)return {error:new Error('SUPABASE_NOT_CONFIGURED')};
    const {data,error}=await api.rpc('admin_set_video_publication_v4',{
      p_video_id:String(videoId||''),p_status:String(status||''),p_expected_revision:Number(expectedRevision)
    });
    return {data:firstRow(data),error:error||null};
  }

  async function createLearningRepair(videoId, expectedRevision, mode = 'fill_missing') {
    if(global.ZoContent?.localOnly)return {error:new Error('LOCAL_CONTENT_CLOUD_WRITE_DISABLED')};
    const api=auth('admin');
    if(!api)return {error:new Error('SUPABASE_NOT_CONFIGURED')};
    const {data,error}=await api.rpc('admin_create_learning_repair_job_v5',{
      p_video_id:String(videoId||''),p_expected_revision:Number(expectedRevision),p_mode:String(mode||'fill_missing')
    });
    return {data:firstRow(data),error:error||null};
  }

  async function listTrash() {
    const api = auth('admin');
    if (!api) return { rows: [], error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data, error } = await api.rpc('admin_list_content_trash_v2');
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

  async function planPermanentVideoDeletion(videoId, expectedRevision) {
    return apiRequest('/api/admin/video-deletions/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: String(videoId), expectedRevision: Number(expectedRevision) })
    });
  }

  async function confirmPermanentVideoDeletion(planId, expectedRevision) {
    return apiRequest('/api/admin/video-deletions/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: String(planId), expectedRevision: Number(expectedRevision), confirmation: 'PERMANENT_DELETE' })
    });
  }

  async function getVideoDeletion(deletionId) {
    return apiRequest('/api/admin/video-deletions/status?id=' + encodeURIComponent(deletionId), { method: 'GET' });
  }

  async function processingHealth() {
    try {
      const response = await fetch('https://ehxqtgakjgqgmghhdmjg.supabase.co/functions/v1/video-processing', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      return { data, error: response.ok ? null : new Error(data.error || ('PROCESSING_HEALTH_' + response.status)) };
    } catch (error) {
      return { data: null, error };
    }
  }

  async function createProcessingJob(video, sourceKey, idempotencyKey, expectedRevision) {
    const api = auth('admin');
    if (!api) return { error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data, error } = await api.rpc('admin_create_processing_job', {
      p_video: video, p_source_key: sourceKey, p_idempotency_key: idempotencyKey,
      p_expected_revision: Number(expectedRevision)
    });
    return { data: firstRow(data), error: error || null };
  }

  function normalizeProcessingJob(job) {
    job={...job,videoId:job.videoId??job.video_id,type:job.type||job.input?.kind||'CLOUD_PIPELINE',inputTitle:job.inputTitle||job.input?.title||job.input?.titleZh,
      createdAt:job.createdAt||job.created_at,updatedAt:job.updatedAt||job.updated_at,completedAt:job.completedAt||job.completed_at,
      lastHeartbeatAt:job.lastHeartbeatAt||job.last_heartbeat_at,lastProgressAt:job.lastProgressAt||job.last_progress_at,
      stageStartedAt:job.stageStartedAt||job.stage_started_at,attemptStartedAt:job.attemptStartedAt||job.attempt_started_at,
      leaseUntil:job.leaseUntil||job.lease_until,nextRunAt:job.nextRunAt||job.next_run_at,telemetry:job.telemetry||job.work?.telemetry};
    const stageStep = { LOCAL_DOWNLOAD: 'download', PROBE: 'probe', TRANSCODE: 'transcode', ASR: 'asr', ENRICH: 'enrich', LOCAL_UPLOAD: 'output', REVIEW: 'review' };
    const learningRepair=job.type==='LEARNING_REPAIR',mediaOnly=job.type==='MEDIA_REENCODE',order=learningRepair?['enrich','review']:mediaOnly?['download','probe','transcode','output']:['download','probe','transcode','asr','enrich','output','review'];
    const currentStep = mediaOnly&&job.stage==='REVIEW'?'output':stageStep[job.stage] || (learningRepair?'enrich':'download');
    const current = order.indexOf(currentStep);
    const status = String(job.status || 'WAITING').toUpperCase();
    const telemetry = job.telemetry && typeof job.telemetry === 'object' ? job.telemetry : {};
    return { ...job, ...telemetry, telemetry, videoId: Number(job.videoId), rawStatus: status, status, currentStep,
      steps: order.map((step, index) => [step, mediaOnly&&status==='REVIEW'||index < current ? 'SUCCESS' : index === current ? (status === 'ERROR' ? 'ERROR' : status === 'REVIEW' || status === 'QUEUED' || status === 'WAITING' ? 'WAITING' : 'RUNNING') : 'WAITING']) };
  }

  async function listProcessingJobs(page = 1, pageSize = 50) {
    const api = auth('admin');
    if (!api) return { rows: [], error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data, error } = await api.rpc('admin_list_processing_video_groups_v1', {
      p_page: Math.max(1, Number(page) || 1), p_page_size: Math.max(1, Math.min(100, Number(pageSize) || 50))
    });
    if (error) return { rows: [], groups: [], error };
    if (!data || !Array.isArray(data.items)) return { rows: [], groups: [], error: new Error('INVALID_PROCESSING_GROUP_RESPONSE') };
    const groups=data.items.map(group=>{
      const records=(Array.isArray(group.records)?group.records:[]).map(normalizeProcessingJob);
      const current=records.find(job=>['RUNNING','QUEUED','WAITING'].includes(job.rawStatus))||records.find(job=>job.rawStatus!=='CANCELLED')||records[0]||null;
      return {videoId:String(group.videoId),video:group.video||null,recordCount:Number(group.recordCount)||records.length,current,records};
    }).filter(group=>group.current);
    const keys=['active','failed','review','completed','cancelled','total'];
    const summary=data.summary&&keys.every(key=>Number.isSafeInteger(data.summary[key])&&data.summary[key]>=0)&&keys.slice(0,5).reduce((n,key)=>n+data.summary[key],0)===data.summary.total?data.summary:null;
    return { summary, rows: groups.flatMap(group=>group.records), groups, total:Number(data.total)||0, page:Number(data.page)||1, pageSize:Number(data.pageSize)||50, error:null };
  }

  async function listProcessingHistory(videoId, page = 1, pageSize = 25) {
    const api=auth('admin');
    if(!api)throw new Error('SUPABASE_NOT_CONFIGURED');
    const {data,error}=await api.rpc('admin_list_processing_video_history_v1',{p_video_id:String(videoId),p_page:Math.max(1,Number(page)||1),p_page_size:Math.max(1,Math.min(100,Number(pageSize)||25))});
    if(error)throw error;
    if(!data||!Array.isArray(data.items))throw new Error('INVALID_PROCESSING_HISTORY_RESPONSE');
    return {rows:data.items.map(normalizeProcessingJob),total:Number(data.total)||0,page:Number(data.page)||1,pageSize:Number(data.pageSize)||25};
  }

  async function getProcessingJob(jobId) {
    const api=auth('admin');
    if(!api)throw new Error('SUPABASE_NOT_CONFIGURED');
    const {data,error}=await api.rpc('admin_get_processing_job_v1',{p_job_id:String(jobId)});
    if(error)throw error;
    if(!data?.id)throw new Error('INVALID_PROCESSING_JOB_RESPONSE');
    return normalizeProcessingJob(data);
  }

  async function retryProcessingJob(jobId) {
    const api = auth('admin');
    if (!api) return { error: new Error('SUPABASE_NOT_CONFIGURED') };
    const { data, error } = await api.rpc('admin_retry_processing_job', { p_job_id: jobId });
    return { data: firstRow(data), error: error || null };
  }

  async function syncMediaSession(scope, options = {}) {
    const key=scope === 'admin' ? 'admin' : 'student';
    const api=auth(key);
    if(!api)throw new Error('SUPABASE_NOT_CONFIGURED');
    const {data,error}=await api.auth.getSession();
    const session=data?.session;
    if(error||!session?.access_token)throw error||new Error('AUTHENTICATION_REQUIRED');
    const match=String(options.mediaUrl||'').match(/\/api\/processing\/media\/([0-9a-f-]{36})\//i),jobId=match?.[1]||'';
    const identity=String(session.user?.id||'session'),cacheKey=key+':'+identity+':'+jobId,now=Math.floor(Date.now()/1000),cached=mediaSessions[cacheKey];
    if(activeMediaSessionKeys[key]!==cacheKey){activeMediaSessionKeys[key]=cacheKey;mediaSessionGeneration[key]+=1;clearTimeout(mediaSessionTimers[key]);mediaSessionTimers[key]=null}
    const ownGeneration=mediaSessionGeneration[key];
    if(!options.force&&cached?.token===session.access_token&&cached.expiresAt-now>60)return {expiresAt:cached.expiresAt,jobId};
    if(mediaSessionRequests[cacheKey])return mediaSessionRequests[cacheKey];
    const token=session.access_token;
    const request=(async()=>{
      const response = await fetch('/api/session', { method: 'POST', headers: { Authorization: 'Bearer ' + token,'Content-Type':'application/json' },body:JSON.stringify({jobId:jobId||null}),signal:options.signal });
      if(!response.ok){const payload=await response.json().catch(()=>({})),failure=new Error(payload.error||('MEDIA_SESSION_HTTP_'+response.status));failure.stage='session';failure.status=response.status;throw failure}
      const payload=await response.json().catch(()=>({})),expiresAt=Number(payload.expiresAt)||Number(session.expires_at)||now+300;
      if(jobId)usedMediaJobIds.add(jobId);
      if(ownGeneration!==mediaSessionGeneration[key]||activeMediaSessionKeys[key]!==cacheKey)return {expiresAt,jobId,stale:true};
      mediaSessions[cacheKey]={token,expiresAt};
      if(jobId){
        clearTimeout(mediaSessionTimers[key]);
        const remaining=expiresAt*1000-Date.now(),renew=remaining>60000;
        const delay=Math.max(1000,renew?remaining-60000:remaining+1000);
        mediaSessionTimers[key]=setTimeout(()=>{mediaSessionTimers[key]=null;if(ownGeneration!==mediaSessionGeneration[key]||activeMediaSessionKeys[key]!==cacheKey)return;if(!renew){if(typeof global.dispatchEvent==='function'&&typeof global.CustomEvent==='function')global.dispatchEvent(new global.CustomEvent('eastudy:media-session-error',{detail:{scope:key,jobId,error:'VIP_EXPIRED'}}));return}syncMediaSession(key,{mediaUrl:options.mediaUrl,force:true,background:true}).catch(error=>{if(typeof global.dispatchEvent==='function'&&typeof global.CustomEvent==='function')global.dispatchEvent(new global.CustomEvent('eastudy:media-session-error',{detail:{scope:key,jobId,error:error?.message||'PLAYBACK_AUTH_UNAVAILABLE'}}))})},delay);
      }
      return {expiresAt,jobId};
    })();
    mediaSessionRequests[cacheKey]=request;
    try{return await request}finally{if(mediaSessionRequests[cacheKey]===request)delete mediaSessionRequests[cacheKey]}
  }

  async function clearMediaSession(waitMs = 1500) {
    const pending=Object.values(mediaSessionRequests);
    for(const key of ['student','admin']){mediaSessionGeneration[key]+=1;clearTimeout(mediaSessionTimers[key]);mediaSessionTimers[key]=null;activeMediaSessionKeys[key]=''}
    const pendingSettled=Promise.allSettled(pending);
    let pendingFinished=true,timer=null;
    if(pending.length)pendingFinished=await Promise.race([pendingSettled.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),Math.max(0,Number(waitMs)||0))})]);
    clearTimeout(timer);
    Object.keys(mediaSessions).forEach(key=>{delete mediaSessions[key]});
    Object.keys(mediaSessionRequests).forEach(key=>{delete mediaSessionRequests[key]});
    const jobIds=[...usedMediaJobIds];usedMediaJobIds.clear();
    const clearCookie=()=>fetch('/api/session', { method: 'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobIds}) }).catch(() => {});
    await clearCookie();
    if(!pendingFinished)void pendingSettled.then(clearCookie);
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

  async function uploadCreatorAvatar(file) {
    if (!(file instanceof Blob) || !file.size) throw new Error('CREATOR_AVATAR_REQUIRED');
    if (file.size > 512 * 1024 || file.type !== 'image/webp') throw new Error('CREATOR_AVATAR_INVALID');
    const payload = await apiRequest('/api/admin/creator-avatars', {
      method: 'POST', body: file, headers: { 'Content-Type': 'image/webp' }
    });
    return { key: payload.key, url: payload.url, size: Number(payload.size) || file.size, type: 'image/webp' };
  }

  global.EastudyCloudContent = Object.freeze({ pullPublished, pullAdmin, saveDraft, publish, publishEntity, setCreatorStatus, setVideoPublication, createLearningRepair, listTrash, trashVideos, restoreVideo,planPermanentVideoDeletion,confirmPermanentVideoDeletion,getVideoDeletion,
    processingHealth, createProcessingJob, listProcessingJobs, listProcessingHistory, getProcessingJob, retryProcessingJob,
    syncMediaSession, clearMediaSession, uploadVideo, uploadCreatorAvatar });
})(window);
