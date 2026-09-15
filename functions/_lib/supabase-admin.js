import { supabaseConfig } from './auth.js';

export function adminConfig(env) {
  const base = supabaseConfig(env);
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY_MISSING');
  return { ...base, serviceKey };
}

export async function serviceRpc(env, name, input) {
  const config = adminConfig(env);
  const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
    signal: AbortSignal.timeout(10000),
    method: 'POST',
    headers: {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.code || `RPC_${response.status}`);
    error.code = payload.code || payload.message || `RPC_${response.status}`;
    error.upstreamStatus = response.status;
    throw error;
  }
  return Array.isArray(payload) ? payload[0] : payload;
}

export async function userRpc(env, token, name, input) {
  const config = supabaseConfig(env);
  const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
    signal: AbortSignal.timeout(10000),
    method: 'POST',
    headers: { apikey: config.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.code || `RPC_${response.status}`);
    error.code = payload.message || payload.code || `RPC_${response.status}`;
    error.upstreamStatus = response.status;
    throw error;
  }
  return Array.isArray(payload) ? payload[0] : payload;
}
