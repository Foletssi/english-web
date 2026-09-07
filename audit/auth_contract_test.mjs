import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

function storage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

const calls = [];
const localStorage = storage();
const sessionStorage = storage();
const api = {
  auth: {
    signInWithPassword: async input => { calls.push(['password-login', input]); return { data: {}, error: null }; },
    signInWithOtp: async input => { calls.push(['send', input]); return { data: {}, error: null }; },
    verifyOtp: async input => { calls.push(['verify', input]); return { data: {}, error: null }; },
    updateUser: async input => { calls.push(['password', input]); return { data: { user: { id: 'student-1' } }, error: null }; }
  },
  rpc: async name => { calls.push(['rpc', name]); return { data: null, error: null }; }
};
const window = {
  localStorage,
  sessionStorage,
  EASTUDY_SUPABASE_CONFIG: { url: 'https://fixture.supabase.co', publishableKey: 'fixture-key' },
  supabase: { createClient: () => api }
};
const context = vm.createContext({ window, localStorage, sessionStorage, console });
vm.runInContext(fs.readFileSync(new URL('../shared/supabase-client.js', import.meta.url), 'utf8'), context);

const auth = window.EastudyAuth;
assert.equal(auth.cleanPhone('138 0013 8000'), '+8613800138000');

await auth.sendPhoneOtp({ phone: '13800138000', displayName: '测试学员', shouldCreateUser: true }, 'student');
assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ['send', {
  phone: '+8613800138000',
  options: { shouldCreateUser: true, data: { nickname: '测试学员' } }
}]);

await auth.signInPhone({ phone: '13800138000', password: 'Password123' }, 'student');
assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), ['password-login', { phone: '+8613800138000', password: 'Password123' }]);
assert.deepEqual(JSON.parse(JSON.stringify(calls[2])), ['rpc', 'mark_my_password_set']);

await auth.verifyPhoneOtp({ phone: '13800138000', token: '123456' }, 'student');
assert.deepEqual(JSON.parse(JSON.stringify(calls[3])), ['verify', { phone: '+8613800138000', token: '123456', type: 'sms' }]);
assert.deepEqual(JSON.parse(JSON.stringify(calls[4])), ['rpc', 'mark_my_phone_verified']);

await auth.updatePassword('Password123', 'student');
assert.deepEqual(JSON.parse(JSON.stringify(calls[5])), ['password', { password: 'Password123' }]);
assert.deepEqual(JSON.parse(JSON.stringify(calls[6])), ['rpc', 'mark_my_password_set']);

const invalid = await auth.verifyPhoneOtp({ phone: '13800138000', token: '123' }, 'student');
assert.equal(invalid.error.message, 'INVALID_OTP');

console.log(JSON.stringify({ ok: true, tests: 11 }, null, 2));
