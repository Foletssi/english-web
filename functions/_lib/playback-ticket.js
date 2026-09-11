const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function key(env) {
  let raw;
  if (env.PLAYBACK_TICKET_KEY) {
    try { raw = fromBase64Url(env.PLAYBACK_TICKET_KEY); }
    catch { throw new Error('PLAYBACK_TICKET_KEY_INVALID'); }
    if (raw.byteLength !== 32) throw new Error('PLAYBACK_TICKET_KEY_INVALID');
  } else {
    const serviceBytes = encoder.encode(String(env.SUPABASE_SERVICE_ROLE_KEY || ''));
    if (serviceBytes.byteLength < 32) throw new Error('PLAYBACK_TICKET_KEY_UNAVAILABLE');
    raw = serviceBytes.slice(serviceBytes.byteLength - 32);
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealPlaybackTicket(payload, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env),
    encoder.encode(JSON.stringify(payload)));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

export async function openPlaybackTicket(value, env) {
  const [ivPart, dataPart, extra] = String(value || '').split('.');
  if (!ivPart || !dataPart || extra) throw new Error('PLAYBACK_TICKET_INVALID');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(ivPart) },
    await key(env), fromBase64Url(dataPart));
  const payload = JSON.parse(decoder.decode(plain));
  const now = Math.floor(Date.now() / 1000);
  if (!payload || payload.aud !== 'eastudy-playback' || !Number.isFinite(payload.exp) || payload.exp <= now) {
    throw new Error('PLAYBACK_TICKET_EXPIRED');
  }
  return payload;
}

export function cookieValue(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : '';
}
