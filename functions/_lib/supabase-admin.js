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

export async function passwordGrant(env, identity, password) {
  const config = supabaseConfig(env);
  const body = identity.email ? { email: identity.email, password } : { phone: identity.phone, password };
  const response = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: config.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error_description || payload.msg || 'INVALID_LOGIN');
    error.code = payload.error_code || payload.code || (response.status === 400 ? 'INVALID_LOGIN' : `AUTH_${response.status}`);
    error.upstreamStatus = response.status;
    throw error;
  }
  return payload;
}

export async function discardUndeliveredSession(env, session) {
  const token = String(session?.access_token || '');
  if (!token) return;
  const config = supabaseConfig(env);
  const response = await fetch(`${config.url}/auth/v1/logout?scope=local`, {
    method: 'POST',
    headers: { apikey: config.key, Authorization: `Bearer ${token}` },
  });
  if (!response.ok && response.status !== 401) {
    const error = new Error(`AUTH_LOGOUT_${response.status}`);
    error.upstreamStatus = response.status;
    throw error;
  }
}

export async function createInviteUser(env, input) {
  const config = adminConfig(env);
  const response = await fetch(`${config.url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: {
        nickname: input.nickname,
        registration_attempt_id: input.attemptId,
      },
      app_metadata: { eastudy_registration: 'invite-v1' },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.msg || payload.message || `AUTH_CREATE_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}
