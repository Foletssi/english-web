import { authenticate, json, readJson, requireBucket } from '../../../_lib/auth.js';

function routePath(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean).join('/');
}

function first(value) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

async function rpc(url, headers, name, body, preserveArray = false) {
  const response = await fetch(url + '/rest/v1/rpc/' + name, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(payload?.message || payload?.code || name + '_FAILED'), { status: response.status });
  return preserveArray ? payload : first(payload);
}

function serviceContext(env) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url || !key) throw new Error('DELETION_SERVICE_NOT_CONFIGURED');
  return { url, headers: { apikey: key, Authorization: 'Bearer ' + key } };
}

async function stageObjects(env, lease, objects) {
  if (!objects.length) return;
  const service = serviceContext(env);
  await rpc(service.url, service.headers, 'deletion_stage_items', {
    p_deletion_id: lease.id, p_token: lease.token,
    p_items: objects.map(object => ({ objectKey: object.key, objectBytes: Math.max(0, Number(object.size) || 0) }))
  });
}

async function deleteObjects(env, lease, objects) {
  if (!objects.length) return;
  const service = serviceContext(env);
  await rpc(service.url, service.headers, 'deletion_assert_lease', { p_deletion_id: lease.id, p_token: lease.token });
  await env.VIDEO_BUCKET.delete(objects.map(object => object.key));
  await rpc(service.url, service.headers, 'deletion_ack_items', {
    p_deletion_id: lease.id, p_token: lease.token,
    p_object_keys: objects.map(object => object.key)
  });
}

export async function runDeletionWorker(env) {
  if (String(env.VIDEO_DELETION_ENABLED || '').toLowerCase() !== 'true') throw new Error('VIDEO_DELETION_DISABLED');
  const bucketError = requireBucket(env);
  if (bucketError) throw new Error('R2_VIDEO_BUCKET_NOT_BOUND');
  const service = serviceContext(env);
  const lease = await rpc(service.url, service.headers, 'deletion_claim_job', {
    p_worker_id: 'cloudflare-pages-deletion-v1', p_lease_seconds: 60
  });
  if (!lease?.id || !lease?.token) return { state: 'IDLE' };
  try {
    const exact = [];
    for (const key of Array.isArray(lease.sourceKeys) ? lease.sourceKeys : []) {
      const object = await env.VIDEO_BUCKET.head(String(key));
      if (object) exact.push({ key: String(key), size: object.size });
    }
    await stageObjects(env, lease, exact);

    for (const prefix of Array.isArray(lease.outputPrefixes) ? lease.outputPrefixes : []) {
      let cursor;
      do {
        const listed = await env.VIDEO_BUCKET.list({ prefix: String(prefix), limit: 500, cursor });
        const objects = (listed.objects || []).map(object => ({ key: object.key, size: object.size }));
        await stageObjects(env, lease, objects);
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
    }
    await rpc(service.url, service.headers, 'deletion_mark_inventory_complete', {
      p_deletion_id: lease.id, p_token: lease.token
    });

    while (true) {
      const pending = await rpc(service.url, service.headers, 'deletion_next_items', {
        p_deletion_id: lease.id, p_token: lease.token, p_limit: 200
      }, true);
      const items = Array.isArray(pending) ? pending.map(item => ({ key: item.objectKey, size: item.objectBytes })) : [];
      if (!items.length) break;
      await deleteObjects(env, lease, items);
    }

    const completed = await rpc(service.url, service.headers, 'deletion_finalize_job', {
      p_deletion_id: lease.id, p_token: lease.token
    });
    return completed || { state: 'DONE', deletionId: lease.id };
  } catch (error) {
    await rpc(service.url, service.headers, 'deletion_fail_job', {
      p_deletion_id: lease.id, p_token: lease.token,
      p_error_code: String(error?.message || 'DELETION_FAILED').slice(0, 120)
    }).catch(() => {});
    throw error;
  }
}

async function adminRpc(request, env, name, body) {
  const auth = await authenticate(request, env);
  if (auth.error) return { error: auth.error };
  try { return { data: await rpc(auth.url, auth.headers, name, body) }; }
  catch (error) { return { error: json({ error: error.message }, error.status || 500) }; }
}

export async function onRequestGet({ request, env, params }) {
  if (routePath(params.path) !== 'status') return json({ error: 'DELETION_ROUTE_NOT_FOUND' }, 404);
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'DELETION_ID_INVALID' }, 400);
  const result = await adminRpc(request, env, 'admin_get_video_deletion', { p_deletion_id: id });
  return result.error || json(result.data);
}

export async function onRequestPost({ request, env, params, waitUntil }) {
  const path = routePath(params.path);
  const input = await readJson(request).catch(() => ({}));
  if (['run','plan','confirm'].includes(path) && String(env.VIDEO_DELETION_ENABLED || '').toLowerCase() !== 'true') return json({ error: 'VIDEO_DELETION_DISABLED' }, 503);
  if (path === 'run') {
    if (!env.DELETION_WORKER_SECRET || request.headers.get('x-deletion-worker-secret') !== env.DELETION_WORKER_SECRET) return json({ error: 'DELETION_WORKER_UNAUTHORIZED' }, 401);
    try { return json(await runDeletionWorker(env)); }
    catch (error) { return json({ error: error.message || 'DELETION_WORKER_FAILED' }, 500); }
  }
  if (path === 'plan') {
    const result = await adminRpc(request, env, 'admin_plan_permanent_video_delete', {
      p_video_id: String(input.videoId || ''), p_expected_revision: Number(input.expectedRevision)
    });
    return result.error || json(result.data);
  }
  if (path === 'confirm') {
    const result = await adminRpc(request, env, 'admin_confirm_permanent_video_delete', {
      p_plan_id: String(input.planId || ''), p_expected_revision: Number(input.expectedRevision),
      p_confirmation: String(input.confirmation || '')
    });
    if (result.error) return result.error;
    const work = runDeletionWorker(env).catch(error => console.error('durable video deletion failed', error?.message || error));
    if (typeof waitUntil === 'function') waitUntil(work); else await work;
    return json(result.data, 202);
  }
  return json({ error: 'DELETION_ROUTE_NOT_FOUND' }, 404);
}
