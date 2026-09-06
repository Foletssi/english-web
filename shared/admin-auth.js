(function () {
  'use strict';
  document.documentElement.classList.add('admin-auth-pending');

  function redirect(reason) {
    window.location.replace('login.html?reason=' + encodeURIComponent(reason));
    return new Promise(() => {});
  }

  window.EastudyAdminGate = (async function () {
    const auth = window.EastudyAuth;
    if (!auth?.available) return redirect('configuration');
    const context = await auth.getContext('admin');
    if (!context.user) return redirect('signin');
    if (context.profile?.role !== 'admin') {
      await auth.signOut('admin');
      return redirect('forbidden');
    }
    window.EastudyAdminContext = context;
    document.documentElement.classList.remove('admin-auth-pending');
    return context;
  })();
})();
