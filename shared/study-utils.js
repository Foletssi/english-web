(function (global) {
  'use strict';

  function allocateSeconds(totalSeconds, weights) {
    if (!Number.isInteger(totalSeconds) || totalSeconds <= 0 || !Array.isArray(weights) || !weights.length ||
      weights.some(weight => !Number.isFinite(weight) || weight <= 0)) throw new Error('INVALID_PLAN_BUDGET');
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const raw = weights.map(weight => totalSeconds * weight / totalWeight);
    const output = raw.map(Math.floor);
    let remainder = totalSeconds - output.reduce((sum, value) => sum + value, 0);
    raw.map((value, index) => ({ index, fraction: value - output[index] }))
      .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
      .forEach(row => { if (remainder > 0) { output[row.index] += 1; remainder -= 1; } });
    return output;
  }

  function mergeWatchRanges(existing, incoming = [], duration = Infinity) {
    if (!(duration > 0)) throw new Error('INVALID_DURATION');
    const rows = [...(existing || []), ...(incoming || [])].map(range => {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)) throw new Error('INVALID_RANGE');
      const start = Math.max(0, Math.min(duration, range[0]));
      const end = Math.max(0, Math.min(duration, range[1]));
      if (end <= start) throw new Error('INVALID_RANGE_ORDER');
      return [start, end];
    }).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const output = [];
    rows.forEach(([start, end]) => {
      const last = output[output.length - 1];
      if (last && start <= last[1] + .35) last[1] = Math.max(last[1], end);
      else output.push([start, end]);
    });
    return output;
  }

  function normalizeAnswer(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase('en').replace(/[’‘]/g,"'")
      .match(/[a-z0-9]+(?:'[a-z0-9]+)*/g)?.join(' ') || '';
  }

  function expressionRange(text, surface) {
    const source = String(text || '');
    // These replacements preserve character offsets into the original caption.
    const comparable = value => String(value || '').replace(/[’‘]/g,"'").replace(/[–—]/g,'-');
    const parts = comparable(surface).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    const pattern = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const match = new RegExp('(?<![A-Za-z0-9])' + pattern + '(?![A-Za-z0-9])', 'i').exec(comparable(source));
    if (!match) return null;
    return { start: match.index, end: match.index + match[0].length, text: source.slice(match.index, match.index + match[0].length) };
  }

  global.EastudyStudyUtils = Object.freeze({ allocateSeconds, mergeWatchRanges, normalizeAnswer, expressionRange });
})(window);
