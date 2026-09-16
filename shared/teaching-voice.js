(function (global) {
  'use strict';
  const normalize = value => String(value || '').normalize('NFKC').replace(/[’‘]/g, "'").toLowerCase().trim();
  function select(video, sentence, source, text) {
    const manifest = video?.voiceManifest;
    if (!manifest || manifest.status !== 'complete' || !Array.isArray(manifest.items) ||
        String(manifest.videoId) !== String(video.id) || String(source?.sourceVideoId) !== String(video.id) ||
        String(source?.sourceSentenceId) !== String(sentence?.id) ||
        Number(source?.sourceTextRevision) !== Number(sentence?.textRevision || 1)) return null;
    const english = String(sentence?.english ?? sentence?.en ?? '');
    const lookup = sentence?.wordLookup;
    if (lookup?.sourceEnglish !== english || Number(lookup.sourceTextRevision) !== Number(sentence.textRevision || 1)) return null;
    const expressions = Array.isArray(sentence.expressions) ? sentence.expressions : [];
    const expressionIndex = expressions.findIndex(row => normalize(row.surface) === normalize(text) &&
      !['REJECTED', 'DELETED'].includes(String(row.reviewStatus).toUpperCase()));
    const expression = expressions[expressionIndex];
    const token = lookup.tokens?.find(row => row.tokenId === source.sourceTokenId && normalize(row.surface) === normalize(text));
    const kind = expression ? 'expression' : 'token';
    const localId = expression ? expression.expressionId || `e${expressionIndex}` : token?.tokenId;
    if (!localId) return null;
    const item = manifest.items.find(row => row.status === 'ready' && row.kind === kind &&
      row[kind === 'token' ? 'tokenId' : 'expressionId'] === localId &&
      String(row.videoId) === String(video.id) && String(row.sentenceId) === String(sentence.id) &&
      String(row.contentRevision) === String(manifest.contentRevision) &&
      Number(row.sourceTextRevision) === Number(sentence.textRevision || 1) && normalize(row.text) === normalize(text));
    if (!item || !/^[a-f0-9]{64}$/.test(item.fingerprint || '') ||
        !new RegExp('^/api/processing/media/[0-9a-f-]{36}/voice/' + item.fingerprint + '\\.mp3$').test(item.url || '')) return null;
    return item;
  }
  function create({makeAudio = () => new Audio(), authorize, onState = () => {}}) {
    let generation = 0, audio = null, timer = null, selected = null;
    function stop() {
      generation++;
      clearTimeout(timer);timer = null;
      if (audio) { audio.onended = audio.onerror = audio.onplaying = null;audio.pause();audio.removeAttribute('src');audio.load();audio = null; }
      selected = null;
      onState('idle');
    }
    async function play(item) {
      stop();
      const own = generation;
      selected = item;
      onState('loading');
      timer = setTimeout(() => { if (own === generation) {stop();onState('error');} }, 12000);
      try {
        const result = await authorize();
        if (own !== generation) return false;
        if (result?.stale) throw new Error('VOICE_SESSION_STALE');
        const current = makeAudio();audio = current;
        current.preload = 'none';current.playbackRate = 1;current.src = item.url;
        current.onplaying = () => {if (own === generation) {clearTimeout(timer);onState('playing');}};
        current.onended = () => {if (own === generation) {stop();onState('ready');}};
        current.onerror = () => {if (own === generation) {stop();onState('error');}};
        await current.play();
        return own === generation && selected === item;
      } catch (_) { if (own === generation) {stop();onState('error');}return false; }
    }
    return Object.freeze({play, stop});
  }
  global.EastudyTeachingVoice = Object.freeze({select, create});
})(window);
