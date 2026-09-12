export function publicAuthFailure(error) {
  const code = String(error?.code || error?.message || '').toUpperCase();
  if (code.includes('REQUEST_TOO_LARGE') || code.includes('ACCOUNT_FORMAT_INVALID')) return [400, 'ACCOUNT_FORMAT_INVALID'];
  if (code.includes('INVALID_LOGIN') || code.includes('INVALID_CREDENTIAL') || code.includes('BAD_JWT')) return [401, 'INVALID_LOGIN'];
  if (code.includes('ACCOUNT_UNAVAILABLE') || code.includes('USER_BANNED')) return [403, 'ACCOUNT_UNAVAILABLE'];
  if (code.includes('ROLE_FORBIDDEN')) return [403, 'ROLE_FORBIDDEN'];
  if (code.includes('VIP_REVOKED')) return [403, 'VIP_REVOKED'];
  if (code.includes('VIP_EXPIRED')) return [403, 'VIP_EXPIRED'];
  if (code.includes('VIP_REQUIRED')) return [403, 'VIP_REQUIRED'];
  if (code.includes('ADMIN_NO_REDEMPTION_REQUIRED')) return [409, 'ADMIN_NO_REDEMPTION_REQUIRED'];
  for (const known of ['ACTIVATION_CODE_INVALID', 'ACTIVATION_CODE_EXPIRED', 'ACTIVATION_CODE_REVOKED', 'ACTIVATION_CODE_USED']) {
    if (code.includes(known)) return [409, known];
  }
  if (Number(error?.status || error?.upstreamStatus) === 429) return [429, 'TOO_MANY_ATTEMPTS'];
  return [503, 'LOGIN_SERVICE_UNAVAILABLE'];
}
