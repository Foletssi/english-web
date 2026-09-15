/* M08: structured teaching review; the serialized field stays the save contract. */
(function(global) {
 'use strict';
 const fields={surface:'原文表达',lemma:'词头 / 固定结构',coreMeaningZh:'核心释义',contextMeaningZh:'本句含义',usageNoteZh:'用法提醒',selectionReasonZh:'选词依据'};
 const types={word:'单词',phrasal_verb:'短语动词',collocation:'固定搭配',idiom:'习语',pattern:'常用句式'};
 function mount(card,row) {
  const grammar=card.querySelector('[data-field="grammar"]')?.closest('label'); if(!grammar)return;
  const section=document.createElement('section');section.className='teaching-editor';
  const heading=document.createElement('h4');heading.textContent='重点表达与释义';section.append(heading);
  const raw=document.createElement('textarea');raw.dataset.field='expressions';raw.hidden=true;section.append(raw);
  let expressions=structuredClone(Array.isArray(row.expressions)?row.expressions.filter(x=>x&&typeof x==='object'&&!Array.isArray(x)):[]);
  const list=document.createElement('div');section.append(list);
  function sync(){raw.value=JSON.stringify(expressions)}
  function render(){
   list.replaceChildren();
   expressions.forEach((expression,index)=>{
    const item=document.createElement('fieldset');const legend=document.createElement('legend');legend.textContent=expression.surface||'新增表达';item.append(legend);
    for(const [field,title] of Object.entries(fields)){
     const label=document.createElement('label');label.textContent=title;
     const input=document.createElement(field.endsWith('Zh')?'textarea':'input');input.value=expression[field]||'';input.dataset.expressionField=field;
     input.oninput=()=>{expression[field]=input.value;expression.source='manual';if(field==='surface')updateKeys();sync()};label.append(input);item.append(label);
    }
    const label=document.createElement('label');label.textContent='表达类型';const select=document.createElement('select');
    select.add(new Option('请选择表达类型',''));
    for(const [value,title] of Object.entries(types)){const option=new Option(title,value);select.add(option)}
    select.value=expression.expressionType||'';select.onchange=()=>{expression.expressionType=select.value;sync()};label.append(select);item.append(label);
    const remove=document.createElement('button');remove.type='button';remove.textContent='移除此表达';remove.onclick=()=>{expressions.splice(index,1);updateKeys();render()};item.append(remove);list.append(item);
   });sync();
  }
  function updateKeys(){const keys=card.querySelector('[data-field="keyWords"]');if(keys)keys.value=expressions.map(x=>x.surface).join(', ')}
  const add=document.createElement('button');add.type='button';add.textContent='添加表达';add.onclick=()=>{expressions.push({surface:'',lemma:'',expressionType:'word',coreMeaningZh:'',contextMeaningZh:'',usageNoteZh:'',selectionReasonZh:'',needsReview:false,source:'manual'});render()};section.append(add);
  if(row.teachingSelectionBefore){
   const diff=global.EastudyLearningContract.teachingSelectionDiff(row.teachingSelectionBefore,row);
   const detail=document.createElement('p');
   detail.textContent=[['新增',diff.added],['移除',diff.removed],['保留',diff.retained],['待复核',diff.review]].map(([label,items])=>label+'：'+(items.join('、')||'无')).join('；');section.append(detail);
  }
  if(row.segmentationNeedsReview===true||expressions.some(x=>x.needsReview===true)){
   const label=document.createElement('label');const check=document.createElement('input');check.type='checkbox';check.dataset.field='resolveTeachingReview';label.append(check,document.createTextNode('我已核对本句分句、时间和标记为待复核的释义'));section.append(label);
  }
  grammar.before(section);render();
 }
 global.EastudyTeachingEditor=Object.freeze({mount});
})(window);
