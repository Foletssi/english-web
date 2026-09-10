(function(global){
  'use strict';
  const LEGACY_KEY='zs:platform:content:v1';
  const localOnly=['localhost','127.0.0.1','[::1]'].includes(global.location?.hostname);
  const pathname=String(global.location?.pathname||'/');
  const scope=localOnly?'local':/^\/admin(?:\/|$)/.test(pathname)?'admin':'student';
  const KEY=localOnly?'zs:platform:content:local:v1':`zs:platform:content:${scope}:v3`;
  const contentStorage=scope==='admin'&&global.sessionStorage?global.sessionStorage:(global.localStorage||localStorage);
  const SCHEMA_VERSION=3;
  const deep=x=>JSON.parse(JSON.stringify(x));
  const now=()=>new Date().toISOString();
  const learningContract=global.EastudyLearningContract;
  const normalizeToken=t=>String(t||'').toLowerCase().replace(/[^a-z'-]/g,'');
  const normalizeKeyword=t=>String(t||'').toLowerCase().replace(/[^a-z'\-]+/g,' ').trim().replace(/\s+/g,' ');
  function deriveWordTimings(english,startTime,endTime){
    const words=String(english||'').split(/\s+/).map(x=>x.trim()).filter(x=>normalizeToken(x));
    const start=Number(startTime)||0,end=Math.max(start+.01,Number(endTime)||start+3),span=(end-start)/Math.max(1,words.length);
    return words.map((text,index)=>({text,word:normalizeToken(text),start:Number((start+index*span).toFixed(3)),end:Number((start+(index+1)*span).toFixed(3))}));
  }
  function normalizeWordTimings(input,english,startTime,endTime){
    const rows=Array.isArray(input)?input.map(x=>({text:String(x?.text||x?.word||'').trim(),word:normalizeToken(x?.word||x?.text),start:Number(x?.start),end:Number(x?.end)})).filter(x=>x.word&&Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.end>x.start):[];
    return rows.length?rows:deriveWordTimings(english,startTime,endTime);
  }
  function normalizeSentence(input,videoId,order){
    const row={...deep(input),videoId:Number(videoId),order:Number(input.order??order)};
    row.learningContractVersion=Number(row.learningContractVersion)||learningContract?.VERSION||4;
    row.textRevision=Math.max(1,Number(row.textRevision)||1);
    row.keyWords=Array.isArray(row.keyWords)?row.keyWords.map(normalizeKeyword).filter(Boolean):[];
    row.expressions=Array.isArray(row.expressions)?row.expressions.map(item=>({
      ...deep(item),surface:String(item?.surface||'').trim(),coreMeaningZh:String(item?.coreMeaningZh||'').trim(),
      contextMeaningZh:String(item?.contextMeaningZh||'').trim(),usageNoteZh:String(item?.usageNoteZh||'').trim(),
      reviewStatus:item?.reviewStatus||'REVIEW',source:item?.source||'ai',
      sourceTextRevision:Math.max(1,Number(item?.sourceTextRevision)||row.textRevision)
    })).filter(item=>item.surface):[];
    const suppliedTimings=Array.isArray(row.wordTimings)&&row.wordTimings.some(x=>Number.isFinite(Number(x?.start))&&Number.isFinite(Number(x?.end))&&Number(x.end)>Number(x.start));
    row.wordTimings=normalizeWordTimings(row.wordTimings,row.english,row.startTime,row.endTime);
    row.timingSource=suppliedTimings?(row.timingSource||'unknown'):'estimated';
    row.alignmentBasis=row.alignmentBasis||{english:String(row.english||''),startTime:Number(row.startTime)||0,endTime:Number(row.endTime)||0};
    return row;
  }
  const seed={
    schemaVersion:SCHEMA_VERSION,
    creators:[
      {id:'creator-jojo',name:'Jojo English',bio:'英国乡村生活 · 可理解输入',avatar:'assets/images/home_video_1.png',status:'ACTIVE'},
      {id:'creator-easy',name:'Easy English',bio:'街头采访 · 真实对话',avatar:'assets/images/home_video_3.png',status:'ACTIVE'},
      {id:'creator-lucy',name:'English with Lucy',bio:'自然表达 · 发音与词汇',avatar:'assets/images/home_video_2.png',status:'ACTIVE'},
      {id:'creator-interview',name:'Interview Studio',bio:'人物访谈 · 教育成长',avatar:'assets/images/home_video_2.png',status:'ACTIVE'},
      {id:'creator-travel',name:'Travel Log',bio:'旅行记录 · 真实表达',avatar:'assets/images/home_video_3.png',status:'ACTIVE'},
      {id:'creator-ted',name:'TED Archive',bio:'演讲 · 科技与思考',avatar:'assets/images/home_video_4.png',status:'ACTIVE'},
      {id:'creator-mind',name:'Mind Lab',bio:'心理成长 · 真实英语',avatar:'assets/images/home_video_2.png',status:'ACTIVE'},
      {id:'creator-food',name:'Food Talk',bio:'美食文化 · 场景英语',avatar:'assets/images/home_video_4.png',status:'ACTIVE'},
      {id:'creator-work',name:'Work English',bio:'职场英语 · 会议表达',avatar:'assets/images/home_video_1.png',status:'ACTIVE'},
      {id:'creator-nature',name:'Nature Notes',bio:'自然观察 · 简单英语',avatar:'assets/images/home_video_3.png',status:'ACTIVE'},
      {id:'creator-curated',name:'ZoSpeak Curated',bio:'ZoSpeak 精选真实英语',avatar:'assets/images/home_video_4.png',status:'ACTIVE'}
    ],
    collections:[
      {id:36,title:'Comprehensible Input',subtitle:'真实生活里的可理解输入',cover:'assets/images/home_collection_1.png',level:'A2–B2',status:'PUBLISHED'},
      {id:12,title:'Daily English Vlog',subtitle:'日常表达与自然语速',cover:'assets/images/home_collection_2.png',level:'A2–B1',status:'PUBLISHED'},
      {id:101,title:'治愈系生活',subtitle:'日常生活中的真实表达',cover:'assets/images/home_collection_1.png',level:'A1–B1',status:'PUBLISHED'},
      {id:102,title:'世界旅行',subtitle:'旅行场景与自然口语',cover:'assets/images/home_collection_2.png',level:'A2–B2',status:'PUBLISHED'},
      {id:103,title:'名人演讲',subtitle:'公开演讲与观点表达',cover:'assets/images/home_collection_3.png',level:'B1–C1',status:'PUBLISHED'},
      {id:104,title:'高效学习',subtitle:'学习方法与职场成长',cover:'assets/images/home_collection_4.png',level:'A2–B2',status:'PUBLISHED'},
      {id:105,title:'美食与文化',subtitle:'食物、文化和日常表达',cover:'assets/images/home_collection_5.png',level:'A2–B1',status:'PUBLISHED'},
      {id:106,title:'自然观察',subtitle:'自然主题可理解输入',cover:'assets/images/home_collection_2.png',level:'A1–B1',status:'PUBLISHED'},
      {id:107,title:'心理成长',subtitle:'心理学与个人成长',cover:'assets/images/home_collection_4.png',level:'B1–B2',status:'PUBLISHED'},
      {id:108,title:'科技观察',subtitle:'科技演讲与趋势表达',cover:'assets/images/home_collection_3.png',level:'B1–C1',status:'PUBLISHED'},
      {id:109,title:'本周热门',subtitle:'本周精选真实英语',cover:'assets/images/home_collection_1.png',level:'A2–B2',status:'PUBLISHED'}
    ],
    videos:[],
    sentences:{},
    jobs:[],
    trash:[],
    tombstones:{},
    auditLog:[]
  };
  function migrate(parsed){
    if(!parsed||typeof parsed!=='object')return deep(seed);
    const seedVideos=new Map(seed.videos.map(v=>[String(v.id),v]));
    parsed.videos=(parsed.videos||[]).map(v=>{
      const base=seedVideos.get(String(v.id))||{};
      return {...v,titleZh:v.titleZh||v.aiAnalysis?.titleZh||base.titleZh||'',topicIds:Array.isArray(v.topicIds)?v.topicIds:[],tagIds:Array.isArray(v.tagIds)?v.tagIds:[],tagAssignments:Array.isArray(v.tagAssignments)?v.tagAssignments:[],goalIds:Array.isArray(v.goalIds)?v.goalIds:(base.goalIds||[]),goalMappings:Array.isArray(v.goalMappings)?v.goalMappings:[]};
    });
    parsed.sentences=parsed.sentences||{};
    for(const [videoId,rows] of Object.entries(parsed.sentences)){
      const seedRows=new Map((seed.sentences[videoId]||[]).map(row=>[String(row.id),row]));
      parsed.sentences[videoId]=(rows||[]).map(row=>{
        const base=seedRows.get(String(row.id))||{};
        return normalizeSentence({...row,keyWords:Array.isArray(row.keyWords)&&row.keyWords.length?row.keyWords:(base.keyWords||[]),expressions:Array.isArray(row.expressions)?row.expressions:(base.expressions||[]),grammar:row.grammar||row.grammarNote||base.grammar||''},videoId,row.order||0);
      });
    }
    parsed.jobs=(parsed.jobs||[]).map(job=>{
      const steps=Array.isArray(job.steps)?job.steps.slice():[];
      if(steps.length&&!steps.some(step=>step[0]==='learning_analysis')){
        const reviewIndex=steps.findIndex(step=>step[0]==='review');
        steps.splice(reviewIndex<0?steps.length:reviewIndex,0,['learning_analysis','WAITING']);
      }
      return {...job,steps};
    });
    parsed.schemaVersion=SCHEMA_VERSION;
    return parsed;
  }
  function load(){
    const own=contentStorage.getItem(KEY),raw=own||(localOnly?contentStorage.getItem(LEGACY_KEY):null);
    if(!raw)return deep(seed);
    const parsed=JSON.parse(raw);
    if(!parsed||!Array.isArray(parsed.videos))throw new Error('CONTENT_STORAGE_INVALID');
    if(Number(parsed.schemaVersion)>SCHEMA_VERSION)throw new Error('CONTENT_SCHEMA_NEWER');
    const fromVersion=Number(parsed.schemaVersion)||1,migrated=migrate(parsed);
    migrated.trash=migrated.trash||[];migrated.tombstones=migrated.tombstones||{};
    let cleaned=false;
    if(localOnly&&!migrated.placeholderCleanupVersion){
      for(const video of migrated.videos.filter(isPlaceholder))moveToTrash(migrated,video,'placeholder-cleanup');
      migrated.placeholderCleanupVersion=1;cleaned=true;
    }
    // One atomic write contains both the retained records and the recoverable originals.
    // Never overwrite a broken/full browser store with empty defaults.
    if(!own||cleaned||fromVersion!==SCHEMA_VERSION)contentStorage.setItem(KEY,JSON.stringify(migrated));
    return migrated;
  }
  function save(state,event){
    state.schemaVersion=SCHEMA_VERSION;
    if(event){state.auditLog=state.auditLog||[];state.auditLog.unshift({id:'audit-'+Date.now(),at:now(),...event});state.auditLog=state.auditLog.slice(0,200)}
    contentStorage.setItem(KEY,JSON.stringify(state));
    global.dispatchEvent(new CustomEvent('zospeak:content-changed',{detail:event||{type:'save'}}));
    return deep(state);
  }
  function snapshot(){return deep(load())}
  function importSnapshot(input,event={type:'cloud.import'}){
    if(localOnly&&event?.type==='cloud.import')throw new Error('LOCAL_CONTENT_CLOUD_IMPORT_DISABLED');
    if(!input||typeof input!=='object'||!Array.isArray(input.videos))throw new Error('INVALID_CONTENT_SNAPSHOT');
    const migrated=migrate(deep(input));
    return save(migrated,event);
  }
  function listVideos(opts={}){const s=load();let rows=s.videos||[];if(opts.publishedOnly)rows=rows.filter(v=>v.status==='PUBLISHED');return deep(rows)}
  function getVideo(id){return deep((load().videos||[]).find(v=>String(v.id)===String(id))||null)}
  function saveVideo(input){const s=load();if(s.tombstones?.[String(input.id)]?.deleted)throw new Error('VIDEO_IN_TRASH');const id=input.id??Date.now();const idx=s.videos.findIndex(v=>String(v.id)===String(id));const prev=idx>=0?s.videos[idx]:{},normalized=deep(input);if(typeof normalized.tagIds==='string')normalized.tagIds=[...new Set(normalized.tagIds.split(',').map(x=>x.trim()).filter(Boolean))];const next={...prev,...normalized,id,updatedAt:now()};if(idx>=0)s.videos[idx]=next;else s.videos.unshift(next);save(s,{type:idx>=0?'video.update':'video.create',entityId:id,title:next.title});return deep(next)}
  function setVideoStatus(id,status){const s=load();const v=s.videos.find(x=>String(x.id)===String(id));if(!v)throw new Error('VIDEO_NOT_FOUND');if(status==='PUBLISHED'){if(localOnly&&isPlaceholder(v))throw new Error('PLACEHOLDER_MEDIA_REMOVED');const rows=(s.sentences[String(id)]||[]).map((row,index)=>normalizeSentence(row,id,index));const issues=learningContract?.videoPublishIssues(v,rows)||[];if(issues.length){const error=new Error(issues[0].code);error.issues=issues;throw error}}v.status=status;v.publishedAt=status==='PUBLISHED'?(v.publishedAt||now()):v.publishedAt;v.updatedAt=now();save(s,{type:'video.status',entityId:id,status});return deep(v)}
  function isPlaceholder(video){
    const path=String(video.mediaUrl||'').replace(/^(\.\/|\.\.\/|\/)/,'').split(/[?#]/)[0];
    return Number.isInteger(Number(video.id))&&Number(video.id)>=2805&&Number(video.id)<=2813&&path==='assets/video/sample_lesson.mp4'
      &&!video.localStudioJobId&&!video.mediaKey&&!video.playback&&!video.processingEvidence;
  }
  function moveToTrash(s,video,reason){
    const key=String(video.id),jobs=s.jobs.filter(j=>String(j.videoId)===key),deletedAt=now();
    s.trash=s.trash||[];s.tombstones=s.tombstones||{};
    s.trash.unshift({video:deep(video),sentences:deep(s.sentences[key]||[]),jobs:deep(jobs),deletedAt,reason});
    s.tombstones[key]={deleted:true,deletedAt,ignoredJobIds:[...new Set([...(s.tombstones[key]?.ignoredJobIds||[]),video.localStudioJobId,...jobs.map(j=>j.id)].filter(Boolean))]};
    s.videos=s.videos.filter(v=>String(v.id)!==key);delete s.sentences[key];s.jobs=s.jobs.filter(j=>String(j.videoId)!==key);
  }
  function deleteVideos(ids){
    if(!localOnly)throw new Error('LOCAL_DELETE_ONLY');
    const s=load(),keys=new Set(ids.map(String)),videos=s.videos.filter(v=>keys.has(String(v.id)));
    for(const video of videos)moveToTrash(s,video,'admin-delete');
    if(videos.length)save(s,{type:'video.delete',entityIds:videos.map(v=>v.id),count:videos.length});
    return videos.length;
  }
  function deleteVideo(id){return deleteVideos([id])}
  function listTrash(){return deep(load().trash||[])}
  function restoreVideo(id){
    if(!localOnly)throw new Error('LOCAL_DELETE_ONLY');
    const s=load(),key=String(id),entry=(s.trash||[]).find(row=>String(row.video.id)===key);
    if(!entry)throw new Error('TRASH_NOT_FOUND');
    if(s.videos.some(v=>String(v.id)===key))throw new Error('VIDEO_ID_CONFLICT');
    const video={...entry.video,status:'DRAFT',publishedAt:null,updatedAt:now()};
    s.videos.unshift(video);s.sentences[key]=entry.sentences;s.jobs.push(...entry.jobs);
    s.trash=s.trash.filter(row=>String(row.video.id)!==key);s.tombstones[key]={...s.tombstones[key],deleted:false};
    save(s,{type:'video.restore',entityId:id});return deep(video);
  }
  function acceptsJob(videoId,jobId){const s=load(),t=s.tombstones?.[String(videoId)],v=s.videos.find(v=>String(v.id)===String(videoId));return !t?.deleted&&!(t?.ignoredJobIds||[]).includes(jobId)&&(!v||v.localStudioJobId===jobId)}
  function allowJobRetry(videoId,jobId){const s=load(),v=s.videos.find(v=>String(v.id)===String(videoId));if(!v||s.tombstones?.[String(videoId)]?.deleted)throw new Error('VIDEO_NOT_FOUND');if(v.localStudioJobId!==jobId)throw new Error('JOB_ID_CONFLICT');const marker=s.tombstones?.[String(videoId)];if(marker){marker.ignoredJobIds=marker.ignoredJobIds.filter(id=>id!==jobId);save(s,{type:'pipeline.retry-authorized',videoId})}}
  function listSentences(videoId){return deep(((load().sentences||{})[String(videoId)]||[]).map((x,i)=>normalizeSentence(x,videoId,i)))}
  function saveSentence(videoId,input){const s=load();if(!s.videos.some(v=>String(v.id)===String(videoId)))throw new Error('VIDEO_NOT_FOUND');const key=String(videoId);s.sentences[key]=s.sentences[key]||[];const id=input.id||`${key}-${Date.now()}`;const idx=s.sentences[key].findIndex(x=>x.id===id);const prev=idx>=0?s.sentences[key][idx]:{};const next=normalizeSentence({...prev,...deep(input),id},videoId,idx>=0?prev.order:s.sentences[key].length);if(idx>=0)s.sentences[key][idx]=next;else s.sentences[key].push(next);s.sentences[key].sort((a,b)=>a.order-b.order||a.startTime-b.startTime);save(s,{type:'sentence.save',entityId:id,videoId:Number(videoId)});return deep(next)}
  function replaceSentences(videoId,rows){const s=load();if(!s.videos.some(v=>String(v.id)===String(videoId)))throw new Error('VIDEO_NOT_FOUND');s.sentences[String(videoId)]=deep(rows).map((x,i)=>normalizeSentence({...x,id:x.id||`${videoId}-${i+1}`},videoId,i));save(s,{type:'sentences.replace',videoId:Number(videoId),count:rows.length});}
  function validCreatorName(value){const name=String(value??'').trim();if(!name||/^(null|undefined)$/i.test(name)||name.length>80)throw new Error('CREATOR_NAME_INVALID');return name}
  function listCreators(options={}){const rows=load().creators||[];return deep(options.includeDeleted?rows:rows.filter(x=>x.status!=='DELETED'))}
  function saveCreator(input){const s=load(),id=input.id||'creator-'+Date.now(),idx=s.creators.findIndex(x=>x.id===id),previous=idx>=0?s.creators[idx]:{};const next={...previous,...deep(input),id,name:validCreatorName(input.name??previous.name),status:input.status||previous.status||'ACTIVE',deletedAt:input.status==='ACTIVE'?null:(input.deletedAt??previous.deletedAt)};if(idx>=0)s.creators[idx]=next;else s.creators.unshift(next);save(s,{type:'creator.save',entityId:id,name:next.name});return deep(next)}
  function deleteCreator(id,replacementId=null){const s=load(),idx=s.creators.findIndex(x=>String(x.id)===String(id));if(idx<0)throw new Error('CREATOR_NOT_FOUND');const linked=[...(s.videos||[]),...(s.trash||[]).map(x=>x.video)].filter(v=>v&&String(v.creatorId)===String(id));let replacement=null;if(linked.length){replacement=s.creators.find(x=>String(x.id)===String(replacementId)&&x.status!=='DELETED');if(!replacement||String(replacement.id)===String(id))throw new Error('CREATOR_REPLACEMENT_REQUIRED');for(const video of s.videos||[])if(String(video.creatorId)===String(id)){video.creatorId=replacement.id;video.creator=replacement.name}for(const entry of s.trash||[])if(String(entry.video?.creatorId)===String(id)){entry.video.creatorId=replacement.id;entry.video.creator=replacement.name}}
    const creator=s.creators[idx];creator.status='DELETED';creator.deletedAt=now();save(s,{type:'creator.delete',entityId:id,replacementId:replacement?.id||null,linkedCount:linked.length});return deep(creator)}
  function restoreCreator(id){const s=load(),creator=s.creators.find(x=>String(x.id)===String(id));if(!creator)throw new Error('CREATOR_NOT_FOUND');creator.status='ACTIVE';creator.deletedAt=null;save(s,{type:'creator.restore',entityId:id});return deep(creator)}
  function listCollections(){return deep(load().collections||[])}
  function saveCollection(input){const s=load();const id=input.id||Date.now();const idx=s.collections.findIndex(x=>String(x.id)===String(id));const next={...(idx>=0?s.collections[idx]:{}),...deep(input),id};if(idx>=0)s.collections[idx]=next;else s.collections.unshift(next);save(s,{type:'collection.save',entityId:id,title:next.title});return deep(next)}
  function listJobs(){return deep(load().jobs||[])}
  const PIPELINE_STEPS=['upload','probe','transcode','asr','enrich','review'];
  function pipelineJob(s,videoId,input={}){let job=s.jobs.find(j=>String(j.videoId)===String(videoId));if(!job){job={id:input.id||'job-'+videoId+'-'+Date.now(),videoId:Number(videoId),type:'PIPELINE',createdAt:now()};s.jobs.unshift(job)}return job}
  function startPipeline(videoId,input={}){const s=load(),v=s.videos.find(x=>String(x.id)===String(videoId));if(!v)throw new Error('VIDEO_NOT_FOUND');const job=pipelineJob(s,videoId,input);job.id=input.id||job.id;job.status='PROCESSING';job.progress=Number.isFinite(input.progress)?Math.max(0,Math.min(99,input.progress)):0;job.currentStep=input.currentStep||'upload';job.steps=PIPELINE_STEPS.map(name=>[name,name===job.currentStep?'PROCESSING':'WAITING']);job.error=null;job.updatedAt=now();v.pipelineStatus='PROCESSING';if(v.status==='DRAFT')v.status='PROCESSING';save(s,{type:'pipeline.start',videoId:Number(videoId),jobId:job.id});return deep(job)}
  function updatePipeline(videoId,input={}){const s=load(),job=pipelineJob(s,videoId,input),v=s.videos.find(x=>String(x.id)===String(videoId));if(!v)throw new Error('VIDEO_NOT_FOUND');const status=String(input.status||'PROCESSING');if(!['PROCESSING','ERROR'].includes(status))throw new Error('PIPELINE_TERMINAL_STATE_REQUIRES_RESULT');job.id=input.id||job.id;job.status=status;job.progress=Math.max(0,Math.min(99,Number(input.progress)||0));job.currentStep=input.currentStep||job.currentStep||'upload';job.steps=PIPELINE_STEPS.map(name=>[name,name===job.currentStep?(status==='ERROR'?'ERROR':'PROCESSING'):PIPELINE_STEPS.indexOf(name)<PIPELINE_STEPS.indexOf(job.currentStep)?'SUCCESS':'WAITING']);job.error=input.error||null;job.updatedAt=now();v.pipelineStatus=status;v.status=status==='ERROR'?'DRAFT':'PROCESSING';save(s,{type:'pipeline.update',videoId:Number(videoId),jobId:job.id,step:job.currentStep,status});return deep(job)}
  function completePipeline(videoId,input={}){const s=load(),v=s.videos.find(x=>String(x.id)===String(videoId));if(!v)throw new Error('VIDEO_NOT_FOUND');const rows=Array.isArray(input.sentences)?input.sentences:[];const mediaUrl=String(input.video?.mediaUrl||v.mediaUrl||'');if(!rows.length)throw new Error('ASR_EMPTY');if(!mediaUrl)throw new Error('PIPELINE_MEDIA_MISSING');s.sentences[String(videoId)]=rows.map((row,index)=>normalizeSentence({...row,id:row.id||`${videoId}-${index+1}`,reviewStatus:'REVIEW'},videoId,index));Object.assign(v,deep(input.video||{}),{mediaUrl,pipelineStatus:'READY',status:'REVIEW',updatedAt:now(),processingEvidence:deep(input.evidence||{})});const job=pipelineJob(s,videoId,input);job.id=input.id||job.id;job.status='REVIEW';job.progress=100;job.currentStep='review';job.steps=PIPELINE_STEPS.map(name=>[name,name==='review'?'WAITING':'SUCCESS']);job.error=null;job.updatedAt=now();save(s,{type:'pipeline.complete',videoId:Number(videoId),jobId:job.id,count:rows.length});return deep(job)}
  function failPipeline(videoId,error={}){return updatePipeline(videoId,{...error,status:'ERROR',currentStep:error.currentStep||'unknown'})}
  function advancePipeline(){throw new Error('PIPELINE_SERVER_REQUIRED')}
  function audit(){
    const s=load(),issues=[],ids=new Set();
    for(const v of s.videos||[]){
      if(ids.has(String(v.id)))issues.push({severity:'ERROR',code:'DUPLICATE_VIDEO_ID',entityId:v.id});ids.add(String(v.id));
      if(!v.title)issues.push({severity:'ERROR',code:'VIDEO_TITLE_EMPTY',entityId:v.id});
      if(!v.titleZh)issues.push({severity:'WARN',code:'VIDEO_TITLE_ZH_MISSING',entityId:v.id});
      if(!v.creatorId||!(s.creators||[]).some(c=>c.id===v.creatorId))issues.push({severity:'ERROR',code:'VIDEO_CREATOR_MISSING',entityId:v.id});
      const rows=(s.sentences||{})[String(v.id)]||[];
      if(v.status==='PUBLISHED' && !v.mediaUrl)issues.push({severity:'ERROR',code:'PUBLISHED_MEDIA_MISSING',entityId:v.id});
      if(v.status==='PUBLISHED' && !rows.length)issues.push({severity:'WARN',code:'LEGACY_PUBLISHED_SUBTITLES_MISSING',entityId:v.id});
      if(v.status==='PUBLISHED' && rows.some(row=>row.reviewStatus!=='APPROVED'))issues.push({severity:'ERROR',code:'PUBLISHED_REVIEW_MISSING',entityId:v.id});
      if(v.status==='PUBLISHED'&&learningContract)for(const issue of learningContract.videoPublishIssues(v,rows))issues.push({severity:'ERROR',...issue,entityId:issue.sentenceId||v.id});
      let prevEnd=-1;
      for(const row of rows){if(!(row.endTime>row.startTime))issues.push({severity:'ERROR',code:'INVALID_SENTENCE_RANGE',entityId:row.id});if(row.startTime<prevEnd-0.001)issues.push({severity:'WARN',code:'SENTENCE_OVERLAP',entityId:row.id});if(row.keyWords!=null&&!Array.isArray(row.keyWords))issues.push({severity:'ERROR',code:'INVALID_KEYWORDS',entityId:row.id});if(!Array.isArray(row.keyWords)||!row.keyWords.length)issues.push({severity:'WARN',code:'KEY_EXPRESSION_MISSING',entityId:row.id});if(!String(row.grammar||row.grammarNote||'').trim())issues.push({severity:'WARN',code:'GRAMMAR_ANALYSIS_MISSING',entityId:row.id});const words=normalizeWordTimings(row.wordTimings,row.english,row.startTime,row.endTime);for(const word of words){if(word.start<row.startTime-.001||word.end>row.endTime+.001||word.end<=word.start)issues.push({severity:'ERROR',code:'INVALID_WORD_TIMING',entityId:row.id})}prevEnd=Math.max(prevEnd,row.endTime)}
    }
    const published=(s.videos||[]).filter(v=>v.status==='PUBLISHED');
    return {ok:issues.every(x=>x.severity!=='ERROR'),schemaVersion:s.schemaVersion,videoCount:s.videos.length,publishedCount:published.length,creatorCount:s.creators.length,collectionCount:s.collections.length,jobCount:s.jobs.length,issues};
  }
  function reset(){if(localOnly){deleteVideos(listVideos().map(v=>v.id));return snapshot()}return save(deep(seed),{type:'content.reset'})}
  global.ZoContent={KEY,SCOPE:scope,SCHEMA_VERSION,localOnly,allowJobRetry,isPlaceholder,deleteVideos,listTrash,restoreVideo,acceptsJob,snapshot,importSnapshot,listVideos,getVideo,saveVideo,setVideoStatus,deleteVideo,listSentences,saveSentence,replaceSentences,listCreators,saveCreator,deleteCreator,restoreCreator,listCollections,saveCollection,listJobs,startPipeline,updatePipeline,completePipeline,failPipeline,advancePipeline,audit,reset};
})(window);
