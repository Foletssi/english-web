(function(global){
'use strict';
const BASE='http://127.0.0.1:8788';

async function request(path,options){
  const response=await fetch(BASE+path,options);
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(data.error?.message||`本地服务返回 ${response.status}`);error.code=data.error?.code||'STUDIO_HTTP_ERROR';error.retryable=Boolean(data.error?.retryable);throw error}
  return data;
}

function createJob({video,cover,metadata={},aiConfig={},onProgress}){
  if(!(video instanceof File)||!video.size)return Promise.reject(Object.assign(new Error('请选择视频文件。'),{code:'VIDEO_REQUIRED'}));
  const body=new FormData();body.append('metadata',JSON.stringify(metadata));body.append('aiConfig',JSON.stringify(aiConfig));body.append('video',video,video.name);if(cover instanceof File&&cover.size)body.append('cover',cover,cover.name);
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('POST',BASE+'/jobs');xhr.responseType='json';
    xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress?.(Math.round(event.loaded/event.total*100))};
    xhr.onerror=()=>reject(Object.assign(new Error('本地智能处理服务未启动。'),{code:'STUDIO_OFFLINE'}));
    xhr.onload=()=>{const data=xhr.response||{};if(xhr.status>=200&&xhr.status<300){onProgress?.(100);resolve(data);return}const error=new Error(data.error?.message||`本地服务返回 ${xhr.status}`);error.code=data.error?.code||'STUDIO_HTTP_ERROR';error.retryable=Boolean(data.error?.retryable);reject(error)};
    xhr.send(body);
  });
}

global.EastudyStudioClient={BASE,health:()=>request('/health'),listJobs:()=>request('/jobs'),
  getJob:id=>request('/jobs/'+encodeURIComponent(id)),
  retryJob:id=>request('/jobs/'+encodeURIComponent(id)+'/retry',{method:'POST'}),createJob};
})(window);
