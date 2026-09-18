(function () {
  'use strict';
  const endpoint = 'http://127.0.0.1:8791/v1/ai-settings';
  const messages = {
    ADMIN_REQUIRED: '管理员登录已失效，请重新登录后重试。',
    NEW_ENDPOINT_REQUIRES_KEY: '更换接口地址后，请填写新接口的 API Key。',
    SETTINGS_CHANGED: '设置已在其他窗口修改，请重新读取后再操作。',
    TEST_REQUIRED: '请先测试当前配置并核对样例，再保存。',
    AI_URL_INVALID: '请填写完整的 HTTPS 接口地址，不要附带密钥或查询参数。',
    AI_MODEL_INVALID: '请填写服务商提供的准确模型名称。',
    AI_APIKEY_INVALID: '请填写有效的 API Key。',
    AI_HTTP_ERROR: '接口拒绝请求，请检查密钥、模型名称、余额及思考参数支持情况。',
    AI_NETWORK_ERROR: '无法连接 AI 接口，或接口没有返回有效的 JSON。',
    AI_SAMPLE_INVALID: '样例缺少中文翻译或词义，当前接口未通过完整性检查。',
    AI_OUTPUT_INCOMPLETE: '接口返回内容被截断，当前配置未通过测试。',
    SETTINGS_BUSY: '另一项设置操作正在进行，请稍后重试。',
    ENCRYPTION_UNAVAILABLE: '无法加密保存密钥，请检查本机处理服务。'
  };

  async function request(method, suffix, body) {
    const {data, error} = await window.EastudyAuth.client('admin').auth.getSession();
    if (error || !data?.session?.access_token) throw new Error(messages.ADMIN_REQUIRED);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), suffix ? 200000 : 25000);
    try {
      const response = await fetch(endpoint + suffix, {
        method, headers: {'Authorization': 'Bearer ' + data.session.access_token, 'Content-Type': 'application/json'},
        ...(body ? {body: JSON.stringify(body)} : {}), signal: controller.signal, cache: 'no-store'
      });
      const value = await response.json();
      if (!response.ok) throw new Error(messages[value.error] || '设置服务暂时不可用，请检查本机处理服务后重试。');
      return value;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时。测试会进行两次模型调用，请稍后重试。');
      if (error instanceof TypeError) throw new Error('未连接到本机处理服务。请在处理视频的电脑打开此页、启动新版 Worker，并允许浏览器访问本地网络。');
      throw error;
    } finally { clearTimeout(timer); }
  }

  function mount(root) {
    if (root.querySelector('#workerAiSettings')) return;
    const section = document.createElement('section');
    section.id = 'workerAiSettings';
    section.className = 'worker-ai-settings';
    section.innerHTML = `<div class="panel-head"><div><h2>AI 接口设置</h2><p>新设置用于后续视频；当前任务继续使用原配置。</p></div><button type="button" class="secondary" data-reload>重新读取</button></div>
      <form class="panel-body worker-ai-form" autocomplete="off">
        <label class="wide"><span>API 接口地址</span><input name="baseUrl" type="url" required maxlength="2048" placeholder="https://api.example.com/v1" spellcheck="false"></label>
        <label><span>模型名称</span><input name="model" required maxlength="200" placeholder="服务商提供的模型 ID" spellcheck="false"></label>
        <label><span>思考参数</span><select name="thinkingMode"><option value="auto">服务商默认（通用兼容）</option><option value="disabled">关闭思考（DeepSeek 兼容）</option><option value="enabled">开启思考（DeepSeek 兼容）</option></select></label>
        <label class="wide"><span>API Key <small data-key-state></small></span><input name="apiKey" type="password" maxlength="4096" autocomplete="new-password" placeholder="填写 API Key" spellcheck="false"></label>
        <p class="wide ai-quality-status">中文翻译与逐词语境释义：生成后独立复核，保留逐词音标和完整覆盖检查。</p>
        <p class="wide ai-quality-status">测试会产生两次模型调用费用。</p>
        <p class="wide ai-settings-message" role="status" aria-live="polite" data-message>正在读取当前配置…</p>
        <div class="wide form-actions"><button type="button" class="secondary" data-test>测试翻译与释义</button><button type="submit" class="primary" data-save disabled>保存并应用</button></div>
        <div class="wide ai-test-results" data-results hidden><h3>接口样例</h3><p>请核对中文和词义；通过样例不代表所有视频都没有误译。</p><div data-samples></div><label class="ai-sample-confirm"><input type="checkbox" data-confirm><span>我已核对样例的中文翻译和语境词义</span></label></div>
      </form>`;
    const layout = root.querySelector('.detail-layout');
    root.insertBefore(section, layout || null);
    const form = section.querySelector('form');
    const message = section.querySelector('[data-message]');
    const test = section.querySelector('[data-test]');
    const save = section.querySelector('[data-save]');
    const reload = section.querySelector('[data-reload]');
    const results = section.querySelector('[data-results]');
    const confirm = section.querySelector('[data-confirm]');
    let revision = null, testId = null, busy = false;
    const values = () => ({...Object.fromEntries(new FormData(form)), revision});
    function update() {
      form.querySelectorAll('input:not([data-confirm]), select').forEach(el => { el.disabled = busy || revision === null; });
      test.disabled = busy || revision === null;
      reload.disabled = busy;
      confirm.disabled = busy || !testId;
      save.disabled = busy || !testId || !confirm.checked;
    }
    function invalidate() {
      testId = null; confirm.checked = false; results.hidden = true; update();
    }
    function applyConfig(config) {
      revision = config.revision;
      for (const key of ['baseUrl', 'model', 'thinkingMode']) form.elements[key].value = config[key];
      form.elements.apiKey.value = '';
      form.elements.apiKey.placeholder = config.hasApiKey ? '留空保留当前密钥；更换地址需填写新密钥' : '填写 API Key';
      section.querySelector('[data-key-state]').textContent = config.hasApiKey ? '已配置，不回显' : '未配置';
      invalidate();
    }
    form.addEventListener('input', event => {
      if (event.target === confirm) { update(); return; }
      invalidate(); message.textContent = '配置已修改，尚未保存。请测试并核对样例。';
    });
    async function load() {
      busy = true; invalidate(); message.textContent = '正在读取当前配置…';
      try {
        const config = await request('GET', '');
        if (!section.isConnected) return;
        applyConfig(config);
        message.textContent = '已连接本机处理服务。密钥加密保存在此电脑，不存入浏览器。';
      } catch (error) { revision = null; message.textContent = error.message; }
      finally { busy = false; update(); }
    }
    reload.onclick = load;
    test.onclick = async () => {
      if (!form.reportValidity()) return;
      const candidate = values(); busy = true; invalidate();
      message.textContent = '正在生成并独立复核样例，请稍候…';
      try {
        const response = await request('POST', '/test', candidate);
        if (!section.isConnected) return;
        testId = response.testId;
        const samples = section.querySelector('[data-samples]'); samples.replaceChildren();
        for (const row of response.sentences) {
          const item = document.createElement('div'); item.className = 'ai-test-sample';
          for (const text of [row.english, row.chinese, row.word + '：' + row.meaningZh]) {
            const p = document.createElement('p'); p.textContent = text; item.append(p);
          }
          samples.append(item);
        }
        results.hidden = false;
        message.textContent = '接口已返回复核后的样例。请在下方核对后保存。';
      } catch (error) { message.textContent = error.message; }
      finally { busy = false; update(); }
    };
    form.onsubmit = async event => {
      event.preventDefault();
      if (busy || !testId || !confirm.checked) return;
      const candidate = {...values(), testId}; busy = true; update();
      try {
        const config = await request('POST', '', candidate);
        if (!section.isConnected) return;
        applyConfig(config);
        message.textContent = '已保存，下一个视频任务使用新配置。中文翻译和词义独立复核保持开启。';
      } catch (error) { message.textContent = error.message; }
      finally { busy = false; update(); }
    };
    load();
  }
  window.EastudyAiSettings = {mount};
})();
