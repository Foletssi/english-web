(function(global){
'use strict';
const Client=global.EastudyStudioClient,Store=global.ZoContent;
const state={rows:[],polling:new Set()};
const $=selector=>document.querySelector(selector);
const titleFrom=name=>String(name||'').replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ').trim();
const escapeHtml=value=>String(value||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const TOPIC_ZH={daily:'日常生活',travel:'旅行',food:'美食',work:'职场',education:'教育',technology:'科技',nature:'自然',culture:'文化',health:'健康',growth:'个人成长',unclassified:'待分类'};

function toast(message){const el=$('#toast');if(!el)return;el.textContent=message;el.classList.add('show');clearTimeout(global.__studioToast);global.__studioToast=setTimeout(()=>el.classList.remove('show'),2400)}
function aiConfig(){try{return JSON.parse(localStorage.getItem('zs:admin:ai-config')||'{}')}catch{return {}}}
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
  updateRow(row.id,{locked:true,status:'正在上传到本地服务'});
  try{
    const localVideoId=Date.now()+state.rows.indexOf(row);
    const job=await Client.createJob({video:row.video,cover:row.cover,aiConfig:aiConfig(),metadata:{
      localVideoId,title:row.title||titleFrom(row.video.name),creator:creator.name,creatorId:creator.id,creatorGroup:creator.group
    },onProgress:progress=>updateRow(row.id,{progress,status:progress<100?'正在上传':'已进入后台队列'})});
    Store.saveVideo({id:localVideoId,title:row.title||titleFrom(row.video.name),titleZh:'AI 正在生成',creator:creator.name,creatorId:creator.id,
      category:'AI 自动分类',level:'AI 分析中',description:'后台正在生成中文口语化简介。',status:'PROCESSING',pipelineStatus:'PROCESSING',
      cover:'assets/images/home_video_1.png',mediaUrl:'',collectionIds:[],localStudioJobId:job.id});
    Store.startPipeline(localVideoId,{id:job.id,currentStep:'upload',progress:5});
    updateRow(row.id,{progress:100,status:'后台处理中'});pollJob(job.id,localVideoId);
  }catch(error){updateRow(row.id,{locked:false,status:'失败：'+(error.message||'上传异常')});throw error}
}

async function submitQueue(event){event.preventDefault();const creatorName=$('#studioV2Creator').value.trim();if(!creatorName){toast('请填写创作者');return}if(!state.rows.length){toast('请先选择视频');return}const button=$('#studioV2Submit');button.disabled=true;const creator=ensureCreator(creatorName);let next=0,failed=0;const run=async()=>{while(next<state.rows.length){const row=state.rows[next++];try{await submitOne(row,creator)}catch{failed++}}};await Promise.all(Array.from({length:Math.min(2,state.rows.length)},run));button.disabled=false;button.textContent='开始批量处理';toast(failed?`${failed} 个上传失败，其余任务继续处理`:'上传完成；关闭网页后后台仍会继续处理');location.hash='#/pipeline'}

function ensureVideo(job,videoId){if(!Store.acceptsJob(videoId,job.id))return null;let video=Store.getVideo(videoId);if(video)return video;const meta=job.metadata||{},creator=ensureCreator(meta.creator||'待确认创作者');video=Store.saveVideo({id:Number(videoId),title:meta.title||titleFrom(job.sourceName),titleZh:'AI 正在生成',creator:creator.name,creatorId:creator.id,category:'AI 自动分类',level:'AI 分析中',description:'后台正在生成中文口语化简介。',status:'PROCESSING',pipelineStatus:'PROCESSING',cover:'assets/images/home_video_1.png',mediaUrl:'',collectionIds:[],localStudioJobId:job.id});Store.startPipeline(videoId,{id:job.id,currentStep:job.currentStep||'upload',progress:job.progress||5});return video}
function mergeResult(job,videoId){const current=ensureVideo(job,videoId);if(!current||current.pipelineStatus==='READY')return;const result=job.result;if(!result?.sentences?.length||!result?.video?.mediaUrl){Store.failPipeline(videoId,{id:job.id,currentStep:job.currentStep,error:{code:'RESULT_EMPTY',message:'后台结果缺少字幕或媒体'}});return}const category=(result.video.topicIds||[]).map(id=>TOPIC_ZH[id]||id).join(' / ');Store.completePipeline(videoId,{id:job.id,sentences:result.sentences,video:{...result.video,category,creatorId:current.creatorId,creator:current.creator},evidence:result.evidence})}
async function pollJob(jobId,videoId){if(state.polling.has(jobId))return;state.polling.add(jobId);try{while(true){const job=await Client.getJob(jobId);if(!Store.acceptsJob(videoId,jobId))break;if(job.status==='REVIEW'){mergeResult(job,videoId);break}if(job.status==='ERROR'){Store.failPipeline(videoId,{id:job.id,currentStep:job.currentStep,error:job.error});break}Store.updatePipeline(videoId,{id:job.id,status:'PROCESSING',currentStep:job.currentStep,progress:job.progress,error:null});global.dispatchEvent(new CustomEvent('eastudy:studio-job-updated'));await new Promise(resolve=>setTimeout(resolve,1800))}}catch(error){toast('读取后台任务失败：'+error.message)}finally{state.polling.delete(jobId);global.dispatchEvent(new CustomEvent('eastudy:studio-job-updated'))}}
async function syncJobs(){try{const data=await Client.listJobs();for(const job of data.jobs||[]){const videoId=job.metadata?.localVideoId;if(!videoId)continue;const video=ensureVideo(job,videoId);if(!video)continue;if(job.status==='REVIEW')mergeResult(job,videoId);else if(job.status==='ERROR'){if(video.pipelineStatus!=='ERROR')Store.failPipeline(videoId,{id:job.id,currentStep:job.currentStep,error:job.error})}else pollJob(job.id,videoId)}}catch{}}
async function retry(jobId,videoId){try{Store.allowJobRetry(videoId,jobId);Store.updatePipeline(videoId,{id:jobId,status:'PROCESSING',currentStep:'upload',progress:5});await Client.retryJob(jobId);pollJob(jobId,videoId);toast('失败任务已重新加入后台队列')}catch(error){if(Store.getVideo(videoId))Store.failPipeline(videoId,{id:jobId,currentStep:'upload',error:{code:'RETRY_FAILED',message:error.message}});toast(error.message||'重试失败')}}
function open(){state.rows=[];renderRows();$('#studioCreatorOptions').innerHTML=Store.listCreators().map(row=>`<option value="${escapeHtml(row.name)}"></option>`).join('');const modal=$('#studioV2Modal');modal.classList.add('show');Client.health().then(()=>{$('#studioV2Health').textContent='本地智能处理服务已连接';$('#studioV2Health').dataset.state='ok'}).catch(()=>{$('#studioV2Health').textContent='本地服务未启动，请双击 START_EASTUDY_STUDIO_V2.bat';$('#studioV2Health').dataset.state='error'})}

function bind(){const form=$('#studioV2Form');if(!form)return;form.addEventListener('submit',submitQueue);$('#studioV2Videos').addEventListener('change',event=>addFiles(event.target.files));$('#studioV2Rows').addEventListener('input',event=>{const row=state.rows.find(item=>item.id===event.target.dataset.rowTitle);if(row)row.title=event.target.value});$('#studioV2Rows').addEventListener('change',event=>{const row=state.rows.find(item=>item.id===event.target.dataset.rowCover);if(row){row.cover=event.target.files[0]||null;renderRows()}});$('#studioV2Rows').addEventListener('click',event=>{const button=event.target.closest('[data-remove-row]');if(button)state.rows=state.rows.filter(row=>row.id!==button.dataset.removeRow),renderRows()});document.addEventListener('click',event=>{const retryButton=event.target.closest('[data-retry-studio-job]');if(retryButton)retry(retryButton.dataset.retryStudioJob,retryButton.dataset.videoId)});syncJobs()}
global.EastudyStudioV2={open,retry,syncJobs,localOnly:Store.localOnly};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
})(window);
