(function (global) {
  'use strict';
  const ROOT = 'http://127.0.0.1:8790/v2';
  const hashWorkerUrl = new URL('local-file-hash-worker.js', document.currentScript.src);
  const MESSAGES = {
    LOCAL_INTAKE_QUEUE_FULL: '本机已有两个视频等待接收，请完成后继续。',
    LOCAL_DISK_SPACE_LOW: '本机磁盘空间不足，请释放空间后继续。',
    SOURCE_SHA_MISMATCH: '原视频校验失败，请重新选择同一个原文件。',
    SOURCE_DECLARATION_CONFLICT: '所选文件与原任务不一致，请选择原文件。',
    LOCAL_INPUT_CANCELLED: '任务已取消，请重新创建处理任务。',
    LOCAL_PROCESSING_NOT_READY: '本机制作组件尚未就绪，请启动处理服务后重新检测。',
    CONTENT_REVISION_CONFLICT: '云端内容已更新。当前文件已保留，请先同步内容再继续。',
  };
  async function request(path, {ticket, method = 'GET', body, headers = {}, timeout = 90000} = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(ROOT + path, {method, body, headers: {
        ...headers, ...(ticket ? {Authorization: 'Bearer ' + ticket} : {})
      }, cache: 'no-store', signal: controller.signal});
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(MESSAGES[data.error] || data.error || '本机接收失败'), {code: data.error, status: response.status});
      return data;
    } catch (error) {
      if (error instanceof TypeError || error.name === 'AbortError') {
        throw Object.assign(new Error('无法连接本机处理服务。请保持电脑运行，允许浏览器访问本地网络后重新检测；已接收部分会保留。'), {code: 'LOCAL_CONNECTION_FAILED'});
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function capability() {
    const value = await request('/capability');
    if (value.protocolVersion !== 1 || !value.ready) throw new Error('请先更新并启动本机处理服务。');
    return value;
  }
  function hashFile(file, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(hashWorkerUrl);
      worker.onerror = () => { worker.terminate(); reject(new Error('无法读取原视频，请重新选择文件。')); };
      worker.onmessage = ({data}) => {
        if (data.sha256 || data.error) {
          worker.terminate();
          if (data.error) reject(new Error(data.error)); else resolve(data.sha256);
        } else onProgress(data.current, data.total);
      };
      worker.postMessage(file);
    });
  }
  async function submit({file, cover, video, onProgress = () => {}}) {
    if (!file?.size || file.size > 2 * 1024 ** 3) throw new Error('请选择不超过 2GB 的原视频。');
    if (cover?.size > 15 * 1024 ** 2) throw new Error('封面不能超过 15MB。');
    await capability();
    const sha256 = await hashFile(file, (current, total) => onProgress(Math.round(10 * current / total), '正在校验本地原视频'));
    const coverSha256 = cover?.size ? await hashFile(cover) : null;
    const source = {name: file.name, size: file.size, sha256, coverSha256};
    const session = await global.EastudyAuth.client('admin').auth.getSession();
    const adminId = session.data?.session?.user?.id;
    if (session.error || !adminId) throw new Error('登录已失效，请重新登录控制端后继续。');
    const key = 'eastudy:local-intake:v1:' + adminId + ':' + (video.id || 'new') + ':' + sha256;
    let pending;
    try { pending = JSON.parse(localStorage.getItem(key) || 'null'); } catch { /* invalid metadata is replaced */ }
    if (pending && JSON.stringify(pending.source) !== JSON.stringify(source)) throw new Error('请保留原任务所选的封面和文件后继续。');
    pending ||= {requestId: crypto.randomUUID(), source, video};
    // Metadata only: no binary data, API keys or intake tickets are persisted.
    localStorage.setItem(key, JSON.stringify(pending));
    let reservation, ticket, renewedAt;
    async function reserve() {
      const ready = await capability(); // Hashing can outlive the previous challenge.
      const result = await global.EastudyAdminCloudBridge.reserveLocal({
        video: pending.video, source, requestId: pending.requestId,
        workerId: ready.workerId, challenge: ready.challenge, origin: location.origin
      });
      if (result.error) throw result.error;
      reservation = result.data;
      ticket = reservation.intakeTicket;
      renewedAt = Date.now();
    }
    await reserve();
    const path = '/intakes/' + reservation.inputSource.sourceId;
    async function call(suffix, options = {}) {
      if (Date.now() - renewedAt > 10 * 60 * 1000) await reserve();
      for (let attempt = 0; ; attempt++) {
        try { return await request(suffix, {...options, ticket}); }
        catch (error) {
          if (error.code === 'INTAKE_TICKET_INVALID' && attempt < 2) { await reserve(); continue; }
          if (attempt >= 2 || !(error.code === 'LOCAL_CONNECTION_FAILED' || error.status >= 500 || error.status === 429)) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
    }
    let status = await call('/intakes', {method: 'POST', body: '{}'});
    if (status.state !== 'READY' && status.state !== 'VERIFYING') {
      const received = new Map(status.chunks.map(chunk => [chunk.idx, chunk]));
      for (let offset = 0, index = 0; offset < file.size; offset += status.chunkBytes, index++) {
        const block = await file.slice(offset, offset + status.chunkBytes).arrayBuffer();
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', block)), b => b.toString(16).padStart(2, '0')).join('');
        if (received.has(index) && received.get(index).sha !== hash) throw new Error('已接收部分与原视频不一致，请重新选择原文件。');
        if (!received.has(index)) await call(path + '/chunks/' + index, {method: 'PUT', body: block, headers: {'X-Chunk-SHA256': hash}});
        const current = Math.min(file.size, offset + block.byteLength);
        onProgress(10 + Math.round(85 * current / file.size), `正在传入本机 ${(current / 1048576).toFixed(1)} / ${(file.size / 1048576).toFixed(1)} MB`);
      }
      if (cover?.size) await call(path + '/cover', {method: 'PUT', body: cover});
      onProgress(96, '正在核验本机文件，请暂时保留网页');
      status = await call(path + '/complete', {method: 'POST', body: '{}', timeout: 300000});
    }
    while (status.state === 'VERIFYING') {
      await new Promise(resolve => setTimeout(resolve, 1500));
      status = await call(path);
      if (status.error) throw new Error(MESSAGES[status.error] || '本机文件核验失败，已保留接收部分，请重试。');
    }
    if (status.state !== 'READY') throw new Error('原片尚未接收完整，请继续处理。');
    localStorage.removeItem(key);
    onProgress(100, '原片已保存到本机，可关闭网页；请保持电脑运行');
    return reservation;
  }
  global.EastudyLocalProcessing = Object.freeze({capability, submit, hashFile});
})(window);
