(function (global) {
  'use strict';
  const OFFSET = 8 * 60 * 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;

  function beijingDate(time) { return new Date(time + OFFSET); }

  function monthAnniversary(time, months) {
    const source = beijingDate(time);
    const first = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(source.getUTCDate(), lastDay),
      source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds()) - OFFSET;
  }

  function relativeTimeZh(value, now = Date.now()) {
    const time = typeof value === 'number' ? value : Date.parse(value || '');
    if (!Number.isFinite(time) || !Number.isFinite(now)) return '尚未上报';
    if (time > now + 60000) return '时间待校准';
    const elapsed = Math.max(0, now - time), seconds = Math.floor(elapsed / 1000);
    if (seconds < 5) return '刚刚';
    if (seconds < 60) return `${seconds} 秒前`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (elapsed < DAY) return `${Math.floor(seconds / 3600)} 小时前`;
    const from = beijingDate(time), to = beijingDate(now);
    let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
    if (monthAnniversary(time, months) > now) months -= 1;
    if (months >= 12) return `${Math.floor(months / 12)} 年前`;
    if (months >= 1) return `${months} 个月前`;
    return `${Math.floor(elapsed / DAY)} 天前`;
  }

  global.EastudyRelativeTime = Object.freeze({ relativeTimeZh });
})(globalThis);
