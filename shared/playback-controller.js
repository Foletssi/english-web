(function (global) {
  'use strict';

  function createCountdown(options) {
    const seconds = Math.max(1, Number(options?.seconds) || 5);
    let timer = 0;
    let generation = 0;
    let active = false;

    function cancel(reason) {
      generation += 1;
      active = false;
      if (timer) global.clearTimeout(timer);
      timer = 0;
      options?.onCancel?.(reason || 'cancelled');
    }

    function start(payload) {
      cancel('replaced');
      const token = generation;
      active = true;
      let remaining = seconds;
      options?.onTick?.(remaining, payload);
      const tick = () => {
        if (!active || token !== generation) return;
        remaining -= 1;
        if (remaining <= 0) {
          active = false;
          timer = 0;
          options?.onDone?.(payload);
          return;
        }
        options?.onTick?.(remaining, payload);
        timer = global.setTimeout(tick, 1000);
      };
      timer = global.setTimeout(tick, 1000);
    }

    return Object.freeze({ start, cancel, isActive: () => active });
  }

  global.EastudyPlayback = Object.freeze({ createCountdown });
})(window);
