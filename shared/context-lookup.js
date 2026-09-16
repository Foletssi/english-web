(function (global) {
  'use strict';
  function tokens(text) {
    return Array.from(String(text || '').matchAll(/[A-Za-z]+(?:['’‘‐‑–—-][A-Za-z]+)*/g), (match, index) => ({
      tokenId: `t${index}`, surface: match[0], start: match.index, end: match.index + match[0].length
    }));
  }
  function lookup(sentence, tokenId, offset) {
    const source = String(sentence?.en ?? sentence?.english ?? ''), data = sentence?.wordLookup;
    if (!data || data.schemaVersion !== 1 || data.sourceEnglish !== source ||
        Number(data.sourceTextRevision) !== Math.max(1, Number(sentence?.textRevision) || 1)) return null;
    const expected = tokens(source).find(token => tokenId ? token.tokenId === tokenId : token.start === offset);
    if (!expected || !Array.isArray(data.tokens)) return null;
    const token = data.tokens.find(row => row.tokenId === expected.tokenId);
    if (!token || token.surface !== expected.surface || token.start !== expected.start || token.end !== expected.end ||
        typeof token.coreMeaningZh !== 'string' || !token.coreMeaningZh.trim()) return null;
    return { phon: String(token.pronunciationHint || '').match(/\/[^/\r\n]+\//)?.[0] || '', meaning: token.coreMeaningZh, explain: '', levels: [], source: 'context',
      tokenId: token.tokenId, sourceTextRevision: data.sourceTextRevision, pronunciation: token.pronunciation || null };
  }
  global.EastudyContextLookup = Object.freeze({tokens, lookup});
})(window);
