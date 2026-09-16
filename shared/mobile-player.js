/* M04: mobile controls compose existing playback and learning actions. */
(function(global){
 'use strict';
 let config, initialized=false, pinned=null, visibleCaptionMode='bilingual';
 const $=id=>document.getElementById(id);
 const paths={play:'<path d="m9 5 10 7-10 7Z"/>',pause:'<path d="M8 5v14M16 5v14"/>',previous:'<path d="m15 6-6 6 6 6M5 6v12"/>',next:'<path d="m9 6 6 6-6 6M19 6v12"/>',listen:'<path d="M4 14v-3a8 8 0 0 1 16 0v3M4 12H3v7h4v-7Zm16 0h1v7h-4v-7Z"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',words:'<path d="M4 5h16M4 12h10M4 19h7m5-3 2 2 4-5"/>',book:'<path d="M12 6C9 4 6 4 3 5v15c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v15"/>',check:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',list:'<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>'};
 function icon(name){return '<svg class="player-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+paths[name]+'</svg>'}
 function decorate(id,name,label){$(id).innerHTML=icon(name)+'<span>'+label+'</span>'}
 function updatePlayback(playing){if(!initialized)return;$('playBtn').innerHTML='<span class="play-disc">'+icon(playing?'pause':'play')+'</span>';$('playBtn').setAttribute('aria-label',playing?'暂停':'播放')}
 function updateLearned(){if(!initialized)return;const marked=config.isLearned();$('markLessonLearned').setAttribute('aria-pressed',String(marked));$('markLessonLearned').querySelector('span').textContent=marked?'已标记':'标记已学'}
 function element(tag,id,html,parent){const node=document.createElement(tag);node.id=id;node.innerHTML=html;parent.append(node);return node}
 function closeAll(){for(const id of ['lessonMore','playerWordPanel'])if($(id)?.open)$(id).close()}
 function dialog(id,label,body,page){
  const node=element('dialog',id,'<header><b>'+label+'</b><button type="button" data-close>关闭</button></header>'+body,page);
  node.setAttribute('aria-label',label);
  node.querySelector('[data-close]').onclick=()=>node.close();
  node.addEventListener('click',event=>{if(event.target!==node)return;const r=node.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)node.close()});
  return node;
 }
 function open(node,trigger){closeAll();node._trigger=trigger;node.showModal();node.onclose=()=>{if(document.querySelector('dialog[open]'))return;const target=trigger?.isConnected&&trigger.getClientRects().length?trigger:$('openLessonMore');target?.focus()}}
 function geometry(){config.updateMobilePlayerGeometry();const height=config.page.querySelector('.mobile-learning-dock').getBoundingClientRect().height;config.page.style.setProperty('--lesson-dock-height',height+'px')}
 function initialize(){
  const page=config.page;
  element('div','videoQueueControls','<button type="button" id="previousVideo">上一条视频</button><button type="button" id="openQueueDirectory">视频目录</button><button type="button" id="nextVideo">下一条视频</button><label><input type="checkbox" id="autoplayNext" checked>自动连播</label>',page).className='video-queue-controls';
  const more=dialog('lessonMore','更多','<div class="playback-options-body"></div><div class="sentence-menu"><button type="button" id="copyPinnedSentence">复制此句</button><button type="button" id="savePinnedSentence">收藏此句</button></div><div id="moreVideoNavigation"></div><div class="lesson-more-grid"></div>',page);
  more.className='lesson-more';
  const dock=element('div','mobileLearningDock','<div class="learning-dock-links"><button type="button" id="openTeachingWords">'+icon('words')+'<span>重点词</span><b id="teachingCount">—</b></button><button type="button" id="openSavedWords">'+icon('book')+'<span>生词本</span><b id="savedWordCount">—</b></button><button type="button" id="markLessonLearned">'+icon('check')+'<span>标记已学</span></button></div>',page);dock.className='mobile-learning-dock';
  const modes=element('div','mobileLearningTools',[['watch','连续播放','play'],['intensive','逐句暂停','pause'],['loop','单句循环','listen'],['cloze','听写填空','words']].map(([mode,label,name])=>'<button type="button" data-mobile-practice="'+mode+'" aria-pressed="false">'+icon(name)+'<span>'+label+'</span></button>').join(''),page);modes.className='mobile-learning-tools';modes.setAttribute('aria-label','练习模式');
  modes.querySelectorAll('button').forEach(button=>button.onclick=()=>config.setPracticeMode(button.dataset.mobilePractice));
  element('div','mobileCaptionSetting','<b>字幕显示</b><div class="caption-segments" role="group" aria-label="字幕显示">'+[['bilingual','双语'],['english','英文'],['chinese','中文'],['hidden','隐藏']].map(([value,label])=>'<button type="button" data-caption-value="'+value+'">'+label+'</button>').join('')+'</div><select id="mobileCaptionMode" hidden><option value="bilingual">双语</option><option value="english">英文</option><option value="chinese">中文</option><option value="hidden">隐藏</option></select>',more.querySelector('.playback-options-body'));
  more.querySelectorAll('[data-caption-value]').forEach(button=>button.onclick=()=>config.setCaptionMode(button.dataset.captionValue));
  $('mobileCaptionMode').onchange=e=>config.setCaptionMode(e.target.value);
  element('button','dockBlind','',page).type='button';decorate('dockBlind','listen','盲听');$('dockBlind').onclick=()=>config.setCaptionMode(config.state.captionMode==='hidden'?visibleCaptionMode:'hidden');
  $('markLessonLearned').onclick=async()=>{const button=$('markLessonLearned');button.disabled=true;try{await config.toggleLearned()}finally{button.disabled=false;updateLearned()}};
  element('button','openLessonMore','更多',page).type='button';
  decorate('openLessonMore','more','更多');decorate('prevBtn','previous','上句');decorate('nextBtn','next','下句');decorate('openQueueDirectory','list','视频目录');

  $('copyPinnedSentence').innerHTML=icon('words')+'<span>复制此句</span>';
  $('openLessonMore').onclick=()=>{pinned=config.captureSentence();for(const id of ['copyPinnedSentence','savePinnedSentence'])$(id).disabled=!pinned.id;$('savePinnedSentence').innerHTML=icon('book')+'<span>'+(config.isSentenceSaved(pinned)?'取消收藏此句':'收藏此句')+'</span>';geometry();open(more,$('openLessonMore'))};
  for(const [id,action] of [['copyPinnedSentence','copy'],['savePinnedSentence','save']])$(id).onclick=async()=>{await config.sentenceAction(pinned,action,$(id));if(action==='save')$(id).innerHTML=icon('book')+'<span>'+(config.isSentenceSaved(pinned)?'取消收藏此句':'收藏此句')+'</span>'};

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
 function updateModes(state){if(!initialized)return;$('mobileCaptionMode').value=state.captionMode;$('mobileCaptionSetting').querySelectorAll('[data-caption-value]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.captionValue===state.captionMode)));if(state.captionMode!=='hidden')visibleCaptionMode=state.captionMode;$('dockBlind').setAttribute('aria-pressed',String(state.captionMode==='hidden'));$('mobileLearningTools').querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mobilePractice===state.practiceMode)))}
 function sync(options){
  config=options;if(!initialized)initialize();
  const page=config.page,mobile=matchMedia('(max-width:850px)').matches,dock=$('mobileLearningDock'),links=dock.querySelector('.learning-dock-links'),center=page.querySelector('.center-ctl'),grid=$('lessonMore').querySelector('.lesson-more-grid'),body=$('lessonMore').querySelector('.playback-options-body');
  const placements=[[page.querySelector('.ctl-left'),body],[page.querySelector('.speed-control'),center],[$('studyLangBtn'),grid],[$('openSettings'),grid],[page.querySelector('.timeline'),dock],[center,dock],[$('openQueueDirectory'),links],[$('openLessonMore'),center]];
  for(const [node,target] of placements){if(mobile){if(node.parentElement!==target)target.append(node)}else node._desktopAnchor.after(node)}
  if(mobile){center.prepend(page.querySelector('.speed-control'));center.insertBefore($('dockBlind'),$('prevBtn'));dock.append(links);$('moreVideoNavigation').append($('videoQueueControls'));page.dataset.mobilePane='transcript'}
  else{closeAll();page.append($('videoQueueControls'));page.querySelector('.study-top').append($('openLessonMore'));dock.append($('dockBlind'))}
  dock.hidden=!mobile;$('mobileLearningTools').hidden=!mobile;config.renderQueueControls();config.refreshPlayerCounts();updateModes(config.state);updatePlayback(config.state.playing);updateLearned();geometry();
 }
 global.EastudyMobilePlayer=Object.freeze({sync,updateModes,updatePlayback,updateLearned,closeAll});
})(window);
