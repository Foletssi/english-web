import { json, readJson } from '../../_lib/auth.js';
import { discardUndeliveredSession, passwordGrant, serviceRpc } from '../../_lib/supabase-admin.js';
import { canonicalLoginKey, identityFromResolution, publicLoginFailure } from '../../_lib/login-identity.js';

export async function onRequestPost({ request, env }) {
  let session = null;
  let delivered = false;
  try {
    const input = await readJson(request, 4096);
    const account = canonicalLoginKey(input.account);
    const password = String(input.password || '');
    if (!account || password.length < 6 || password.length > 128) {
      return json({ error: 'ACCOUNT_FORMAT_INVALID' }, 400);
    }
    const resolved = await serviceRpc(env, 'resolve_account_login_v2', { p_account: account });
    if (resolved?.state === 'NOT_FOUND') return json({ error: 'INVALID_LOGIN' }, 401);
    if (resolved?.state === 'DISABLED') return json({ error: 'ACCOUNT_UNAVAILABLE' }, 403);
    const identity = identityFromResolution(resolved);
    if (!identity) throw Object.assign(new Error('IDENTITY_UNAVAILABLE'), { code: 'IDENTITY_UNAVAILABLE' });
    session = await passwordGrant(env, identity, password);
    if (session?.user?.id !== resolved.userId) throw Object.assign(new Error('IDENTITY_MISMATCH'), { code: 'IDENTITY_MISMATCH' });
    const access = await serviceRpc(env, 'service_get_user_learning_access_v2', { p_user_id: session.user.id });
    if (access?.canEnterLearning !== true) {
      const reason = String(access?.reason || 'LOGIN_SERVICE_UNAVAILABLE');
      const [status, code] = publicLoginFailure({ code: reason });
      return json({ error: code, access: { reason, expiresAt: access?.expiresAt || null } }, status);
    }
    delivered = true;
    return json({ session, access });
  } catch (error) {
    const [status, code] = publicLoginFailure(error);
    console.warn('Account login failed', code);
    return json({ error: code }, status);
  } finally {
    if (session && !delivered) {
      await discardUndeliveredSession(env, session).catch(error => console.warn('Undelivered login session cleanup failed', error?.message));
    }
  }
}
