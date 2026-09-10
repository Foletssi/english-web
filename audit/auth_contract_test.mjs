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
assert.equal(auth.isLearnerProfile({ role: 'learner' }), true);
assert.equal(auth.isLearnerProfile({ role: 'student' }), true);
assert.equal(auth.isLearnerProfile({ role: 'admin' }), true);

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

await auth.updatePassword('123456', 'student');
assert.deepEqual(JSON.parse(JSON.stringify(calls[5])), ['password', { password: '123456' }]);
assert.deepEqual(JSON.parse(JSON.stringify(calls[6])), ['rpc', 'mark_my_password_set']);

const shortPassword = await auth.updatePassword('12345', 'student');
assert.equal(shortPassword.error.message, 'PASSWORD_TOO_SHORT');

const invalid = await auth.verifyPhoneOtp({ phone: '13800138000', token: '123' }, 'student');
assert.equal(invalid.error.message, 'INVALID_OTP');

const studentHtml=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const studentApp=fs.readFileSync(new URL('../assets/js/app.js',import.meta.url),'utf8');
const adminHtml=fs.readFileSync(new URL('../admin/index.html',import.meta.url),'utf8');
assert.ok(studentHtml.includes('id="authPasswordEye"')&&studentHtml.includes('aria-pressed="false"'),'student login must expose an accessible password visibility control');
assert.ok(studentApp.includes('function setPasswordVisible('),'student password visibility must update input and accessible state together');
assert.ok(studentApp.includes("visible?'eye-off':'eye'"),'student password control must show distinct visible and hidden icons');
assert.ok(studentApp.includes("input.type!=='text'"),'student password control must toggle from the live input type');
assert.ok(studentApp.includes("name:'雅思学术类 IELTS Academic'")&&studentApp.includes("name:'托福网考 TOEFL iBT'"),'student learning goals must present Chinese names before English exam abbreviations');
assert.ok(studentHtml.includes('assets/js/app.js?v=beta6.32.0'),'student app must use the current cache key');
const studentCss=fs.readFileSync(new URL('../assets/css/app.css',import.meta.url),'utf8');
assert.ok(studentCss.includes('.auth-eye{z-index:3')&&studentCss.includes('.auth-eye svg{pointer-events:none'),'student password visibility control must remain above the input hit target');
assert.ok(adminHtml.includes('data-password-target="adminAuthPass"'),'administrator login must expose the same password visibility control');

console.log(JSON.stringify({ ok: true, tests: 23 }, null, 2));
