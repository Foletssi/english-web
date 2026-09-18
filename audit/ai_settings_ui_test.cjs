// Real admin assets with mocked authentication and provider settings; no paid calls.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/legacy-content.json'), 'utf8'));
const auth = `window.EastudyAuth={getContext:async()=>({user:{id:'fixture-admin'},profile:{role:'admin'}}),client:()=>({auth:{getSession:async()=>({data:{session:{access_token:'fixture-jwt'}}})},rpc:async name=>({error:null,data:name==='admin_get_content_snapshot'?[{snapshot:${JSON.stringify(snapshot)},revision:1}]:name==='admin_list_processing_video_groups_v1'?{items:[],total:0,page:1,pageSize:50}:[]})})};`;
const types = {'.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.png':'image/png', '.svg':'image/svg+xml'};
(async () => {
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const context = await browser.newContext();
    const errors = [], calls = [];
    let offline = false, conflict = false, modelsError = false, generationError = null;
    let config = {baseUrl:'https://old.example/v1', model:'old-model', thinkingMode:'disabled', hasApiKey:true, revision:0};
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.port === '8791') {
        if (offline) return route.abort('connectionrefused');
        assert.equal(request.headers().authorization, 'Bearer fixture-jwt');
        const body = request.postDataJSON();
        calls.push({method:request.method(), path:url.pathname, body});
        let result = config, status = 200;
        if (url.pathname.endsWith('/models')) {
          if (modelsError) {result = {error:'AI_MODELS_UNSUPPORTED'}; status = 400;}
          else if (body.baseUrl !== config.baseUrl && !body.apiKey) {
            result = {error:'NEW_ENDPOINT_REQUIRES_KEY'}; status = 400;
          } else {result = {baseUrl:body.baseUrl === 'https://api.x5m5x.com' ? body.baseUrl + '/v1' : body.baseUrl, models:['new-model', 'updated-model', 'long-model-' + 'x'.repeat(175), '<img/src=x/onerror=alert(1)>']};}
        } else if (url.pathname.endsWith('/test')) {
          if (generationError) {result = {error:generationError}; status = 502;}
          else if (body.baseUrl !== config.baseUrl && !body.apiKey) {
            result = {error:'NEW_ENDPOINT_REQUIRES_KEY'}; status = 400;
          } else {
            result = {testId:'tested-config', baseUrl:body.baseUrl === 'https://api.x5m5x.com' ? body.baseUrl + '/v1' : body.baseUrl, sentences:[
              {english:"The bag's gold hardware matches its leather strap.", chinese:'包上的金色金属配件与皮革肩带很相配。', word:'hardware', meaningZh:'包上的金属配件'},
              {english:"I won't spill the beans.", chinese:'我不会泄露秘密。', word:'spill the beans', meaningZh:'泄露秘密'}]};
          }
        } else if (request.method() === 'POST') {
          if (conflict) {result = {error:'SETTINGS_CHANGED'}; status = 400;}
          else {
            assert.equal(body.testId, 'tested-config');
            config = {baseUrl:body.baseUrl, model:body.model, thinkingMode:body.thinkingMode, hasApiKey:true, revision:config.revision + 1};
            result = config;
          }
        }
        return route.fulfill({status, contentType:'application/json', body:JSON.stringify(result)});
      }
      if (url.hostname !== 'eastudy.test') return route.fulfill({contentType:'text/javascript', body:''});
      if (url.pathname === '/shared/supabase-client.js') return route.fulfill({contentType:'text/javascript', body:auth});
      if (url.pathname === '/api/session') return route.fulfill({contentType:'application/json', body:'{}'});
      const file = path.resolve(root, '.' + url.pathname + (url.pathname.endsWith('/') ? 'index.html' : ''));
      assert.ok(file.startsWith(root + path.sep));
      return route.fulfill(fs.existsSync(file) ? {contentType:types[path.extname(file)] || 'application/octet-stream', body:fs.readFileSync(file)} : {status:404, body:''});
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('https://eastudy.test/admin/#/settings');
    const panel = page.locator('#workerAiSettings');
    const base = panel.locator('[name=baseUrl]'), model = panel.locator('[name=model]'), key = panel.locator('[name=apiKey]');
    const save = panel.locator('[data-save]'), test = panel.locator('[data-test]'), confirm = panel.locator('[data-confirm]');
    const readModels = panel.locator('[data-models]'), modelList = panel.locator('[data-model-list]');
    try {
      await page.waitForFunction(() => document.querySelector('#workerAiSettings [name=baseUrl]')?.value === 'https://old.example/v1');
    } catch (error) {
      console.error({errors, calls, body:(await page.locator('body').innerText()).slice(-3000)});
      throw error;
    }
    assert.equal(await key.inputValue(), '');
    assert.ok(await save.isDisabled());
    await base.fill('https://new.example/v1');
    await test.click();
    await panel.getByText('更换接口地址后，请填写新接口的 API Key。').waitFor();
    assert.ok(await save.isDisabled());
    await key.fill('synthetic-private-key');
    await model.fill('');
    await readModels.click();
    await panel.getByText('已读取 4 个模型。').waitFor();
    assert.equal(calls.at(-1).path, '/v1/ai-settings/models');
    assert.equal(calls.at(-1).body.model, '', 'listing does not require an existing model');
    assert.ok(await save.isDisabled());
    assert.equal(await panel.locator('img').count(), 0, 'model IDs are rendered as text');
    await modelList.selectOption('new-model');
    assert.equal(await model.inputValue(), 'new-model');
    await key.fill('synthetic-private-key-2');
    assert.ok(await modelList.isDisabled(), 'changing key discards old models');
    await readModels.click();
    await panel.getByText('已读取 4 个模型。').waitFor();
    await base.fill('https://other.example/v1');
    assert.ok(await modelList.isDisabled(), 'changing endpoint discards old models');
    modelsError = true;
    await readModels.click();
    await panel.getByText(/此地址不支持读取模型列表/).waitFor();
    assert.ok(await model.isEnabled(), 'manual entry remains available after failure');
    modelsError = false;
    await readModels.click();
    await panel.getByText('已读取 4 个模型。').waitFor();
    await panel.locator('[name=thinkingMode]').selectOption('auto');
    await test.click();
    await panel.locator('[data-results]').waitFor({state:'visible'});
    assert.ok(await save.isDisabled());
    await confirm.check();
    assert.ok(await save.isEnabled());
    await modelList.selectOption('updated-model');
    assert.equal(await model.inputValue(), 'updated-model');
    assert.ok(await save.isDisabled());
    assert.ok(await panel.locator('[data-results]').isHidden());
    await test.click();
    await confirm.check();
    conflict = true;
    await save.click();
    await panel.getByText('设置已在其他窗口修改，请重新读取后再操作。').waitFor();
    conflict = false;
    await save.click();
    await panel.getByText('已保存，下一个视频任务使用新配置。中文翻译和词义独立复核保持开启。').waitFor();
    assert.equal(config.model, 'updated-model');
    assert.equal(config.thinkingMode, 'auto');
    assert.equal(await key.inputValue(), '');
    assert.ok(await save.isDisabled());
    assert.equal(await page.evaluate(() => JSON.stringify({...localStorage, ...sessionStorage}).includes('synthetic-private-key')), false);
    await test.click();
    await panel.locator('[data-results]').waitFor({state:'visible'});
    assert.equal(calls.at(-1).body.apiKey, '', 'saved key is not returned to browser');
    await readModels.click();
    await panel.getByText('已读取 4 个模型。').waitFor();
    assert.equal(calls.at(-1).body.apiKey, '', 'model discovery can reuse the saved key');
    await modelList.selectOption('long-model-' + 'x'.repeat(175));
    const evidence = path.join(root, 'tmp', 'ai-settings-ui');
    fs.mkdirSync(evidence, {recursive:true});
    for (const theme of ['dark', 'light']) for (const width of [375, 768, 1440]) {
      await page.setViewportSize({width, height:1000});
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      await page.waitForFunction(() => innerWidth > 840 || document.querySelector('#sidebar').getBoundingClientRect().right <= 1);
      await page.evaluate(() => window.scrollTo(0, 0));
      const dimensions = await panel.evaluate(el => ({width:el.clientWidth, scroll:el.scrollWidth, page:document.documentElement.scrollWidth, inputs:[...el.querySelectorAll('input,select')].filter(x=>x.type!=='checkbox').map(x=>({width:x.clientWidth, right:x.getBoundingClientRect().right}))}));
      assert.ok(dimensions.page <= width && dimensions.scroll <= dimensions.width, JSON.stringify({width, dimensions}));
      assert.ok(dimensions.inputs.every(x => x.width > 100 && x.right <= width), 'inputs fit');
      if (width !== 768) await page.screenshot({path:path.join(evidence, `${theme}-${width}.png`)});
    }
    await base.fill('https://api.x5m5x.com');
    await key.fill('synthetic-private-key');
    await readModels.click();
    await panel.getByText('已读取 4 个模型。').waitFor();
    assert.equal(await base.inputValue(), 'https://api.x5m5x.com/v1');
    await base.fill('https://api.x5m5x.com');
    await test.click();
    await panel.locator('[data-results]').waitFor({state:'visible'});
    assert.equal(await base.inputValue(), 'https://api.x5m5x.com/v1');
    await confirm.check();
    await save.click();
    await panel.getByText('已保存，下一个视频任务使用新配置。中文翻译和词义独立复核保持开启。').waitFor();
    assert.equal(config.baseUrl, 'https://api.x5m5x.com/v1');
    for (const [code, message] of [['AI_ENDPOINT_HTML', /地址返回了网页/], ['AI_RESPONSE_INVALID', /接口已连接，但返回的不是有效 JSON/], ['AI_NETWORK_ERROR', /AI 接口连接中断或超时/]]) {
      generationError = code;
      await test.click();
      await panel.getByText(message).waitFor();
      assert.ok(await save.isDisabled());
    }
    generationError = null;
    offline = true;
    await panel.locator('[data-reload]').click();
    await panel.getByText(/未连接到本机处理服务/).waitFor();
    assert.ok(await test.isDisabled());
    offline = false;
    await panel.locator('[data-reload]').click();
    await panel.getByText('已连接本机处理服务。密钥加密保存在此电脑，不存入浏览器。').waitFor();
    await page.evaluate(() => location.hash = '/dashboard');
    await panel.waitFor({state:'detached'});
    await page.evaluate(() => location.hash = '/settings');
    await panel.getByText('已连接本机处理服务。密钥加密保存在此电脑，不存入浏览器。').waitFor();
    assert.equal(await page.locator('#workerAiSettings').count(), 1);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('AI settings UI PASS: model discovery/selection, key and endpoint invalidation, manual fallback, safe text, test/confirm/save, conflict, reconnect, no browser key storage, 3 widths x 2 themes.');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
