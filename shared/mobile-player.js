/* M04: mobile controls compose existing playback and learning actions. */
(function(global){
 'use strict';
 let config, initialized=false, pinned=null;
 const $=id=>document.getElementById(id);
 function element(tag,id,html,parent){const node=document.createElement(tag);node.id=id;node.innerHTML=html;parent.append(node);return node}
 function closeAll(){for(const id of ['lessonMore','videoSwitchPanel','playerWordPanel'])if($(id)?.open)$(id).close()}
 function dialog(id,label,body,page){
  const node=element('dialog',id,'<header><b>'+label+'</b><button type="button" data-close>关闭</button></header>'+body,page);
  node.setAttribute('aria-label',label);
  node.querySelector('[data-close]').onclick=()=>node.close();
  node.addEventListener('click',event=>{if(event.target!==node)return;const r=node.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)node.close()});
  return node;
 }
 function open(node,trigger){closeAll();node._trigger=trigger;node.showModal();node.onclose=()=>{if(trigger?.isConnected&&trigger.getClientRects().length)trigger.focus()}}
 function geometry(){config.updateMobilePlayerGeometry();const height=config.page.querySelector('.mobile-learning-dock').getBoundingClientRect().height;config.page.style.setProperty('--lesson-dock-height',height+'px')}
 function initialize(){
  const page=config.page;
  element('div','videoQueueControls','<button type="button" id="previousVideo">上一条视频</button><button type="button" id="openQueueDirectory">视频目录</button><button type="button" id="nextVideo">下一条视频</button><label><input type="checkbox" id="autoplayNext" checked>自动连播</label>',page).className='video-queue-controls';
  const more=dialog('lessonMore','更多与句子操作','<div class="lesson-more-grid"></div><div class="sentence-menu"><button type="button" id="copyPinnedSentence">复制此句</button><button type="button" id="savePinnedSentence">收藏 / 取消收藏此句</button></div><div class="playback-options-body"></div>',page);
  more.className='lesson-more';
  const switcher=dialog('videoSwitchPanel','视频切换','<div id="videoSwitchBody"></div>',page);
  const dock=element('div','mobileLearningDock','<div class="learning-dock-links"><button type="button" id="openTeachingWords">重点词 <b id="teachingCount">—</b></button><button type="button" id="openSavedWords">生词本 <b id="savedWordCount">—</b></button><button type="button" id="openVideoSwitch">视频切换</button></div>',page);dock.className='mobile-learning-dock';
  const modes=element('div','mobileLearningTools','<label>字幕设置<select id="mobileCaptionMode"><option value="bilingual">双语</option><option value="english">英文</option><option value="chinese">中文</option><option value="hidden">隐藏</option></select></label><label>练习模式<select id="mobilePracticeMode"><option value="watch">连续播放</option><option value="intensive">逐句练习</option><option value="loop">循环跟读</option><option value="cloze">听写填空</option></select></label>',page);modes.className='mobile-learning-tools';
  $('mobileCaptionMode').onchange=e=>config.setCaptionMode(e.target.value);
  $('mobilePracticeMode').onchange=e=>config.setPracticeMode(e.target.value);
  element('button','dockLoop','循环',page).type='button';$('dockLoop').setAttribute('aria-label','单句循环');$('dockLoop').onclick=()=>config.setPracticeMode(config.state.practiceMode==='loop'?'watch':'loop');
  element('button','openLessonMore','更多',page).type='button';
  $('openLessonMore').onclick=()=>{pinned=config.captureSentence();for(const id of ['copyPinnedSentence','savePinnedSentence'])$(id).disabled=!pinned.id;$('savePinnedSentence').textContent='收藏 / 取消收藏此句';geometry();open(more,$('openLessonMore'))};
  for(const [id,action] of [['copyPinnedSentence','copy'],['savePinnedSentence','save']])$(id).onclick=()=>config.sentenceAction(pinned,action,$(id));
  $('openVideoSwitch').onclick=()=>{config.renderQueueControls();open(switcher,$('openVideoSwitch'))};
  const directory=element('section','queueDirectory','<header><b>视频目录 <span id="queueDirectoryPosition"></span><button type="button" id="closeQueueDirectory">关闭目录</button></header><div id="queueDirectoryNavigation"></div><div id="queueDirectoryList"></div>',page);directory.className='queue-directory';directory.hidden=true;directory.setAttribute('role','dialog');directory.setAttribute('aria-label','视频目录');directory.setAttribute('aria-modal','true');
  $('closeQueueDirectory').onclick=()=>{directory.hidden=true;$('openQueueDirectory').focus()};
  directory.onkeydown=event=>{if(event.key==='Escape'){event.stopPropagation();$('closeQueueDirectory').click()}if(event.key==='Tab'){const buttons=[...directory.querySelectorAll('button:not(:disabled),input')].filter(x=>x.getClientRects().length),first=buttons[0],last=buttons.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}};
  const panel=dialog('playerWordPanel','词汇','<b id="playerWordTitle"></b><label><input type="checkbox" id="playerWordVideoOnly">只看本视频</label><div id="playerWordList"></div>',page);panel.setAttribute('aria-labelledby','playerWordTitle');panel.querySelector('[data-close]').id='closePlayerWords';
  $('playerWordVideoOnly').onchange=config.renderPlayerWordList;
  for(const [id,kind,title] of [['openTeachingWords','teaching','重点词'],['openSavedWords','saved','生词本']])$(id).onclick=()=>{panel.dataset.kind=kind;$('playerWordTitle').textContent=title;config.renderPlayerWordList();open(panel,$(id))};
  const nodes=[page.querySelector('.ctl-left'),page.querySelector('.speed-control'),$('sentenceInsight'),$('studyLangBtn'),$('studyThemeBtn'),$('openSettings'),page.querySelector('.timeline'),page.querySelector('.center-ctl'),$('openQueueDirectory'),$('openLessonMore')];
  for(const node of nodes){const anchor=document.createComment('desktop placement');node.before(anchor);node._desktopAnchor=anchor}
  const resize=new ResizeObserver(geometry);resize.observe(page);resize.observe(dock);
  document.addEventListener('fullscreenchange',closeAll);
  initialized=true;
 }
 function updateModes(state){if(!initialized)return;$('mobileCaptionMode').value=state.captionMode;$('mobilePracticeMode').value=state.practiceMode;$('dockLoop').setAttribute('aria-pressed',String(state.practiceMode==='loop'))}
 function sync(options){
  config=options;if(!initialized)initialize();
  const page=config.page,mobile=matchMedia('(max-width:850px)').matches,dock=$('mobileLearningDock'),links=dock.querySelector('.learning-dock-links'),center=page.querySelector('.center-ctl'),grid=$('lessonMore').querySelector('.lesson-more-grid'),body=$('lessonMore').querySelector('.playback-options-body');
  const placements=[[page.querySelector('.ctl-left'),body],[page.querySelector('.speed-control'),center],[$('sentenceInsight'),body],[$('studyLangBtn'),grid],[$('studyThemeBtn'),grid],[$('openSettings'),grid],[page.querySelector('.timeline'),dock],[center,dock],[$('openQueueDirectory'),links],[$('openLessonMore'),center]];
  for(const [node,target] of placements){if(mobile){if(node.parentElement!==target)target.append(node)}else node._desktopAnchor.after(node)}
  if(mobile){center.prepend(page.querySelector('.speed-control'));center.insertBefore($('dockLoop'),$('openLessonMore'));links.insertBefore($('openQueueDirectory'),$('openVideoSwitch'));dock.append(links);$('videoSwitchBody').append($('videoQueueControls'));page.dataset.mobilePane='transcript'}
  else{closeAll();page.append($('videoQueueControls'));page.querySelector('.study-top').append($('openLessonMore'));dock.append($('dockLoop'))}
  dock.hidden=!mobile;$('mobileLearningTools').hidden=!mobile;config.renderQueueControls();config.refreshPlayerCounts();updateModes(config.state);geometry();
 }
 global.EastudyMobilePlayer=Object.freeze({sync,updateModes,closeAll});
})(window);
