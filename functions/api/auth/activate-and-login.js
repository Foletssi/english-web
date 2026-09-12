import { json, readJson } from '../../_lib/auth.js';
import { discardUndeliveredSession, passwordGrant, serviceRpc, userRpc } from '../../_lib/supabase-admin.js';
import { canonicalLoginKey, identityFromResolution, publicLoginFailure } from '../../_lib/login-identity.js';

export async function onRequestPost({ request, env }) {
  let session = null;
  let delivered = false;
  try {
    const input = await readJson(request, 8192);
    const account = canonicalLoginKey(input.account);
    const password = String(input.password || '');
    const inviteCode = String(input.inviteCode || '').trim();
    if (!account || password.length < 6 || password.length > 128 || inviteCode.length < 12 || inviteCode.length > 80) {
      return json({ error: 'ACTIVATION_INPUT_INVALID' }, 400);
    }
    const resolved = await serviceRpc(env, 'resolve_account_login_v2', { p_account: account });
    if (resolved?.state === 'NOT_FOUND') return json({ error: 'INVALID_LOGIN' }, 401);
    if (resolved?.state === 'DISABLED') return json({ error: 'ACCOUNT_UNAVAILABLE' }, 403);
    const identity = identityFromResolution(resolved);
    if (!identity) throw Object.assign(new Error('IDENTITY_UNAVAILABLE'), { code: 'IDENTITY_UNAVAILABLE' });
    session = await passwordGrant(env, identity, password);
    if (session?.user?.id !== resolved.userId) throw Object.assign(new Error('IDENTITY_MISMATCH'), { code: 'IDENTITY_MISMATCH' });
    const before = await serviceRpc(env, 'service_get_user_learning_access_v2', { p_user_id: session.user.id });
    if (before?.kind === 'ADMIN') return json({ error: 'ADMIN_NO_REDEMPTION_REQUIRED' }, 409);
    if (!['VIP_REQUIRED', 'VIP_EXPIRED', 'OK'].includes(String(before?.reason || ''))) {
      const [status, code] = publicLoginFailure({ code: before?.reason || 'LOGIN_SERVICE_UNAVAILABLE' });
      return json({ error: code }, status);
    }
    await userRpc(env, session.access_token, 'redeem_activation_code', { p_code: inviteCode });
    const access = await serviceRpc(env, 'service_get_user_learning_access_v2', { p_user_id: session.user.id });
    if (access?.canEnterLearning !== true) {
      const [status, code] = publicLoginFailure({ code: access?.reason || 'LOGIN_SERVICE_UNAVAILABLE' });
      return json({ error: code }, status);
    }
    delivered = true;
    return json({ session, access });
  } catch (error) {
    const [status, code] = publicLoginFailure(error);
    console.warn('Account renewal failed', code);
    return json({ error: code }, status);
  } finally {
    if (session && !delivered) {
      await discardUndeliveredSession(env, session).catch(error => console.warn('Undelivered renewal session cleanup failed', error?.message));
    }
  }
}
