import { requireAdmin, json } from '../../_lib/auth.js';
import { sealPlaybackTicket, openPlaybackTicket } from '../../_lib/playback-ticket.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: 'eastudy-playback', sub: auth.user.id, job: 'configuration-self-test', prefix: 'self-test/', exp: now + 30 };
  try {
    const ticket = await sealPlaybackTicket(payload, env);
    const opened = await openPlaybackTicket(ticket, env);
    if (opened.sub !== payload.sub || opened.prefix !== payload.prefix) throw new Error('PLAYBACK_CRYPTO_SELF_TEST_FAILED');
    return json({ ok: true, checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error('playback configuration self-test failed', error?.message || error);
    return json({ ok: false, error: 'PLAYBACK_CONFIGURATION_INVALID' }, 503);
  }
}
