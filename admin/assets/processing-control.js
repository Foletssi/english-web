(function(global){
 'use strict';
 const pending=new Set(),requests=new Map(),messages=new Map();
 const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const names={source:'原片已保存',claim:'领取任务',download:'读取原片',probe:'检查视频',transcode:'540P 转码',asr:'字幕识别',enrich:'翻译与重点词',voice:'生成发音',output:'回传成品',review:'待审核发布'};
 function steps(job){
   const raw=job.rawStatus||job.status,learning=job.type==='LEARNING_REPAIR',media=job.type==='MEDIA_REENCODE';
   const order=learning?['claim','enrich','voice','output','review']:media?['source','claim','download','probe','transcode','output','review']:Object.keys(names);
   const voice=job.currentStep==='enrich'&&String(job.telemetry?.substage||job.substage||'').startsWith('teaching-voice');
   const current=['QUEUED','WAITING'].includes(raw)?'claim':raw==='REVIEW'?'review':voice?'voice':job.currentStep;
   const index=order.indexOf(current);
   return order.map((name,i)=>({name,label:names[name],current:i===index,state:i<index?'SUCCESS':i===index?(['ERROR','CANCELLED'].includes(raw)?raw:['QUEUED','WAITING','REVIEW'].includes(raw)?'WAITING':'RUNNING'):'WAITING'}));
 }
 const date=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚未上报';
 function measured(job){
   const current=Number(job.current),total=Number(job.total),unit=job.unit;
   const ended=Date.parse(job.completedAt),now=Number.isFinite(ended)?ended:Date.now();
   if(!Number.isFinite(current)||!Number.isFinite(total)||total<=0)return '耗时 '+(Number.isFinite(Date.parse(job.stageStartedAt))?Math.max(0,Math.floor((now-Date.parse(job.stageStartedAt))/1000))+' 秒':'尚未上报');
   return unit==='bytes'?`${(current/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`:`${current} / ${total} ${{media_seconds:'秒',files:'个文件',batches:'批'}[unit]||'项'}`;
 }
 function renderSteps(job){return '<div class="pipeline-steps">'+steps(job).map((step,i)=>{
   const history=job.telemetry?.stepHistory?.[step.name];
   const metrics=history?{...history,completedAt:history.completedAt||job.completedAt}:step.current?job:null;
   return `<div class="pipeline-step ${step.state.toLowerCase()}"><span class="step-icon">${step.state==='SUCCESS'?'✓':i+1}</span><span><b>${step.label}</b><small>${{SUCCESS:'已完成',RUNNING:'当前步骤',WAITING:'等待',ERROR:'出错',CANCELLED:'已停止'}[step.state]}</small>${metrics?`<small>开始：${escape(date(metrics.stageStartedAt))}</small><small>最近进展：${escape(date(metrics.lastProgressAt))}</small><small>${escape(measured(metrics))}</small>`:''}</span></div>`;
 }).join('')+'</div>'}
 function requestId(key){
   if(requests.has(key))return requests.get(key);
   let saved;try{saved=JSON.parse(sessionStorage.getItem('eastudy.processing-command')||'null')}catch{}
   const id=saved?.key===key?saved.id:crypto.randomUUID();requests.set(key,id);
   try{sessionStorage.setItem('eastudy.processing-command',JSON.stringify({key,id}))}catch{}
   return id;
 }
 function actions(job,state){
   if(state!=='ACTIVE'||global.ZoContent?.localOnly)return '';
   const raw=job.rawStatus||job.status,id=String(job.id),action=['RUNNING','QUEUED','WAITING'].includes(raw)?'cancel':['ERROR','CANCELLED'].includes(raw)&&job.type!=='MEDIA_REENCODE'?'retry_failed_stage':'';
   return (action?`<button class="${action==='cancel'?'ghost':'primary'}" data-processing-command="${action}" data-job-id="${escape(id)}" data-run-id="${escape(job.runId||job.run_id||'')}" data-updated-at="${escape(job.updatedAt||job.updated_at)}" ${pending.has(id)?'disabled':''}>${action==='cancel'?'取消处理':'继续处理'}</button>`:'')+`<span role="status">${escape(messages.get(id)||'')}</span>`;
 }
 async function command(button){
   const id=button.dataset.jobId;if(pending.has(id))return;
   const args={id,runId:button.dataset.runId||null,updatedAt:button.dataset.updatedAt,action:button.dataset.processingCommand};
   const key=JSON.stringify(args),request=requestId(key);
   pending.add(id);button.disabled=true;messages.set(id,'正在确认操作…');
   try{const result=await global.EastudyCloudContent.controlProcessingJob({...args,requestId:request});if(!result||result.error)throw result?.error||new Error('EMPTY_RESPONSE');
     requests.delete(key);messages.set(id,args.action==='cancel'?'已撤销执行权限；处理节点正在停止。':'已排队；仅复用校验有效的结果。');
   }catch(error){messages.set(id,String(error.message).includes('PROCESSING_STATE_CHANGED')?'任务已进入新的状态，请刷新后操作。':'暂未确认操作结果，请刷新状态；再次操作不会重复执行。')}
   finally{pending.delete(id);button.disabled=false;try{await global.EastudyStudioV2?.refreshJobs()}catch{}global.dispatchEvent(new CustomEvent('eastudy:studio-job-updated'))}
 }
 document.addEventListener('click',event=>{const button=event.target.closest('[data-processing-command]');if(button)void command(button)});
 global.EastudyProcessingControl=Object.freeze({steps,renderSteps,actions});
})(window);
