(function () {
  'use strict';
  const auth = window.EastudyAuth;
  const form = document.getElementById('student-login-form');
  const message = document.getElementById('studentLoginMessage');
  const submit = document.getElementById('studentLoginSubmit');
  const title = document.getElementById('authTitle');
  const description = document.getElementById('authDescription');
  const nameWrap = document.getElementById('studentNameWrap');
  const passwordField = document.getElementById('passwordField');
  const codeRow = document.getElementById('codeRow');
  const successView = document.getElementById('authSuccessView');
  const formView = document.getElementById('authFormView');
  let mode = 'signin';
  let loginMethod = 'password';

  function setMessage(text, ok) {
    message.textContent = text || '';
    message.classList.toggle('ok', Boolean(ok));
  }

  function setMode(next) {
    mode = next === 'signup' ? 'signup' : 'signin';
    const signup = mode === 'signup';
    document.querySelectorAll('[data-auth-mode]').forEach(button => {
      const active = button.dataset.authMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    nameWrap.hidden = !signup;
    title.textContent = signup ? '注册' : '登录';
    description.textContent = signup ? '注册学生账户，保存你的学习进度与词汇。' : '使用手机号和密码登录你的学生账户。';
    submit.textContent = signup ? '注册' : '登录';
    document.getElementById('studentPassword').autocomplete = signup ? 'new-password' : 'current-password';
    setMessage('');
  }

  function setLoginMethod(next) {
    loginMethod = next === 'code' ? 'code' : 'password';
    document.querySelectorAll('[data-login-method]').forEach(button => {
      const active = button.dataset.loginMethod === loginMethod;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    passwordField.hidden = loginMethod !== 'password';
    codeRow.hidden = loginMethod !== 'code';
    document.getElementById('studentPassword').required = loginMethod === 'password';
    setMessage(loginMethod === 'code' ? '验证码登录暂未开放，请使用密码登录。' : '');
  }

  async function waitForProfile() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const context = await auth.getContext('student');
      if (context.profile) return context;
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    return auth.getContext('student');
  }

  async function redirectIfStudent() {
    if (!auth?.available) return;
    const context = await auth.getContext('student');
    if (context.user && context.profile?.role === 'student') location.replace('index.html#/home');
    if (context.user && context.profile?.role !== 'student') await auth.signOut('student');
  }

  function showSuccess() { formView.hidden = true; successView.hidden = false; }
  function showForm() { successView.hidden = true; formView.hidden = false; setMode('signin'); document.getElementById('studentPhone').focus(); }

  document.querySelectorAll('[data-auth-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.authMode)));
  document.querySelectorAll('[data-login-method]').forEach(button => button.addEventListener('click', () => setLoginMethod(button.dataset.loginMethod)));
  document.getElementById('passwordToggle').addEventListener('click', () => {
    const input = document.getElementById('studentPassword');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  document.getElementById('forgotPassword').addEventListener('click', () => setMessage('MVP 阶段请联系管理员重置密码。'));
  document.getElementById('successLoginButton').addEventListener('click', showForm);
  document.getElementById('successLaterButton').addEventListener('click', () => location.replace('index.html'));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (loginMethod !== 'password') { setMessage('验证码登录暂未开放，请使用密码登录。'); return; }
    if (!auth?.available) { setMessage('登录服务尚未完成配置，请联系站点管理员。'); return; }
    submit.disabled = true;
    submit.textContent = mode === 'signup' ? '注册中…' : '登录中…';
    setMessage('');
    const input = { phone: document.getElementById('studentPhone').value, password: document.getElementById('studentPassword').value, displayName: document.getElementById('studentName').value };
    const result = mode === 'signup' ? await auth.signUpPhone(input, 'student') : await auth.signInPhone(input, 'student');
    if (result.error) {
      setMessage(result.error.message || '操作失败，请检查手机号和密码。');
      submit.disabled = false;
      setMode(mode);
      return;
    }
    const context = await waitForProfile();
    if (mode === 'signup' && (!context.user || !context.profile)) {
      await auth.signOut('student');
      submit.disabled = false;
      showSuccess();
      return;
    }
    if (!context.user || context.profile?.role !== 'student') {
      await auth.signOut('student');
      setMessage('该账号属于管理端，请使用管理员登录页面。');
      submit.disabled = false;
      setMode(mode);
      return;
    }
    if (mode === 'signup') {
      await auth.signOut('student');
      submit.disabled = false;
      showSuccess();
      return;
    }
    location.replace('index.html#/home');
  });

  setMode('signin');
  setLoginMethod('password');
  redirectIfStudent();
})();
