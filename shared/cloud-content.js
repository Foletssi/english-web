/* global fetch */
(function (global) {
  'use strict';

  const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
  const PART_BYTES = 8 * 1024 * 1024;
  const mediaSessions = Object.create(null);
  const mediaSessionRequests = Object.create(null);
  const mediaSessionTimers = Object.create(null);
  const activeMediaSessionKeys = Object.create(null);
  const mediaSessionGeneration = Object.create(null);
  let mediaSessionCleanup = Promise.resolve(), cleanupGeneration = 0;
  const usedMediaJobIds = new Set();
  const publishedRequests = new Map();
  const publishedCache = new Map();
  const teachingRequests = new Map();
  const teachingCache = new Map();

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
    const session = await api.auth.getSession();
    const owner = session.data?.session?.user?.id;
    if (session.error || !owner) return { snapshot: null, error: session.error || new Error('AUTH_REQUIRED') };
    if (publishedRequests.has(owner)) return publishedRequests.get(owner);
    const request = (async () => {
      const key = 'eastudy:published:catalog:v2:' + owner;
      let cached = publishedCache.get(owner);
      try { cached ||= JSON.parse(global.localStorage?.getItem(key) || 'null'); } catch (_) {}
      if (!cached?.snapshot || !Number.isSafeInteger(cached.revision)) cached = null;
      const query = api.rpc('get_published_catalog_if_changed_v2', { p_known_revision: cached?.revision ?? null });
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null;
      let result;
      try { result = await (controller && typeof query.abortSignal === 'function' ? query.abortSignal(controller.signal) : query); }
      finally { clearTimeout(timeout); }
      const { data, error } = result;
      const current = await api.auth.getSession();
      if (current.data?.session?.user?.id !== owner) return { snapshot: null, error: new Error('ACCOUNT_CHANGED') };
      if (error) { publishedCache.delete(owner); try { global.localStorage?.removeItem(key); } catch (_) {} return { snapshot: null, error }; }
      const row = firstRow(data), snapshot = row?.snapshot || (cached && Number(row?.revision) === cached.revision ? cached.snapshot : null);
      if (!snapshot) return { snapshot: null, error: new Error('CONTENT_SNAPSHOT_MISSING') };
      const value = { snapshot, revision: Number(row.revision), publishedAt: row.published_at || null };
      if (publishedCache.get(owner)?.revision !== value.revision) teachingCache.clear();
      publishedCache.set(owner, value);
      if (row.snapshot) try { global.localStorage?.setItem(key, JSON.stringify(value)); } catch (_) {}
      return { ...value, error: null };
    })().catch(error => ({ snapshot: null, error }));
    publishedRequests.set(owner, request);
    try { return await request; } finally { if (publishedRequests.get(owner) === request) publishedRequests.delete(owner); }
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

  async function pullVideoTeaching(videoId) {
    const id = String(videoId || '');
    if (global.ZoContent?.localOnly) return { videoId: id, video: global.ZoContent.getVideo(id),
      sentences: global.ZoContent.listSentences(id), revision: null, error: null };
    const api = auth('student');
    if (!api) return { error: new Error('SUPABASE_NOT_CONFIGURED') };
    const session = await api.auth.getSession(), owner = session.data?.session?.user?.id;
    if (session.error || !owner) return { error: session.error || new Error('AUTH_REQUIRED') };
    const revision = publishedCache.get(owner)?.revision;
    const key = owner + ':' + id + ':' + revision;
    if (teachingRequests.has(key)) return teachingRequests.get(key);
    const request = (async () => {
      const cached = teachingCache.get(key);
      // Even a cache hit rechecks membership and publication on the server.
      const query = api.rpc('get_published_video_teaching_v1', {
        p_video_id: id, p_known_revision: cached?.revision ?? null });
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeout = controller ? setTimeout(() => controller.abort(), 15000) : null;
      let result;
      try { result = await (controller && typeof query.abortSignal === 'function' ? query.abortSignal(controller.signal) : query); }
      finally { clearTimeout(timeout); }
      const current = await api.auth.getSession();
      if (current.data?.session?.user?.id !== owner) return { error: new Error('ACCOUNT_CHANGED') };
      if (result.error) { teachingCache.delete(key); return { error: result.error }; }
      const row = firstRow(result.data);
      const value = row?.video ? { videoId: id, video: row.video, sentences: row.sentences,
        revision: Number(row.revision), error: null } : cached?.revision === Number(row?.revision) ? cached : null;
      if (!value || String(value.video?.id) !== id || !Array.isArray(value.sentences))
        return { error: new Error('VIDEO_TEACHING_MISSING') };
      const catalogRevision = publishedCache.get(owner)?.revision;
      if (Number.isSafeInteger(catalogRevision) && value.revision !== catalogRevision)
        return { error: new Error('CONTENT_REVISION_CONFLICT') };
      teachingCache.set(key, value);
      while (teachingCache.size > 3) teachingCache.delete(teachingCache.keys().next().value);
      return value;
    })().catch(error => ({ error }));
    teachingRequests.set(key, request);
    try { return await request; } finally { if (teachingRequests.get(key) === request) teachingRequests.delete(key); }
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

  async function getVideoDeletionCapability() {
    return apiRequest('/api/admin/video-deletions/capability', { method: 'GET' });
  }

  async function retryVideoDeletion(deletionId) {
    return apiRequest('/api/admin/video-deletions/retry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deletionId: String(deletionId) })
    });
  }

  async function processingHealth() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('https://ehxqtgakjgqgmghhdmjg.supabase.co/functions/v1/video-processing', { cache: 'no-store', signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      return { data, error: response.ok ? null : new Error(data.error || ('PROCESSING_HEALTH_' + response.status)) };
    } catch (error) {
      return { data: null, error };
    } finally {
      clearTimeout(timeout);
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

  async function reserveLocalProcessingJob(input, expectedRevision) {
    const api = auth('admin');
    if (!api) return {error: new Error('SUPABASE_NOT_CONFIGURED')};
    const {data, error} = await api.rpc('admin_reserve_local_processing_job_v1', {
      p_video: input.video, p_source: input.source, p_worker_id: input.workerId,
      p_challenge: input.challenge, p_origin: input.origin,
      p_request_id: input.requestId, p_expected_revision: Number(expectedRevision)
    });
    return {data: firstRow(data), error: error || null};
  }

  async function localProcessingCapability() {
    const api=auth('admin');
    if(!api)return {error:new Error('SUPABASE_NOT_CONFIGURED')};
    const {data,error}=await api.rpc('admin_local_processing_capability_v1');
    return {data:firstRow(data),error:error||null};
  }
  async function getLocalProcessingInput(jobId) {
    const api=auth('admin');
    if(!api)throw new Error('SUPABASE_NOT_CONFIGURED');
    const {data,error}=await api.rpc('admin_get_local_processing_input_v1',{p_job_id:jobId});
    if(error)throw error;
    return firstRow(data);
  }
  async function recoverLocalProcessingInput(input) {
    const api=auth('admin');
    if(!api)return {error:new Error('SUPABASE_NOT_CONFIGURED')};
    const {data,error}=await api.rpc('admin_recover_local_processing_input_v1',{
      p_job_id:input.jobId,p_source:input.source,p_worker_id:input.workerId,
      p_challenge:input.challenge,p_origin:input.origin
    });
    return {data:firstRow(data),error:error||null};
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
      const current=selectCurrentProcessingJob(records,group.video);
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
    await mediaSessionCleanup;
    const startingGeneration=cleanupGeneration;
    const key=scope === 'admin' ? 'admin' : 'student';
    const api=auth(key);
    if(!api)throw new Error('SUPABASE_NOT_CONFIGURED');
    const {data,error}=await api.auth.getSession();
    if(startingGeneration!==cleanupGeneration)throw new Error('ACCOUNT_CHANGED');
    const session=data?.session;
    if(error||!session?.access_token)throw error||new Error('AUTHENTICATION_REQUIRED');
    const match=String(options.mediaUrl||'').match(/\/api\/processing\/media\/([0-9a-f-]{36})\//i),jobId=match?.[1]||'';
    const identity=String(session.user?.id||'session'),lane=key+':'+(jobId?'playback':'catalog'),cacheKey=key+':'+identity+':'+jobId,now=Math.floor(Date.now()/1000),cached=mediaSessions[cacheKey];
    if(activeMediaSessionKeys[lane]!==cacheKey){activeMediaSessionKeys[lane]=cacheKey;mediaSessionGeneration[lane]=(mediaSessionGeneration[lane]||0)+1;clearTimeout(mediaSessionTimers[lane]);mediaSessionTimers[lane]=null}
    const ownGeneration=mediaSessionGeneration[lane];
    if(!options.force&&cached?.token===session.access_token&&cached.expiresAt-now>60)return {expiresAt:cached.expiresAt,jobId};
    if(mediaSessionRequests[cacheKey])return mediaSessionRequests[cacheKey];
    const token=session.access_token;
    const request=(async()=>{
      const controller=typeof AbortController==='function'?new AbortController():null;
      const abort=()=>controller?.abort();
      if(options.signal?.aborted)abort();
      options.signal?.addEventListener('abort',abort,{once:true});
      const timeout=controller?setTimeout(abort,12000):null;
      let response,payload;
      try{
        // Track before dispatch: even an aborted/late response may set a job cookie.
        if(jobId)usedMediaJobIds.add(jobId);
        response=await fetch('/api/session', { method: 'POST', headers: { Authorization: 'Bearer ' + token,'Content-Type':'application/json' },body:JSON.stringify({jobId:jobId||null}),signal:controller?.signal||options.signal });
        payload=await response.json();
      }
      finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',abort)}
      if(!response.ok){const failure=new Error(payload.error||('MEDIA_SESSION_HTTP_'+response.status));failure.stage='session';failure.status=response.status;throw failure}
      const expiresAt=Number(payload.expiresAt)||Number(session.expires_at)||now+300;
      if(ownGeneration!==mediaSessionGeneration[lane]||activeMediaSessionKeys[lane]!==cacheKey)return {expiresAt,jobId,stale:true};
      mediaSessions[cacheKey]={token,expiresAt};
      {
        clearTimeout(mediaSessionTimers[lane]);
        const remaining=expiresAt*1000-Date.now(),renew=remaining>60000;
        const delay=Math.max(1000,renew?remaining-60000:remaining+1000);
        mediaSessionTimers[lane]=setTimeout(()=>{mediaSessionTimers[lane]=null;if(ownGeneration!==mediaSessionGeneration[lane]||activeMediaSessionKeys[lane]!==cacheKey)return;if(!renew){if(typeof global.dispatchEvent==='function'&&typeof global.CustomEvent==='function')global.dispatchEvent(new global.CustomEvent('eastudy:media-session-error',{detail:{scope:key,jobId,error:'VIP_EXPIRED'}}));return}syncMediaSession(key,{mediaUrl:options.mediaUrl,force:true,background:true}).catch(error=>{if(typeof global.dispatchEvent==='function'&&typeof global.CustomEvent==='function')global.dispatchEvent(new global.CustomEvent('eastudy:media-session-error',{detail:{scope:key,jobId,error:error?.message||'PLAYBACK_AUTH_UNAVAILABLE'}}))})},delay);
      }
      return {expiresAt,jobId};
    })();
    mediaSessionRequests[cacheKey]=request;
    try{return await request}finally{if(mediaSessionRequests[cacheKey]===request)delete mediaSessionRequests[cacheKey]}
  }

  async function clearMediaSession(waitMs = 1500) {
    cleanupGeneration++;
    teachingCache.clear();
    global.ZoContent?.clearVideoTeaching?.();
    const pending=Object.values(mediaSessionRequests);
    for(const key of Object.keys(activeMediaSessionKeys)){mediaSessionGeneration[key]=(mediaSessionGeneration[key]||0)+1;clearTimeout(mediaSessionTimers[key]);mediaSessionTimers[key]=null;activeMediaSessionKeys[key]=''}
    const previousCleanup=mediaSessionCleanup;
    let releaseCleanup;
    mediaSessionCleanup=new Promise(resolve=>{releaseCleanup=resolve});
    const pendingSettled=Promise.allSettled([previousCleanup,...pending]);
    let pendingFinished=true,timer=null;
    pendingFinished=await Promise.race([pendingSettled.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),Math.max(0,Number(waitMs)||0))})]);
    clearTimeout(timer);
    Object.keys(mediaSessions).forEach(key=>{delete mediaSessions[key]});
    Object.keys(mediaSessionRequests).forEach(key=>{delete mediaSessionRequests[key]});
    const jobIds=[...usedMediaJobIds];usedMediaJobIds.clear();
    const clearCookie=async()=>{
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
      try{await fetch('/api/session', { method: 'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobIds}),signal:controller.signal })}
      catch{/* Local logout still completes offline; cookies are short-lived and server-authorized. */}
      finally{clearTimeout(timeout)}
    };
    await clearCookie();
    if(!pendingFinished)void pendingSettled.then(clearCookie).finally(releaseCleanup);
    else releaseCleanup();
  }

  async function controlProcessingJob(command) {
    const api=auth('admin');
    if(!api)return {error:new Error('SUPABASE_NOT_CONFIGURED')};
    return api.rpc('admin_control_processing_job_v1',{
      p_job_id:command.id,p_expected_run_id:command.runId||null,
      p_expected_updated_at:command.updatedAt,p_action:command.action,p_request_id:command.requestId
    });
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

  async function uploadVideo(file, onProgress, onPhase) {
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
      const receipt = await apiRequest('/api/admin/uploads/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: started.key, uploadId: started.uploadId, parts })
      });
      // A local optimization must never turn a durable cloud upload into a failure.
      onPhase?.('正在保存本机原片副本');
      let localSourceSaved=false;
      try { localSourceSaved=Boolean(await global.EastudyLocalSource?.preserve(file,receipt)); } catch {}
      onPhase?.('正在创建云端任务');
      return { key: started.key, url: '/api/media?key=' + encodeURIComponent(started.key), size: file.size, type: file.type, localSourceSaved };
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

  function selectCurrentProcessingJob(records,video){
    const ids=[video?.processingJobId,video?.learningRepairJobId].filter(Boolean).map(String);
    const active=job=>['RUNNING','QUEUED','WAITING'].includes(job.rawStatus||job.status);
    const date=job=>Date.parse(job.updatedAt||job.updated_at||job.createdAt||job.created_at||'')||0;
    return [...records].sort((a,b)=>Number(ids.includes(String(b.id)))-Number(ids.includes(String(a.id)))||Number(active(b))-Number(active(a))||date(b)-date(a)||String(a.id).localeCompare(String(b.id)))[0]||null;
  }

  global.EastudyCloudContent = Object.freeze({ selectCurrentProcessingJob, pullPublished, pullVideoTeaching, pullAdmin, saveDraft, publish, publishEntity, setCreatorStatus, setVideoPublication, createLearningRepair, listTrash, trashVideos, restoreVideo,planPermanentVideoDeletion,confirmPermanentVideoDeletion,getVideoDeletion,getVideoDeletionCapability,retryVideoDeletion,
    processingHealth, createProcessingJob, reserveLocalProcessingJob, localProcessingCapability, getLocalProcessingInput, recoverLocalProcessingInput, listProcessingJobs, listProcessingHistory, getProcessingJob, retryProcessingJob, controlProcessingJob,
    syncMediaSession, clearMediaSession, uploadVideo, uploadCreatorAvatar });
})(window);
