(function(global){
  'use strict';
  const KEY='zs:platform:content:v1';
  const SCHEMA_VERSION=2;
  const deep=x=>JSON.parse(JSON.stringify(x));
  const now=()=>new Date().toISOString();
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
    row.keyWords=Array.isArray(row.keyWords)?row.keyWords.map(normalizeKeyword).filter(Boolean):[];
    row.wordTimings=normalizeWordTimings(row.wordTimings,row.english,row.startTime,row.endTime);
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
    videos:[
      {id:2805,title:'How I Start My Day in the English Countryside',titleZh:'我在英国乡村如何开始一天',description:'Real-life comprehensible input from a calm English countryside morning.',creatorId:'creator-jojo',creator:'Jojo English',collectionIds:[36],goalIds:['daily'],level:'A2–B1',category:'日常生活',duration:30,cover:'assets/images/home_video_1.png',mediaUrl:'assets/video/sample_lesson.mp4',status:'PUBLISHED',pipelineStatus:'READY',publishedAt:'2026-08-28T08:00:00.000Z',updatedAt:now()},
      {id:2806,title:'A Slow Morning Routine With Natural English',titleZh:'用自然英语开启慢节奏早晨',description:'Slow natural English for everyday routines.',creatorId:'creator-jojo',creator:'Jojo English',collectionIds:[36,12],goalIds:['daily'],level:'A2',category:'日常生活',duration:1120,cover:'assets/images/home_video_2.png',mediaUrl:'assets/video/sample_lesson.mp4',status:'PUBLISHED',pipelineStatus:'READY',publishedAt:'2026-08-25T08:00:00.000Z',updatedAt:now()},
      {id:2807,title:'Cooking Dinner and Learning Everyday Phrases',titleZh:'边做晚餐边学日常表达',description:'Everyday phrases through cooking context.',creatorId:'creator-jojo',creator:'Jojo English',collectionIds:[12,105],level:'A2–B1',category:'美食',duration:1324,cover:'assets/images/home_video_3.png',mediaUrl:'assets/video/sample_lesson.mp4',status:'DRAFT',pipelineStatus:'REVIEW',publishedAt:null,updatedAt:now()},
      {id:2808,title:"Steve Jobs' 2005 Stanford Commencement Address",titleZh:'乔布斯 2005 年斯坦福毕业演讲',description:'A classic commencement speech for advanced listening.',creatorId:'creator-ted',creator:'TED Archive',collectionIds:[103,108],level:'B2',category:'科技',duration:857,cover:'assets/images/home_video_4.png',mediaUrl:'assets/video/sample_lesson.mp4',status:'PUBLISHED',pipelineStatus:'READY',publishedAt:'2026-08-14T08:00:00.000Z',updatedAt:now()},
      {id:2809,title:'The Psychology of Small Habits',titleZh:'微小习惯的心理学',description:'Psychology and habit-building through real English.',creatorId:'creator-mind',creator:'Mind Lab',collectionIds:[107],level:'B1',category:'心理',duration:684,cover:'assets/images/home_video_2.png',mediaUrl:'assets/video/sample_lesson.mp4',status:'PUBLISHED',pipelineStatus:'READY',publishedAt:'2026-08-09T08:00:00.000Z',updatedAt:now()},
      {id:2810,title:"Street Food Phrases You'll Hear Abroad",titleZh:'在海外街头会听到的美食表达',description:'Practical food and travel expressions.',creatorId:'creator-food',creator:'Food Talk',collectionIds:[105,102],goalIds:['daily'],level:'A2',category:'美食',duration:521,cover:'assets/images/home_video_4.png',mediaUrl:'assets/video/sample_lesson.mp4',status:'PUBLISHED',pipelineStatus:'READY',publishedAt:'2026-08-03T08:00:00.000Z',updatedAt:now()},
      {id:2811,title:'Useful Office English for Daily Meetings',titleZh:'日常会议实用职场英语',description:'Everyday meeting phrases for workplace communication.',creatorId:'creator-work',creator:'Work English',collectionIds:[104],level:'B1',category:'职场',duration:832,cover:'assets/images/home_video_1.png',mediaUrl:'assets/video/sample_lesson.mp4',status:'PUBLISHED',pipelineStatus:'READY',publishedAt:'2026-08-01T08:00:00.000Z',updatedAt:now()},
      {id:2812,title:'Nature Walk English: Forest Sounds and Words',titleZh:'自然漫步英语：森林声音与词汇',description:'Simple nature vocabulary in a calm listening context.',creatorId:'creator-nature',creator:'Nature Notes',collectionIds:[106],goalIds:['daily'],level:'A1',category:'自然',duration:603,cover:'assets/images/home_video_3.png',mediaUrl:'assets/video/sample_lesson.mp4',status:'PUBLISHED',pipelineStatus:'READY',publishedAt:'2026-07-30T08:00:00.000Z',updatedAt:now()},
      {id:2813,title:'Top Real-English Picks This Week',titleZh:'本周精选真实英语',description:'Curated real-English highlights from this week.',creatorId:'creator-curated',creator:'ZoSpeak Curated',collectionIds:[109],level:'A2',category:'热门',duration:648,cover:'assets/images/home_video_4.png',mediaUrl:'assets/video/sample_lesson.mp4',status:'PUBLISHED',pipelineStatus:'READY',publishedAt:'2026-07-28T08:00:00.000Z',updatedAt:now()}
    ],
    sentences:{
      '2805':[
        {id:'2805-1',videoId:2805,order:0,startTime:0,endTime:3.3,english:'Good morning.',chinese:'早上好。',keyWords:['Good morning'],grammar:'Good + 时间段构成问候语；这是省略主语和谓语的固定寒暄表达。',reviewStatus:'APPROVED'},
        {id:'2805-2',videoId:2805,order:1,startTime:3.3,endTime:6.3,english:"Today, I've got a long to-do list.",chinese:'今天，我有一长串待办事项。',keyWords:['have got','to-do list'],grammar:'Today 作时间状语；have got + 名词表示“拥有”，to-do 作复合定语修饰 list。',reviewStatus:'APPROVED'},
        {id:'2805-3',videoId:2805,order:2,startTime:6.3,endTime:9.2,english:"And I'm taking you with me to get it done.",chinese:'我要带着你一起把它们完成。',keyWords:['taking you with me','get it done'],grammar:'am taking 构成现在进行时；to get it done 是目的状语，get + 宾语 + done 表示“使某事完成”。',reviewStatus:'APPROVED'},
        {id:'2805-4',videoId:2805,order:3,startTime:9.2,endTime:12.4,english:"Along the way, we'll learn some English.",chinese:'一路上，我们还会学一些英语。',keyWords:['along the way'],grammar:'will + 动词原形表示将要；along the way 表示“一路上”。',reviewStatus:'APPROVED'},
        {id:'2805-5',videoId:2805,order:4,startTime:12.4,endTime:14,english:'Jojo.',chinese:'乔乔。',keyWords:['Jojo'],grammar:'人名作独立句，语调通常下降。',reviewStatus:'APPROVED'},
        {id:'2805-6',videoId:2805,order:5,startTime:14,endTime:16.4,english:'This is rhubarb.',chinese:'这是大黄。',keyWords:['This is','rhubarb'],grammar:'This is + 名词构成主系表结构，用于指认或介绍眼前的人或事物。',reviewStatus:'APPROVED'},
        {id:'2805-7',videoId:2805,order:6,startTime:16.4,endTime:20.2,english:"I'm picking it now so the rabbits don't get to it first.",chinese:'我现在就把它摘了，免得兔子先下手。',keyWords:['picking it','get to it first'],grammar:'am picking 是现在进行时；so 引导目的关系，don’t get to it 表示避免兔子先碰到它。',reviewStatus:'APPROVED'},
        {id:'2805-8',videoId:2805,order:7,startTime:20.2,endTime:24.2,english:"This evening, I'm going to make a crumble.",chinese:'今晚我要做个酥皮点心。',keyWords:['make a crumble','going to'],grammar:'This evening 作时间状语；be going to + 动词原形表示已经形成的计划。',reviewStatus:'APPROVED'},
        {id:'2805-9',videoId:2805,order:8,startTime:24.2,endTime:27.4,english:"So, let's take it to the kitchen.",chinese:'那么，我们把它拿到厨房去吧。',keyWords:['take it to','let\'s take'],grammar:"So 承接上文；let's + 动词原形用于提出共同建议，take A to B 表示把 A 带到 B。",reviewStatus:'APPROVED'},
        {id:'2805-10',videoId:2805,order:9,startTime:27.4,endTime:30,english:'Come on.',chinese:'来吧。',keyWords:['Come on'],grammar:'祈使表达 Come on 可表示催促或鼓励，语气由上下文决定。',reviewStatus:'APPROVED'}
      ]
    },
    jobs:[
      {id:'job-2805',videoId:2805,type:'PIPELINE',status:'SUCCESS',progress:100,currentStep:'publish',steps:[['download','SUCCESS'],['extract_audio','SUCCESS'],['whisperx','SUCCESS'],['translate','SUCCESS'],['dictionary','SUCCESS'],['learning_analysis','SUCCESS'],['review','SUCCESS']],createdAt:now(),updatedAt:now()},
      {id:'job-2807',videoId:2807,type:'PIPELINE',status:'REVIEW',progress:86,currentStep:'review',steps:[['download','SUCCESS'],['extract_audio','SUCCESS'],['whisperx','SUCCESS'],['translate','SUCCESS'],['dictionary','SUCCESS'],['learning_analysis','SUCCESS'],['review','WAITING']],createdAt:now(),updatedAt:now()}
    ],
    auditLog:[]
  };
  function migrate(parsed){
    if(!parsed||typeof parsed!=='object')return deep(seed);
    const seedVideos=new Map(seed.videos.map(v=>[String(v.id),v]));
    parsed.videos=(parsed.videos||[]).map(v=>{
      const base=seedVideos.get(String(v.id))||{};
      return {...v,titleZh:v.titleZh||v.aiAnalysis?.titleZh||base.titleZh||'',goalIds:Array.isArray(v.goalIds)?v.goalIds:(base.goalIds||[]),goalMappings:Array.isArray(v.goalMappings)?v.goalMappings:[]};
    });
    parsed.sentences=parsed.sentences||{};
    for(const [videoId,rows] of Object.entries(parsed.sentences)){
      const seedRows=new Map((seed.sentences[videoId]||[]).map(row=>[String(row.id),row]));
      parsed.sentences[videoId]=(rows||[]).map(row=>{
        const base=seedRows.get(String(row.id))||{};
        return {...row,keyWords:Array.isArray(row.keyWords)&&row.keyWords.length?row.keyWords:(base.keyWords||[]),grammar:row.grammar||row.grammarNote||base.grammar||''};
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
    try{
      const raw=localStorage.getItem(KEY);
      if(!raw) return deep(seed);
      const parsed=JSON.parse(raw);
      if(!parsed||typeof parsed!=='object')return deep(seed);
      if(Number(parsed.schemaVersion)>SCHEMA_VERSION)return deep(seed);
      const fromVersion=Number(parsed.schemaVersion)||1;
      const migrated=migrate(parsed);
      if(fromVersion!==SCHEMA_VERSION)localStorage.setItem(KEY,JSON.stringify(migrated));
      return migrated;
    }catch(e){return deep(seed)}
  }
  function save(state,event){
    state.schemaVersion=SCHEMA_VERSION;
    if(event){state.auditLog=state.auditLog||[];state.auditLog.unshift({id:'audit-'+Date.now(),at:now(),...event});state.auditLog=state.auditLog.slice(0,200)}
    localStorage.setItem(KEY,JSON.stringify(state));
    global.dispatchEvent(new CustomEvent('zospeak:content-changed',{detail:event||{type:'save'}}));
    return deep(state);
  }
  function snapshot(){return deep(load())}
  function importSnapshot(input,event={type:'cloud.import'}){
    if(!input||typeof input!=='object'||!Array.isArray(input.videos))throw new Error('INVALID_CONTENT_SNAPSHOT');
    const migrated=migrate(deep(input));
    return save(migrated,event);
  }
  function listVideos(opts={}){const s=load();let rows=s.videos||[];if(opts.publishedOnly)rows=rows.filter(v=>v.status==='PUBLISHED');return deep(rows)}
  function getVideo(id){return deep((load().videos||[]).find(v=>String(v.id)===String(id))||null)}
  function saveVideo(input){const s=load();const id=input.id??Date.now();const idx=s.videos.findIndex(v=>String(v.id)===String(id));const prev=idx>=0?s.videos[idx]:{};const next={...prev,...deep(input),id,updatedAt:now()};if(idx>=0)s.videos[idx]=next;else s.videos.unshift(next);save(s,{type:idx>=0?'video.update':'video.create',entityId:id,title:next.title});return deep(next)}
  function setVideoStatus(id,status){const s=load();const v=s.videos.find(x=>String(x.id)===String(id));if(!v)throw new Error('VIDEO_NOT_FOUND');v.status=status;v.publishedAt=status==='PUBLISHED'?(v.publishedAt||now()):v.publishedAt;v.updatedAt=now();save(s,{type:'video.status',entityId:id,status});return deep(v)}
  function deleteVideo(id){const s=load();s.videos=s.videos.filter(v=>String(v.id)!==String(id));delete s.sentences[String(id)];s.jobs=s.jobs.filter(j=>String(j.videoId)!==String(id));save(s,{type:'video.delete',entityId:id});}
  function listSentences(videoId){return deep(((load().sentences||{})[String(videoId)]||[]).map((x,i)=>normalizeSentence(x,videoId,i)))}
  function saveSentence(videoId,input){const s=load();const key=String(videoId);s.sentences[key]=s.sentences[key]||[];const id=input.id||`${key}-${Date.now()}`;const idx=s.sentences[key].findIndex(x=>x.id===id);const prev=idx>=0?s.sentences[key][idx]:{};const next=normalizeSentence({...prev,...deep(input),id},videoId,idx>=0?prev.order:s.sentences[key].length);if(idx>=0)s.sentences[key][idx]=next;else s.sentences[key].push(next);s.sentences[key].sort((a,b)=>a.order-b.order||a.startTime-b.startTime);save(s,{type:'sentence.save',entityId:id,videoId:Number(videoId)});return deep(next)}
  function replaceSentences(videoId,rows){const s=load();s.sentences[String(videoId)]=deep(rows).map((x,i)=>normalizeSentence({...x,id:x.id||`${videoId}-${i+1}`},videoId,i));save(s,{type:'sentences.replace',videoId:Number(videoId),count:rows.length});}
  function listCreators(){return deep(load().creators||[])}
  function saveCreator(input){const s=load();const id=input.id||'creator-'+Date.now();const idx=s.creators.findIndex(x=>x.id===id);const next={...(idx>=0?s.creators[idx]:{}),...deep(input),id};if(idx>=0)s.creators[idx]=next;else s.creators.unshift(next);save(s,{type:'creator.save',entityId:id,name:next.name});return deep(next)}
  function listCollections(){return deep(load().collections||[])}
  function saveCollection(input){const s=load();const id=input.id||Date.now();const idx=s.collections.findIndex(x=>String(x.id)===String(id));const next={...(idx>=0?s.collections[idx]:{}),...deep(input),id};if(idx>=0)s.collections[idx]=next;else s.collections.unshift(next);save(s,{type:'collection.save',entityId:id,title:next.title});return deep(next)}
  function listJobs(){return deep(load().jobs||[])}
  function startPipeline(videoId){const s=load();let job=s.jobs.find(j=>String(j.videoId)===String(videoId));if(!job){job={id:'job-'+videoId+'-'+Date.now(),videoId:Number(videoId),type:'PIPELINE',createdAt:now()};s.jobs.unshift(job)}job.status='PROCESSING';job.progress=8;job.currentStep='download';job.steps=[['download','PROCESSING'],['extract_audio','WAITING'],['whisperx','WAITING'],['translate','WAITING'],['dictionary','WAITING'],['learning_analysis','WAITING'],['review','WAITING']];job.updatedAt=now();const v=s.videos.find(x=>String(x.id)===String(videoId));if(v){v.pipelineStatus='PROCESSING';if(v.status==='DRAFT')v.status='PROCESSING'}save(s,{type:'pipeline.start',videoId:Number(videoId),jobId:job.id});return deep(job)}
  function advancePipeline(videoId){const s=load();const job=s.jobs.find(j=>String(j.videoId)===String(videoId));if(!job)throw new Error('JOB_NOT_FOUND');const steps=['download','extract_audio','whisperx','translate','dictionary','learning_analysis','review'];let idx=steps.indexOf(job.currentStep);if(idx<0)idx=0;if(idx<steps.length-1){job.steps[idx][1]='SUCCESS';idx++;job.currentStep=steps[idx];job.steps[idx][1]=idx===steps.length-1?'WAITING':'PROCESSING';job.progress=Math.min(95,Math.round((idx/steps.length)*100));job.status=idx===steps.length-1?'REVIEW':'PROCESSING'}else{job.steps[idx][1]='SUCCESS';job.progress=100;job.status='SUCCESS';job.currentStep='publish'}job.updatedAt=now();const v=s.videos.find(x=>String(x.id)===String(videoId));if(v){v.pipelineStatus=job.status==='SUCCESS'?'READY':job.status;v.status=job.status==='REVIEW'?'REVIEW':v.status}save(s,{type:'pipeline.advance',videoId:Number(videoId),step:job.currentStep,status:job.status});return deep(job)}
  function audit(){
    const s=load(),issues=[],ids=new Set();
    for(const v of s.videos||[]){
      if(ids.has(String(v.id)))issues.push({severity:'ERROR',code:'DUPLICATE_VIDEO_ID',entityId:v.id});ids.add(String(v.id));
      if(!v.title)issues.push({severity:'ERROR',code:'VIDEO_TITLE_EMPTY',entityId:v.id});
      if(!v.titleZh)issues.push({severity:'WARN',code:'VIDEO_TITLE_ZH_MISSING',entityId:v.id});
      if(!v.creatorId||!(s.creators||[]).some(c=>c.id===v.creatorId))issues.push({severity:'ERROR',code:'VIDEO_CREATOR_MISSING',entityId:v.id});
      if(v.status==='PUBLISHED' && !v.mediaUrl)issues.push({severity:'ERROR',code:'PUBLISHED_MEDIA_MISSING',entityId:v.id});
      const rows=(s.sentences||{})[String(v.id)]||[];
      let prevEnd=-1;
      for(const row of rows){if(!(row.endTime>row.startTime))issues.push({severity:'ERROR',code:'INVALID_SENTENCE_RANGE',entityId:row.id});if(row.startTime<prevEnd-0.001)issues.push({severity:'WARN',code:'SENTENCE_OVERLAP',entityId:row.id});if(row.keyWords!=null&&!Array.isArray(row.keyWords))issues.push({severity:'ERROR',code:'INVALID_KEYWORDS',entityId:row.id});if(!Array.isArray(row.keyWords)||!row.keyWords.length)issues.push({severity:'WARN',code:'KEY_EXPRESSION_MISSING',entityId:row.id});if(!String(row.grammar||row.grammarNote||'').trim())issues.push({severity:'WARN',code:'GRAMMAR_ANALYSIS_MISSING',entityId:row.id});const words=normalizeWordTimings(row.wordTimings,row.english,row.startTime,row.endTime);for(const word of words){if(word.start<row.startTime-.001||word.end>row.endTime+.001||word.end<=word.start)issues.push({severity:'ERROR',code:'INVALID_WORD_TIMING',entityId:row.id})}prevEnd=Math.max(prevEnd,row.endTime)}
    }
    const published=(s.videos||[]).filter(v=>v.status==='PUBLISHED');
    return {ok:issues.every(x=>x.severity!=='ERROR'),schemaVersion:s.schemaVersion,videoCount:s.videos.length,publishedCount:published.length,creatorCount:s.creators.length,collectionCount:s.collections.length,jobCount:s.jobs.length,issues};
  }
  function reset(){localStorage.removeItem(KEY);return snapshot()}
  global.ZoContent={KEY,SCHEMA_VERSION,snapshot,importSnapshot,listVideos,getVideo,saveVideo,setVideoStatus,deleteVideo,listSentences,saveSentence,replaceSentences,listCreators,saveCreator,listCollections,saveCollection,listJobs,startPipeline,advancePipeline,audit,reset};
})(window);
