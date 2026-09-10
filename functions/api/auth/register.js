import { json, readJson } from '../../_lib/auth.js';
import { createInviteUser, passwordGrant, serviceRpc } from '../../_lib/supabase-admin.js';

function validAccount(value) {
  return /^[a-z0-9][a-z0-9._-]{3,31}$/.test(String(value || '').trim().toLowerCase());
}

export async function onRequestPost({ request, env }) {
  let input;
  try { input = await readJson(request, 8192); }
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
    const reserved = await serviceRpc(env, 'reserve_invite_registration', {
      p_attempt_id: attemptId, p_account: account, p_code: inviteCode,
    });
    let user;
    try {
      user = await createInviteUser(env, {
        email: reserved.authEmail, password, nickname, attemptId,
      });
    } catch (createError) {
      // If Auth creation succeeded but its response was lost, the same password
      // can recover that deterministic pending identity without creating a duplicate.
      if (createError.status !== 422) throw createError;
      const recovered = await passwordGrant(env, { email: reserved.authEmail }, password);
      user = recovered.user;
    }
    const membership = await serviceRpc(env, 'finalize_invite_registration', {
      p_attempt_id: attemptId, p_fence: reserved.fence, p_auth_user_id: user.id,
    });
    const session = await passwordGrant(env, { email: reserved.authEmail }, password);
    return json({ account, membership, session }, 201);
  } catch (error) {
    const raw = String(error.message || '').toUpperCase();
    const known = ['ACCOUNT_EXISTS', 'INVITE_INVALID', 'ATTEMPT_EXPIRED', 'REGISTRATION_INPUT_INVALID']
      .find(code => raw.includes(code));
    console.warn('Invite registration failed', known || error.message);
    return json({ error: known || 'REGISTRATION_UNAVAILABLE' }, known ? 409 : 503);
  }
}
