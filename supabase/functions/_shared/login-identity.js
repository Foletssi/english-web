export function canonicalLoginKey(value) {
  const input = String(value ?? '');
  if (/[^ -~\t\r\n]/.test(input)) return '';
  const raw = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').toLowerCase();
  if (!raw || raw.length > 128) return '';
  const compact = raw.replace(/[ \t\r\n()-]/g, '');
  if (/^1\d{10}$/.test(compact)) return compact;
  if (/^86(1\d{10})$/.test(compact)) return compact.slice(2);
  if (/^\+86(1\d{10})$/.test(compact)) return compact.slice(3);
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  return /^[a-z0-9][a-z0-9._-]{3,31}$/.test(raw) ? raw : '';
}

export function identityFromResolution(resolved) {
  if (!resolved || resolved.state !== 'FOUND') return null;
  const identity = resolved.identity || {};
  if (typeof identity.email === 'string' && identity.email) return { email: identity.email };
  if (typeof identity.phone === 'string' && /^\+[1-9]\d{7,14}$/.test(identity.phone)) return { phone: identity.phone };
  return null;
}
