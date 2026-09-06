(function () {
  'use strict';
  const form = document.getElementById('adminLoginForm');
  const message = document.getElementById('adminLoginMessage');
  const submit = document.getElementById('adminLoginSubmit');
  const params = new URLSearchParams(location.search);
  const reason = params.get('reason');
  if (reason === 'forbidden') message.textContent = '该账号不是管理员，无法进入管理端。';
  if (reason === 'configuration') message.textContent = '登录服务尚未完成配置。';

  async function redirectIfSignedIn() {
    const context = await window.EastudyAuth?.getContext('admin');
    if (context?.user && context.profile?.role === 'admin') location.replace('index.html');
  }
  redirectIfSignedIn();

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    message.textContent = '';
    message.classList.remove('ok');
    submit.disabled = true;
    submit.textContent = '登录中…';
    const result = await window.EastudyAuth.signInPhone({
      phone: document.getElementById('adminPhone').value,
      password: document.getElementById('adminPassword').value
    }, 'admin');
    if (result.error) {
      message.textContent = result.error.message || '登录失败，请检查手机号和密码。';
      submit.disabled = false;
      submit.textContent = '登录管理端';
      return;
    }
    const context = await window.EastudyAuth.getContext('admin');
    if (context.profile?.role !== 'admin') {
      await window.EastudyAuth.signOut('admin');
      message.textContent = '该账号不是管理员，请返回学生端登录。';
      submit.disabled = false;
      submit.textContent = '登录管理端';
      return;
    }
    message.textContent = '验证通过，正在进入管理端。';
    message.classList.add('ok');
    location.replace('index.html');
  });
})();
