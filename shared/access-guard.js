(function (global) {
  'use strict';
  let stopCurrent = null;

  function stop() {
    stopCurrent?.();
    stopCurrent = null;
  }

  function start(options) {
    stop();
    const intervalMs = Math.max(15000, Number(options?.intervalMs) || 60000);
    let stopped = false, pending = false, cleaned = false;
    let cleanup = () => {};
    async function verify(trigger) {
      if (stopped || pending || (document.hidden && trigger === 'timer')) return;
      pending = true;
      try {
        const result = await options.check();
        if (stopped) return;
        if (result?.error) options.onUnavailable?.(result.error, trigger);
        else if (result?.access?.canEnterLearning !== true) {
          cleanup();
          options.onDenied?.(result?.access || { reason: 'ACCESS_DENIED' }, trigger);
        }
      } catch (error) {
        if (!stopped) options.onUnavailable?.(error, trigger);
      } finally { pending = false; }
    }
    const timer = global.setInterval(() => void verify('timer'), intervalMs);
    const onFocus = () => void verify('focus');
    const onVisibility = () => { if (!document.hidden) void verify('visibility'); };
    global.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      stopped = true;
      global.clearInterval(timer);
      global.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    stopCurrent = cleanup;
    return stopCurrent;
  }

  global.EastudyAccessGuard = Object.freeze({ start, stop });
})(window);
