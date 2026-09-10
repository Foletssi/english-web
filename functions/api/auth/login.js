import { json, readJson } from '../../_lib/auth.js';
import { passwordGrant, serviceRpc } from '../../_lib/supabase-admin.js';

function normalizedPhone(value) {
  const compact = String(value || '').trim().replace(/[\s()-]/g, '');
  if (/^1\d{10}$/.test(compact)) return `+86${compact}`;
  if (/^861\d{10}$/.test(compact)) return `+${compact}`;
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : '';
}

export async function onRequestPost({ request, env }) {
  try {
    const input = await readJson(request, 4096);
    const account = String(input.account || '').trim();
    const password = String(input.password || '');
    if (!account || password.length < 6 || password.length > 128) {
      return json({ error: 'INVALID_LOGIN' }, 400);
    }
    const phone = normalizedPhone(account);
    let identity = phone ? { phone } : null;
    if (!identity) {
      const resolved = await serviceRpc(env, 'resolve_account_login', { p_account: account });
      if (!resolved?.authEmail) return json({ error: 'INVALID_LOGIN' }, 401);
      identity = { email: resolved.authEmail };
    }
    const session = await passwordGrant(env, identity, password);
    return json({ session });
  } catch (error) {
    console.warn('Account login failed', error.message);
    return json({ error: 'INVALID_LOGIN' }, 401);
  }
}
