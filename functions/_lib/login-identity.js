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
  if (typeof identity.phone === 'string' && /^\+[1-9]\d{7,14}$/.test(identity.phone)) {
    return { phone: identity.phone };
  }
  return null;
}

export function publicLoginFailure(error) {
  const code = String(error?.code || error?.message || '').toUpperCase();
  if (code.includes('REQUEST_TOO_LARGE') || code.includes('ACCOUNT_FORMAT_INVALID')) return [400, 'ACCOUNT_FORMAT_INVALID'];
  if (code.includes('INVALID_LOGIN') || code.includes('INVALID_CREDENTIAL') || code.includes('BAD_JWT')) return [401, 'INVALID_LOGIN'];
  if (code.includes('ACCOUNT_UNAVAILABLE') || code.includes('USER_BANNED')) return [403, 'ACCOUNT_UNAVAILABLE'];
  if (code.includes('VIP_REVOKED')) return [403, 'VIP_REVOKED'];
  if (code.includes('VIP_EXPIRED')) return [403, 'VIP_EXPIRED'];
  if (code.includes('VIP_REQUIRED')) return [403, 'VIP_REQUIRED'];
  if (code.includes('ADMIN_NO_REDEMPTION_REQUIRED')) return [409, 'ADMIN_NO_REDEMPTION_REQUIRED'];
  if (code.includes('ACTIVATION_CODE_INVALID') || code.includes('INVALID_ACTIVATION_CODE')) return [409, 'ACTIVATION_CODE_INVALID'];
  if (code.includes('ACTIVATION_CODE_EXPIRED')) return [409, 'ACTIVATION_CODE_EXPIRED'];
  if (code.includes('ACTIVATION_CODE_REVOKED')) return [409, 'ACTIVATION_CODE_REVOKED'];
  if (code.includes('ACTIVATION_CODE_USED')) return [409, 'ACTIVATION_CODE_USED'];
  if (code.includes('ACTIVATION_CODE_')) return [409, code.match(/ACTIVATION_CODE_[A-Z_]+/)?.[0] || 'ACTIVATION_CODE_INVALID'];
  if (Number(error?.status || error?.upstreamStatus) === 429) return [429, 'TOO_MANY_ATTEMPTS'];
  return [503, 'LOGIN_SERVICE_UNAVAILABLE'];
}
