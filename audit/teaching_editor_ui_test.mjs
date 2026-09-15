import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({headless:true, executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try {
 const page = await browser.newPage();
 await page.setContent('<article id="card"><input data-field="keyWords" value="put off"><label><textarea data-field="grammar"></textarea></label></article>');
 await page.addScriptTag({path:'shared/learning-contract.js'});
 await page.addScriptTag({path:'admin/assets/teaching-editor.js'});
 await page.evaluate(() => window.EastudyTeachingEditor.mount(document.querySelector('#card'), {
  keyWords:['put off'], segmentationNeedsReview:true,
  teachingSelectionBefore:{keyWords:['we love you']},
  expressions:[{surface:'put off',lemma:'put off',expressionType:'phrasal_verb',
   coreMeaningZh:'推迟',contextMeaningZh:'推迟决定',needsReview:true}]
 }));
 assert.equal(await page.locator('.teaching-editor').count(),1);
 assert.match(await page.locator('.teaching-editor').innerText(),/移除：we love you/);
 await page.locator('[data-expression-field="surface"]').fill('putting off');
 await page.locator('[data-expression-field="contextMeaningZh"]').fill('正在推迟这项决定');
 let value=JSON.parse(await page.locator('[data-field="expressions"]').inputValue());
 assert.equal(value[0].surface,'putting off');
 assert.equal(value[0].contextMeaningZh,'正在推迟这项决定');
 assert.equal(value[0].source,'manual');
 assert.equal(await page.locator('[data-field="keyWords"]').inputValue(),'putting off');
 await page.getByRole('button',{name:'移除此表达'}).click();
 assert.deepEqual(JSON.parse(await page.locator('[data-field="expressions"]').inputValue()),[]);
 assert.equal(await page.locator('[data-field="keyWords"]').inputValue(),'');
 await page.getByRole('button',{name:'添加表达'}).click();
 await page.locator('[data-expression-field="surface"]').fill('<img src=x onerror=alert(1)>');
 assert.equal(await page.locator('img').count(),0);
 await page.locator('[data-field="resolveTeachingReview"]').check();
 assert.equal(await page.locator('[data-field="resolveTeachingReview"]').isChecked(),true);
 console.log('Teaching editor: structured edits, selection removal/addition, review diff, literal text and review acknowledgement passed.');
} finally { await browser.close(); }
