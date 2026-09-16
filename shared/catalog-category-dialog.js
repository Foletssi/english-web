/* M02: put category choices in the top layer, outside horizontally clipped tabs. */
(function(global){
 'use strict';
 let dialog;
 function close(){if(dialog?.open)dialog.close()}
 function open({categories,selected,onSelect,trigger}){
  if(!dialog){
   dialog=document.createElement('dialog');dialog.id='catalogCategoryDialog';dialog.setAttribute('aria-label','视频分类');
   const header=document.createElement('header'),title=document.createElement('b'),dismiss=document.createElement('button');
   title.textContent='视频分类';dismiss.type='button';dismiss.textContent='关闭';dismiss.onclick=close;header.append(title,dismiss);
   const list=document.createElement('div');list.className='category-choices';dialog.append(header,list);document.body.append(dialog);
   dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close()});
   global.addEventListener('hashchange',close);
  }
  dialog.querySelector('.category-choices').replaceChildren(...categories.map(category=>{
   const button=document.createElement('button');button.type='button';button.textContent=category;button.setAttribute('aria-pressed',String(selected===category));
   button.onclick=()=>{close();onSelect(category)};return button;
  }));
  dialog.onclose=()=>{const target=trigger?.isConnected?trigger:document.getElementById('openMobileCategories');if(target?.getClientRects().length)target.focus()};
  if(!dialog.open)dialog.showModal();
 }
 global.EastudyCategoryDialog=Object.freeze({open,close});
})(window);
