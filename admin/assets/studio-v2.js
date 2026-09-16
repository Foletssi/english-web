(function(global){
'use strict';
const Client=global.EastudyStudioClient,Store=global.ZoContent;
const cloud=()=>global.EastudyCloudContent,bridge=()=>global.EastudyAdminCloudBridge;
const state={rows:[],polling:new Set(),serviceReady:false,submitting:false,cloudTimer:null,cloudBusy:false,cloudFailures:0,lastSyncAt:0,retrying:new Set(),refreshing:false,recovery:new Map()};
const $=selector=>document.querySelector(selector);
const titleFrom=name=>String(name||'').replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ').trim();
const escapeHtml=value=>String(value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const TOPIC_ZH={daily:'日常生活',travel:'旅行',food:'美食',work:'职场',education:'教育',technology:'科技',nature:'自然',culture:'文化',health:'健康',growth:'个人成长',unclassified:'待分类'};

function toast(message){const el=$('#toast');if(!el)return;el.textContent=message;el.classList.add('show');clearTimeout(global.__studioToast);global.__studioToast=setTimeout(()=>el.classList.remove('show'),2400)}
function aiConfig(){if(!Store.localOnly)return {};try{return JSON.parse(localStorage.getItem('zs:admin:ai-config')||'{}')}catch{return {}}}
function creatorGroup(name){return /teacher|english|英语|academy|school/i.test(name)?'英语教育':/tv|media|archive|news|官方/i.test(name)?'媒体机构':'独立创作者'}
function ensureCreator(name){const clean=String(name||'').trim();let creator=Store.listCreators().find(row=>row.name.toLowerCase()===clean.toLowerCase());if(creator)return creator;const group=creatorGroup(clean);return Store.saveCreator({id:'creator-'+Date.now()+'-'+Math.random().toString(36).slice(2,7),name:clean,group,bio:`${group} · 自动匹配，待核对`,status:'ACTIVE'})}

function renderRows(){const root=$('#studioV2Rows');if(!root)return;root.innerHTML=state.rows.map((row,index)=>`<article class="studio-upload-row" data-upload-row="${row.id}">
  <div class="studio-file-icon">${String(index+1).padStart(2,'0')}</div><div class="studio-upload-main"><b title="${escapeHtml(row.video.name)}">${escapeHtml(row.video.name)}</b><small>${(row.video.size/1024/1024).toFixed(1)} MB</small>
  <label><span>英文标题</span><input data-row-title="${row.id}" value="${escapeHtml(row.title)}"></label></div>
  <label class="studio-cover-picker"><span>单独封面（可选）</span><input type="file" accept="image/jpeg,image/png,image/webp" data-row-cover="${row.id}"><small>${row.cover?escapeHtml(row.cover.name):'未选择时自动抽帧'}</small></label>
  <div class="studio-row-state"><b>${escapeHtml(row.status||'等待上传')}</b><progress max="100" value="${row.progress||0}"></progress><button type="button" data-remove-row="${row.id}" ${row.locked?'disabled':''}>移除</button></div></article>`).join('')||'<div class="studio-drop-empty">选择多个视频后，会在这里生成上传清单。</div>';
}
function addFiles(files){for(const video of files){if(!video.type.startsWith('video/'))continue;state.rows.push({id:crypto.randomUUID(),video,title:titleFrom(video.name),cover:null,progress:0,status:'等待上传',locked:false})}renderRows()}
function updateRow(id,changes){const row=state.rows.find(item=>item.id===id);if(row)Object.assign(row,changes);renderRows()}

async function submitOne(row,creator){
  updateRow(row.id,{locked:true,status:Store.localOnly?'正在上传到本地服务':'正在上传原片到云端'});
  try{
    const localVideoId=row.localVideoId||(row.localVideoId=Date.now()+state.rows.indexOf(row));
    if(!Store.localOnly){
      const Cloud=cloud(),Bridge=bridge();if(!Cloud||!Bridge)throw new Error('CLOUD_PROCESSING_CLIENT_NOT_READY');
      const uploaded=row.uploaded||(row.uploaded=await Cloud.uploadVideo(row.video,progress=>updateRow(row.id,{progress,status:progress<100?'正在上传原片':'正在创建云端任务'})));
      const video=row.videoRecord||(row.videoRecord=Store.saveVideo({id:localVideoId,title:row.title||titleFrom(row.video.name),titleZh:'待云端生成',creator:creator.name,creatorId:creator.id,
        category:'AI 自动分类',level:'AI 分析中',description:'云端正在生成字幕与学习内容。',status:'DRAFT',pipelineStatus:'QUEUED',
        cover:'assets/images/home_video_1.png',mediaUrl:uploaded.url,mediaKey:uploaded.key,mediaSize:uploaded.size,collectionIds:[],processingOptions:{transcript:true,translate:true,dictionary:true,learningAnalysis:true}}));
      await Bridge.flush();
      let created=await Cloud.createProcessingJob(video,uploaded.key,row.id,Bridge.revision());
      if(created.error?.message?.includes('CONTENT_REVISION_CONFLICT')){
        const remote=await Cloud.pullAdmin();if(remote.error)throw remote.error;
        created=await Cloud.createProcessingJob(video,uploaded.key,row.id,remote.revision);
      }
      if(created.error)throw created.error;Bridge.importMutation(created);updateRow(row.id,{progress:100,submitted:true,status:'已安全排队，等待处理节点领取'});
      pollJob(created.data.job.id,localVideoId);return;
    }
    const job=await Client.createJob({video:row.video,cover:row.cover,aiConfig:aiConfig(),metadata:{
      localVideoId,title:row.title||titleFrom(row.video.name),creator:creator.name,creatorId:creator.id,creatorGroup:creator.group
    },onProgress:progress=>updateRow(row.id,{progress,status:progress<100?'正在上传':'已进入后台队列'})});
    Store.saveVideo({id:localVideoId,title:row.title||titleFrom(row.video.name),titleZh:'AI 正在生成',creator:creator.name,creatorId:creator.id,
      category:'AI 自动分类',level:'AI 分析中',description:'后台正在生成中文口语化简介。',status:'PROCESSING',pipelineStatus:'PROCESSING',
      cover:'assets/images/home_video_1.png',mediaUrl:'',collectionIds:[],localStudioJobId:job.id});
    Store.startPipeline(localVideoId,{id:job.id,currentStep:'upload',progress:5});
    updateRow(row.id,{progress:100,submitted:true,status:'后台处理中'});pollJob(job.id,localVideoId);
  }catch(error){updateRow(row.id,{locked:false,status:'失败：'+(error.message||'上传异常')});throw error}
}

async function submitQueue(event){
 event.preventDefault();if(state.submitting)return;
 if(!state.serviceReady){toast('视频处理服务尚未就绪，请先检查连接');return}
 const creatorName=$('#studioV2Creator').value.trim();if(!creatorName||/^(null|undefined)$/i.test(creatorName)){toast('请填写创作者');return}
 if(!state.rows.length){toast('请先选择视频');return}
 const button=$('#studioV2Submit');state.submitting=true;button.disabled=true;
 try{
  const creator=ensureCreator(creatorName);let next=0,failed=0;
  const run=async()=>{while(next<state.rows.length){const row=state.rows[next++];if(row.submitted)continue;try{await submitOne(row,creator)}catch{failed++}}};
  await Promise.all(Array.from({length:Store.localOnly?Math.min(2,state.rows.length):1},run));
  button.textContent=failed?'继续未完成的上传':'开始批量处理';
  toast(failed?`${failed} 个上传失败，其余任务继续处理`:'上传完成；关闭网页后后台仍会继续处理');
  if(!failed){$('#studioV2Modal').classList.remove('show');location.hash='#/pipeline'}
 }catch{toast('上传暂未完成，请检查连接后继续处理')}
 finally{state.submitting=false;button.disabled=!state.serviceReady}
}

function ensureVideo(job,videoId){if(!Store.acceptsJob(videoId,job.id))return null;let video=Store.getVideo(videoId);if(video)return video;const meta=job.metadata||{},creator=ensureCreator(meta.creator||'待确认创作者');video=Store.saveVideo({id:Number(videoId),title:meta.title||titleFrom(job.sourceName),titleZh:'AI 正在生成',creator:creator.name,creatorId:creator.id,category:'AI 自动分类',level:'AI 分析中',description:'后台正在生成中文口语化简介。',status:'PROCESSING',pipelineStatus:'PROCESSING',cover:'assets/images/home_video_1.png',mediaUrl:'',collectionIds:[],localStudioJobId:job.id});Store.startPipeline(videoId,{id:job.id,currentStep:job.currentStep||'upload',progress:job.progress||5});return video}
function mergeResult(job,videoId){const current=ensureVideo(job,videoId);if(!current||current.pipelineStatus==='READY')return;const result=job.result;if(!result?.sentences?.length||!result?.video?.mediaUrl){Store.failPipeline(videoId,{id:job.id,currentStep:job.currentStep,error:{code:'RESULT_EMPTY',message:'后台结果缺少字幕或媒体'}});return}const category=(result.video.topicIds||[]).map(id=>TOPIC_ZH[id]||id).join(' / ');Store.completePipeline(videoId,{id:job.id,sentences:result.sentences,video:{...result.video,category,creatorId:current.creatorId,creator:current.creator},evidence:result.evidence})}
async function pollJob(jobId,videoId){if(!Store.localOnly){state.polling.add(jobId);wakeCloudPoll();return}if(state.polling.has(jobId))return;state.polling.add(jobId);try{while(true){const job=await Client.getJob(jobId);if(!Store.acceptsJob(videoId,jobId))break;if(job.status==='REVIEW'){mergeResult(job,videoId);break}if(job.status==='ERROR'){Store.failPipeline(videoId,{id:job.id,currentStep:job.currentStep,error:job.error});break}Store.updatePipeline(videoId,{id:job.id,status:'PROCESSING',currentStep:job.currentStep,progress:job.progress,error:null});global.dispatchEvent(new CustomEvent('eastudy:studio-job-updated'));await new Promise(resolve=>setTimeout(resolve,1800))}}catch(error){toast('读取后台任务失败：'+error.message)}finally{state.polling.delete(jobId);global.dispatchEvent(new CustomEvent('eastudy:studio-job-updated'))}}
async function syncJobs(){if(!Store.localOnly){const Bridge=bridge();let rows;if(Bridge?.refreshJobs)rows=await Bridge.refreshJobs();else{const result=await cloud()?.listProcessingJobs();if(result?.error)throw result.error;rows=result?.rows||[];Bridge?.setJobs(rows)}rows=rows||[];let reload=false;for(const job of rows){if(['REVIEW','ERROR','CANCELLED'].includes(job.status)){if(state.polling.delete(job.id))reload=true}else state.polling.add(job.id)}if(reload)await bridge()?.reload();return rows}const data=await Client.listJobs();for(const job of data.jobs||[]){const videoId=job.metadata?.localVideoId;if(!videoId)continue;const video=ensureVideo(job,videoId);if(!video)continue;if(job.status==='REVIEW')mergeResult(job,videoId);else if(job.status==='ERROR'){if(video.pipelineStatus!=='ERROR')Store.failPipeline(videoId,{id:job.id,currentStep:job.currentStep,error:job.error})}else pollJob(job.id,videoId)}return data.jobs||[]}
function wakeCloudPoll(){if(Store.localOnly)return;clearTimeout(state.cloudTimer);state.cloudTimer=setTimeout(runCloudPoll,0)}
async function runCloudPoll(){if(Store.localOnly||state.cloudBusy)return;state.cloudBusy=true;try{const [rows,healthResult]=await Promise.all([syncJobs(),cloud()?.processingHealth()]);state.lastSyncAt=Date.now();state.cloudFailures=0;global.dispatchEvent(new CustomEvent('eastudy:studio-sync',{detail:{ok:true,at:state.lastSyncAt,health:healthResult?.data||null,healthError:healthResult?.error||null}}));state.cloudTimer=setTimeout(runCloudPoll,rows.some(job=>['QUEUED','PROCESSING','RUNNING','WAITING'].includes(job.status))?5000:20000)}catch(error){state.cloudFailures++;global.dispatchEvent(new CustomEvent('eastudy:studio-sync',{detail:{ok:false,error}}));const delay=Math.min(30000,5000*2**Math.min(3,state.cloudFailures-1));state.cloudTimer=setTimeout(runCloudPoll,delay+Math.random()*500)}finally{state.cloudBusy=false}}
function recoveryMessage(key){return state.recovery.get(String(key))||''}
function reportRecovery(key,message){state.recovery.set(String(key),message);global.dispatchEvent(new CustomEvent('eastudy:studio-job-updated'))}
async function refreshJobs(){
 if(state.refreshing)return;state.refreshing=true;reportRecovery('refresh','正在刷新任务状态…');
 try{if(!Store.localOnly&&bridge()?.refreshJobs)await bridge().refreshJobs();else await syncJobs();reportRecovery('refresh','已读取最新状态。刷新不会重启任务，请查看当前步骤与最近进展。')}
 catch{reportRecovery('refresh','暂时无法读取任务状态，请检查网络后再次刷新。已提交的后台任务不会因此取消。')}
 finally{state.refreshing=false}
}
async function retry(jobId,videoId){
 if(state.retrying.has(jobId))return;state.retrying.add(jobId);reportRecovery(jobId,'正在提交继续处理请求…');
 try{
  if(!Store.localOnly){
   const result=await cloud().retryProcessingJob(jobId);if(result.error)throw result.error;
   reportRecovery(jobId,'已加入处理队列，将复用已完成的结果');pollJob(jobId,videoId);
   try{await syncJobs()}catch{reportRecovery(jobId,'继续处理请求已接受，但状态暂未同步，请刷新状态')}
  }else{
   const job=await Client.retryJob(jobId);
   Store.allowJobRetry(videoId,jobId);
   Store.updatePipeline(videoId,{id:jobId,status:'PROCESSING',currentStep:job.currentStep,progress:job.progress,error:null});
   pollJob(jobId,videoId);reportRecovery(jobId,'已加入处理队列，将复用已完成的结果');
  }
 }catch(error){reportRecovery(jobId,String(error?.message||error).includes('JOB_SUPERSEDED')?'此任务已被新版视频替代，请在当前视频卡片中继续处理。':'暂未确认继续处理成功。请先刷新状态；如果任务仍然失败，再点击继续处理。')}
 finally{state.retrying.delete(jobId);global.dispatchEvent(new CustomEvent('eastudy:studio-job-updated'))}
}
async function checkService(){
  if(state.submitting)return;
  state.serviceReady=false;const health=$('#studioV2Health'),button=$('#studioV2Submit');
  button.disabled=true;button.textContent='检查服务中…';health.dataset.state='checking';
  health.textContent='正在检查视频处理服务…';$('#studioV2Recheck').hidden=false;
  if(!Store.localOnly){$('#studioV2Intro').textContent='原片上传 R2 后，本机 Worker 自动转码、识别英文字幕并调用 DeepSeek 生成学习内容，成品回传 R2 后进入人工审核。';
    $('#studioV2ServiceCopy').textContent='网页可以关闭；处理期间请保持这台电脑和 Eastudy Worker 运行。处理完成后，学生播放完全来自云端，不再依赖本机。';
    const result=await cloud()?.processingHealth();if(result?.error||!result?.data?.ready){state.serviceReady=true;health.dataset.state='unavailable';health.textContent='处理节点暂未就绪；可以先上传并排队，电脑和 Worker 恢复后会自动处理。';button.disabled=false;button.textContent='上传并加入等待队列';return}
    state.serviceReady=true;health.dataset.state='ok';health.textContent='本机云任务 Worker 已连接（FFmpeg / Whisper / DeepSeek）';button.disabled=false;button.textContent='开始批量处理';return}
  $('#studioV2Intro').textContent='选择视频、填写创作者并核对标题，处理完成后进入人工审核。';
  $('#studioV2ServiceCopy').textContent='当前为本地开发环境：由这台电脑处理视频。上传完成后可关闭网页，请保持电脑和处理程序运行。';
  try{const result=await Client.health();if(!result.ok)throw new Error(result.message||'服务不可用');
    state.serviceReady=true;health.dataset.state='ok';health.textContent='本机视频处理服务已连接';button.disabled=false;button.textContent='开始批量处理';
  }catch{health.dataset.state='error';health.textContent='本机处理程序未连接，请启动 START_EASTUDY_STUDIO_V2.bat 后重新检查。';button.textContent='请先连接处理服务'}
}
function open(){if(state.submitting){$('#studioV2Modal').classList.add('show');return}state.rows=state.rows.filter(row=>!row.submitted);renderRows();const creator=$('#studioV2Creator');if(/^(null|undefined)$/i.test(creator.value.trim()))creator.value='';$('#studioV2Videos').value='';$('#studioCreatorOptions').innerHTML=Store.listCreators().filter(row=>row.name&&!/^(null|undefined)$/i.test(String(row.name))).map(row=>`<option value="${escapeHtml(row.name)}"></option>`).join('');$('#studioV2Modal').classList.add('show');void checkService()}

function bind(){const form=$('#studioV2Form');if(!form)return;form.addEventListener('submit',submitQueue);$('#studioV2Recheck').addEventListener('click',checkService);$('#studioV2Videos').addEventListener('change',event=>addFiles(event.target.files));$('#studioV2Rows').addEventListener('input',event=>{const row=state.rows.find(item=>item.id===event.target.dataset.rowTitle);if(row)row.title=event.target.value});$('#studioV2Rows').addEventListener('change',event=>{const row=state.rows.find(item=>item.id===event.target.dataset.rowCover);if(row){row.cover=event.target.files[0]||null;renderRows()}});$('#studioV2Rows').addEventListener('click',event=>{const button=event.target.closest('[data-remove-row]');if(button)state.rows=state.rows.filter(row=>row.id!==button.dataset.removeRow),renderRows()});document.addEventListener('click',event=>{if(event.target.closest('[data-refresh-studio-jobs]'))void refreshJobs();const retryButton=event.target.closest('[data-retry-studio-job]');if(retryButton)retry(retryButton.dataset.retryStudioJob,retryButton.dataset.videoId)});global.addEventListener('online',wakeCloudPoll);document.addEventListener('visibilitychange',()=>{if(!document.hidden)wakeCloudPoll()});if(Store.localOnly)void syncJobs().catch(()=>{});else wakeCloudPoll()}
global.EastudyStudioV2={open,retry,syncJobs,refreshJobs,recoveryMessage,isRetrying:jobId=>state.retrying.has(jobId),localOnly:Store.localOnly};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
})(window);
