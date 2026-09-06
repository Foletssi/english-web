(function () {
  'use strict';
  const auth = window.EastudyAuth;
  const form = document.getElementById('student-login-form');
  const message = document.getElementById('studentLoginMessage');
  const submit = document.getElementById('studentLoginSubmit');
  const nameWrap = document.getElementById('studentNameWrap');
  const title = document.getElementById('studentLoginTitle');
  const description = document.getElementById('studentLoginDescription');
  let mode = 'signin';

  function setMode(next) {
    mode = next === 'signup' ? 'signup' : 'signin';
    const signup = mode === 'signup';
    document.querySelectorAll('[data-student-auth-mode]').forEach(button => {
      const active = button.dataset.studentAuthMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    });
    nameWrap.hidden = !signup;
    title.textContent = signup ? '创建学生账户' : '欢迎回来';
    description.textContent = signup ? '注册后即可保存个人学习进度、收藏和词汇数据。' : '使用手机号和密码登录你的学生账户。';
    submit.textContent = signup ? '注册并开始学习' : '登录 Eastudy';
    document.getElementById('studentPassword').autocomplete = signup ? 'new-password' : 'current-password';
    message.textContent = '';
    message.classList.remove('ok');
  }

  async function waitForProfile() {
    for (let attempt = 0; attempt < 6; attempt += 1) {
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

  document.querySelectorAll('[data-student-auth-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.studentAuthMode)));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!auth?.available) { message.textContent = '登录服务尚未完成配置，请联系站点管理员。'; return; }
    submit.disabled = true;
    submit.textContent = mode === 'signup' ? '注册中…' : '登录中…';
    message.textContent = '';
    const input = { phone: document.getElementById('studentPhone').value, password: document.getElementById('studentPassword').value, displayName: document.getElementById('studentName').value };
    const result = mode === 'signup' ? await auth.signUpPhone(input, 'student') : await auth.signInPhone(input, 'student');
    if (result.error) {
      message.textContent = result.error.message || '操作失败，请检查手机号和密码。';
      submit.disabled = false;
      setMode(mode);
      return;
    }
    const context = await waitForProfile();
    if (!context.user || context.profile?.role !== 'student') {
      await auth.signOut('student');
      message.textContent = '该账号属于管理端，请使用管理员登录页面。';
      submit.disabled = false;
      setMode(mode);
      return;
    }
    message.textContent = '登录成功，正在进入学习首页。';
    message.classList.add('ok');
    location.replace('index.html#/home');
  });

  setMode('signin');
  redirectIfStudent();
})();
