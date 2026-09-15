(function (global) {
  'use strict';
  const Audit = global.EastudyContentAudit;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const reviewIssue = issue => /^(SENTENCE|EXPRESSION)_REVIEW_REQUIRED$/.test(issue.code);
  const category = issue => reviewIssue(issue) ? '待确认' : /TIMING|RANGE|OVERLAP/.test(issue.code) ? '字幕时间' :
    /ANALYSIS|KEY_EXPRESSION|GRAMMAR/.test(issue.code) ? '教学分析' :
    issue.expressionKey || /EXPRESSION|KEYWORD|MEANING/.test(issue.code) ? '重点词卡' :
    issue.sentenceId ? '字幕资料' : '视频资料';
  const navigation = [
    {root:'/dashboard', links:[['/dashboard','工作台']]},
    {root:'/videos', links:[['/videos','视频库'],['/collections','合集'],['/creators','创作者'],['/trash','回收站']]},
    {root:'/pipeline', links:[['/pipeline','处理队列'],['/analytics','内容检查'],['/subtitles','字幕审核']]},
    {root:'/learners', links:[['/learners','学员管理'],['/invites','邀请码']]},
    {root:'/settings', links:[['/settings','系统设置']]}
  ];
  const groupFor = path => navigation.find(group => group.links.some(([route]) => path === route || path.startsWith(route + '/')));
  function tabs(path) {
    const group = groupFor(path);
    if (!group || group.links.length < 2) return '';
    return `<nav class="content-tabs" aria-label="板块功能">${group.links.map(([route, label]) => `<a href="#${route}" ${path === route || path.startsWith(route + '/') ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  }
  function create({cloud, store, show, active, repair, failureText}) {
    let result = null, revision = null, checkedAt = null, busy = false, error = '', actionError = '', jobSummary = null;
    let page = 1, selected = '', detailPage = 1, generation = 0;
    const pageSize = 8, detailSize = 20;
    function render() {
      if (!active()) return;
      const stats = result?.summary || {}, groups = result?.groups || [];
      const pages = Math.max(1, Math.ceil(groups.length / pageSize));
      page = Math.min(page, pages);
      const current = groups.find(g => String(g.video.id) === selected);
      const detailPages = Math.max(1, Math.ceil((current?.issues.length || 0) / detailSize));
      detailPage = Math.min(detailPage, detailPages);
      const metric = (title, value) => `<article class="metric-card"><span>${title}</span><strong>${value ?? '—'}</strong></article>`;
      show(`<div class="page-head"><div><h1>内容检查</h1><p>按视频定位问题，补齐资料后再确认发布。</p></div><button class="primary" data-content-refresh ${busy?'disabled':''}>${busy?'正在读取云端…':'重新检查'}</button></div>
        <p role="status">${error?`未取得最新数据：${escape(error)}。以下保留上次检查结果。`:checkedAt?`${store.localOnly?'本地检查':'云端检查'}时间：${escape(new Date(checkedAt).toLocaleString('zh-CN'))} · 内容版本 ${escape(revision)}`:'正在读取内容…'}</p>
        ${actionError?`<p role="alert">${escape(actionError)}</p>`:''}
        <div class="metric-grid">${metric('受影响视频',stats.affectedVideos)}${metric('待完善词卡',stats.wordCards)}${metric('待确认句子',stats.pendingSentences)}${metric('处理失败视频',jobSummary?.failed)}</div>
        <section class="audit-video-list">${groups.slice((page-1)*pageSize,page*pageSize).map(g => {
          const id=String(g.video.id), canRepair=g.issues.some(i=>i.sentenceId), canFill=g.issues.some(i=>i.sentenceId&&!reviewIssue(i)&&category(i)!=='字幕时间'), cover=String(g.video.cover||''), safeCover=/^(https?:\/\/|\/?assets\/)/.test(cover)?(cover.startsWith('assets/')?'../'+cover:cover):'', words=new Set(g.issues.filter(i=>i.expressionKey&&i.code!=='EXPRESSION_REVIEW_REQUIRED').map(i=>JSON.stringify([i.sentenceId,i.expressionKey])));
          return `<article class="panel audit-video">${safeCover?`<img class="audit-cover" src="${escape(safeCover)}" alt="" loading="lazy">`:''}<h2>${escape(g.video.titleZh||g.video.title||'未命名视频')}</h2><p>${new Set(g.issues.filter(i=>i.sentenceId).map(i=>i.sentenceId)).size} 句需要处理 · ${words.size} 张词卡待完善</p>
            <p class="audit-categories">${[...new Set(g.issues.map(category))].map(escape).join(' · ')} · ${g.issues.every(reviewIssue)?'等待人工确认':'待处理'}</p>
            <div class="audit-actions"><button class="secondary" data-content-details="${escape(id)}">查看问题</button><a class="ghost" href="#/videos/${encodeURIComponent(id)}">视频详情</a><button class="secondary" data-content-repair="${escape(id)}" data-mode="fill_missing" ${busy||!canFill?'disabled':''}>补齐教学资料</button><button class="ghost" data-content-repair="${escape(id)}" data-mode="reextract" ${busy||!canRepair?'disabled':''}>重新筛选重点表达</button><a class="ghost" href="#/pipeline/history/${encodeURIComponent(id)}">处理记录</a></div></article>`;
        }).join('') || (result?'<div class="empty">本次未发现内容结构问题。播放、权限与网络需单独验证。</div>':'')}
        </section><div class="learner-pagination"><button class="secondary" data-content-page="${page-1}" ${page<=1?'disabled':''}>上一页</button><span>${page} / ${pages}</span><button class="secondary" data-content-page="${page+1}" ${page>=pages?'disabled':''}>下一页</button></div>
        ${current?`<section class="panel audit-details"><h2>${escape(current.video.titleZh||current.video.title)} · 具体问题</h2>${current.issues.slice((detailPage-1)*detailSize,detailPage*detailSize).map(i=>`<article class="audit-issue"><b>${i.sentenceIndex?`第 ${i.sentenceIndex} 句`:'视频资料'}${i.expressionKey?` · ${escape(i.expressionKey)}`:''}</b><p>${escape(Audit.text(i))}</p><a class="secondary" href="#/${i.sentenceId?'subtitles':'videos'}/${encodeURIComponent(i.videoId)}${i.sentenceId?'?sentence='+encodeURIComponent(i.sentenceId):''}">打开对应${i.sentenceId?'句子':'视频'}</a><details><summary>技术详情</summary><pre>${escape(JSON.stringify(i,null,2))}</pre></details></article>`).join('')}<div class="learner-pagination"><button class="secondary" data-detail-page="${detailPage-1}" ${detailPage<=1?'disabled':''}>上一页问题</button><span>${detailPage} / ${detailPages}</span><button class="secondary" data-detail-page="${detailPage+1}" ${detailPage>=detailPages?'disabled':''}>下一页问题</button></div></section>`:''}
        <details><summary>检查范围与技术统计</summary><p>底层字段记录 ${result?.issues.length ?? '—'} 项；同一词卡可对应多项。检查不会修改数据或启动 AI，也不代表所有功能已实测。</p></details>`);
      document.querySelector('[data-content-refresh]')?.addEventListener('click',refresh);
      for(const b of document.querySelectorAll('[data-content-page]'))b.onclick=()=>{page=Number(b.dataset.contentPage);selected='';render()};
      for(const b of document.querySelectorAll('[data-detail-page]'))b.onclick=()=>{detailPage=Number(b.dataset.detailPage);render()};
      for(const b of document.querySelectorAll('[data-content-details]'))b.onclick=()=>{selected=b.dataset.contentDetails;detailPage=1;render();document.querySelector('.audit-details')?.scrollIntoView({block:'start'})};
      for(const b of document.querySelectorAll('[data-content-repair]'))b.onclick=async()=>{
        if(busy)return;
        const mode=b.dataset.mode;
        if(mode==='reextract'&&!global.confirm('重新筛选会调整未锁定的 AI 选词，保留人工锁定项和时间轴；完成后仍需确认。继续吗？'))return;
        const token=generation;busy=true;actionError='';render();
        try{await repair(b.dataset.contentRepair,mode,revision);if(token===generation&&active())global.location.hash='#/pipeline'}
        catch(e){if(token===generation)actionError=failureText(e)}finally{if(token===generation){busy=false;render()}}
      };
    }
    async function refresh() {
      if(busy)return;
      const token=++generation;busy=true;error='';actionError='';render();
      try {
        const response=store.localOnly?{snapshot:store.snapshot(),revision:'本地'}:await cloud.pullAdmin();
        if(response.error)throw response.error;
        if(!response.snapshot||!Array.isArray(response.snapshot.videos)||(!store.localOnly&&!Number.isSafeInteger(Number(response.revision))))throw new Error('内容响应不完整，请稍后重试');
        const next=Audit.inspect(response.snapshot);
        const jobs=store.localOnly?{summary:Audit.processingSummary(response.snapshot.jobs||[])}:await cloud.listProcessingJobs(1,1);
        if(jobs.error)throw jobs.error;
        if(token!==generation)return;
        result=next;revision=response.revision;checkedAt=Date.now();jobSummary=jobs.summary||null;
      }catch(e){if(token===generation)error=failureText(e)}
      finally{if(token===generation){busy=false;render()}}
    }
    function open(){render();if(!result&&!busy)void refresh()}
    function reset(){generation++;result=null;revision=null;checkedAt=null;busy=false;error='';actionError='';jobSummary=null;selected='';page=1}
    return {open,refresh,reset};
  }
  global.EastudyContentCheck=Object.freeze({create,tabs,groupFor});
})(window);
