const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: corsHeaders
});

const env = (name) => String(Deno.env.get(name) || '').trim();

function required(name) {
  const value = env(name);
  if (!value) throw new Error(`CONFIG_${name}_MISSING`);
  return value;
}

async function supabaseRequest(path, init = {}) {
  const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${required('SUPABASE_URL')}${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.msg || payload.code || `SUPABASE_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return Array.isArray(payload) ? payload[0] : payload;
}

function serviceRpc(name, input) {
  return supabaseRequest(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(input || {})
  });
}

async function passwordGrant(email, password) {
  const response = await fetch(`${required('SUPABASE_URL')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: required('SUPABASE_SERVICE_ROLE_KEY'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, password })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || payload.msg || 'INVALID_LOGIN');
  return payload;
}

async function createInviteUser({ email, password, nickname, attemptId }) {
  const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${required('SUPABASE_URL')}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { nickname, registration_attempt_id: attemptId },
      app_metadata: { eastudy_registration: 'invite-v1' }
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.msg || payload.message || `AUTH_CREATE_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function validAccount(value) {
  return /^[a-z0-9][a-z0-9._-]{3,31}$/.test(String(value || '').trim().toLowerCase());
}

async function handleRegister(request) {
  const text = await request.text();
  if (text.length > 8192) return json({ error: 'REGISTRATION_INPUT_INVALID' }, 400);
  let input;
  try { input = JSON.parse(text || '{}'); }
  catch { return json({ error: 'REGISTRATION_INPUT_INVALID' }, 400); }

  const account = String(input.account || '').trim().toLowerCase();
  const password = String(input.password || '');
  const nickname = String(input.nickname || '').trim().slice(0, 40) || account;
  const inviteCode = String(input.inviteCode || '').trim();
  const attemptId = String(input.attemptId || '');
  if (!validAccount(account) || password.length < 8 || password.length > 128 ||
      !/^[0-9a-f-]{36}$/i.test(attemptId) || inviteCode.length < 12 || inviteCode.length > 80) {
    return json({ error: 'REGISTRATION_INPUT_INVALID' }, 400);
  }

  try {
    const reserved = await serviceRpc('reserve_invite_registration', {
      p_attempt_id: attemptId,
      p_account: account,
      p_code: inviteCode
    });
    let user;
    try {
      user = await createInviteUser({
        email: reserved.authEmail,
        password,
        nickname,
        attemptId
      });
    } catch (createError) {
      if (createError.status !== 422) throw createError;
      const recovered = await passwordGrant(reserved.authEmail, password);
      user = recovered.user;
    }
    const membership = await serviceRpc('finalize_invite_registration', {
      p_attempt_id: attemptId,
      p_fence: reserved.fence,
      p_auth_user_id: user.id
    });
    const session = await passwordGrant(reserved.authEmail, password);
    return json({ account, membership, session }, 201);
  } catch (error) {
    const raw = String(error?.message || '').toUpperCase();
    const known = ['ACCOUNT_EXISTS', 'INVITE_INVALID', 'ATTEMPT_MISMATCH',
      'ATTEMPT_EXPIRED', 'REGISTRATION_INPUT_INVALID'].find((code) => raw.includes(code));
    console.warn('Invite registration failed', known || raw.replace(/[^A-Z0-9_:-]/g, '').slice(0, 120));
    if (known === 'REGISTRATION_INPUT_INVALID') return json({ error: known }, 400);
    return json({ error: known || 'REGISTRATION_UNAVAILABLE' }, known ? 409 : 503);
  }
}

Deno.serve((request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  return handleRegister(request);
});
