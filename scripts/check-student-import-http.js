'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

// Exercise the actual Express route/middleware with an isolated database double.
// No production database, credentials or real student records are used.
async function checkBrowserProgress() {
  const code = fs.readFileSync('public/admin.js', 'utf8');
  const start = code.indexOf("const studentImportStorageKey =");
  const end = code.indexOf('function createField(', start);
  const saved = new Map();
  const messages = [];
  let posts = 0;
  let polls = 0;
  const id = '12345678-1234-1234-1234-123456789abc';
  const context = {
    window: { sessionStorage: { setItem: (k, v) => saved.set(k, v),
      getItem: (k) => saved.get(k), removeItem: (k) => saved.delete(k) },
      setTimeout: (fn) => setImmediate(fn) },
    ApiError: class extends Error {},
    selectedStudentCsv: { text: 'private CSV' }, studentImportInProgress: false,
    setAccountEditorBusy() {}, setStudentCsvControlsBusy() {},
    setStudentCsvError: (text) => messages.push(text),
    setStudentCsvStatus: (text) => messages.push(text),
    clearSelectedStudentCsv() { context.selectedStudentCsv = null; },
    studentCsvStatus: { focus() {} }, loadAdminData: async () => {},
    errorMessage: (error) => error.message,
    apiRequest: async (url, options) => {
      if (options && options.method === 'POST') { posts++; return { jobId: id }; }
      polls++;
      return polls % 2 === 1
        ? { status: 'hashing', processed: 50, total: 1200 }
        : { status: 'completed', createdCount: 1200 };
    }
  };
  vm.createContext(context);
  vm.runInContext(code.slice(start, end), context);
  await vm.runInContext('runStudentImportFlow()', context);
  assert.equal(posts, 1);
  assert.equal(saved.size, 0);
  assert.ok(messages.some((message) => message.includes('50 / 1200')));
  assert.ok(messages.some((message) => message.includes('1200 個帳戶')));
  saved.set('silent-booth-import-2.4.1', id);
  await vm.runInContext('resumeStudentImport()', context);
  assert.equal(posts, 1, 'Refresh must poll the saved job, never re-upload passwords');
  saved.set('silent-booth-import-2.4.1', id);
  context.apiRequest = async () => { throw new Error('Network interrupted'); };
  await vm.runInContext('resumeStudentImport()', context);
  assert.equal(saved.get('silent-booth-import-2.4.1'), id);
  assert.equal(context.studentImportInProgress, false);
  console.log('Browser import checks passed: progress, result, refresh recovery and interrupted polling without duplicate submission.');
}

async function main() {
  await checkBrowserProgress();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let inserted = 0;
  const insertedRoles = [];
  const tokenHashes = new Map(['teacher', 'student', 'other'].map((name) => [
    crypto.createHash('sha256').update(name).digest('hex'), name
  ]));
  const pool = {
    async execute(sql, args) {
      if (sql.includes('JOIN users')) {
        const name = tokenHashes.get(args[0]);
        return [name ? [{ email: name + '@keilong.edu.hk', display_name: name,
          class_name: 'Staff', role: name === 'student' ? 'student' : 'teacher' }] : []];
      }
      if (sql.startsWith('SELECT email')) return [[]];
      if (sql.startsWith('INSERT')) {
        assert.match(sql, /VALUES \(\?, \?, \?, \?, \?, 1\)/);
        insertedRoles.push(args[4]);
        inserted++; return [{}];
      }
      throw new Error('Unexpected test query');
    },
    async getConnection() {
      return { execute: this.execute, async beginTransaction() {}, async commit() {},
        async rollback() {}, release() {} };
    }
  };
  const filename = path.resolve('server.js');
  const originalRequire = createRequire(filename);
  const code = fs.readFileSync(filename, 'utf8');
  const start = code.lastIndexOf('start().catch(');
  assert.ok(start > 0);
  const context = {
    require(name) {
      if (name === './db') return { pool, verifyDatabaseConnection: async () => {} };
      if (name === 'dotenv') return { config() {} };
      if (name === 'bcryptjs') return {
        hashSync: () => 'dummy',
        hash: async () => { await gate; return 'test-hash'; }
      };
      return originalRequire(name);
    },
    __dirname: path.dirname(filename), Buffer, console,
    process: { env: { APP_BASE_PATH: '/nodeapp', NODE_ENV: 'test' } }
  };
  vm.runInNewContext(code.slice(0, start) + '\nglobalThis.testApp = app;', context, { filename });
  const server = context.testApp.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/nodeapp';
  async function request(route, token, body, type = 'text/csv') {
    return fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Cookie: 'silent_booth_session=' + token } : {}),
        ...(body === undefined ? {} : { 'Content-Type': type }), Origin: new URL(base).origin },
      body
    });
  }
  try {
    const csv = ['email,password,display_name,role,username', ...Array.from({ length: 101 }, (_, i) =>
      `s${i}@keilong.edu.hk,Unique-password-${i},Account ${i},${i % 2 ? 'teacher' : 'student'},${i % 2 ? 'T' + String(i).padStart(3, '0') : ''}`)].join('\n');
    assert.equal((await request('/api/admin/users/import', '', csv)).status, 401);
    assert.equal((await request('/api/admin/users/import', 'student', csv)).status, 403);
    assert.equal((await request('/api/admin/users/import', 'teacher', 'email,password,display_name,role\na@keilong.edu.hk,Unique-password-invalid,Invalid,admin')).status, 400);
    assert.equal((await request('/api/admin/users/import', 'other', 'x'.repeat(512 * 1024 + 1))).status, 413);
    const response = await request('/api/admin/users/import', 'teacher', csv);
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.total, 101);
    assert.equal(inserted, 0, 'HTTP response must precede password hashing/database writes');
    assert.equal((await request('/api/admin/users/import/' + accepted.jobId, 'other')).status, 404);
    assert.equal((await request('/api/admin/users/import/' + accepted.jobId, 'student')).status, 403);
    assert.equal((await request('/api/admin/users/import', 'teacher', csv)).status, 409);
    assert.equal((await request('/api/admin/config/users', 'teacher', '{}', 'application/json')).status, 409);
    const progress = await request('/api/admin/users/import/' + accepted.jobId, 'teacher');
    assert.match(progress.headers.get('cache-control'), /no-store/);
    assert.equal((await progress.json()).status, 'hashing');
    release();
    let result;
    for (let i = 0; i < 50; i++) {
      result = await (await request('/api/admin/users/import/' + accepted.jobId, 'teacher')).json();
      if (result.status === 'completed') break;
      await new Promise(setImmediate);
    }
    assert.equal(result.createdCount, 101);
    assert.equal(inserted, 101);
    assert.equal(insertedRoles.filter(role => role === 'teacher').length, 50);
    assert.equal(insertedRoles.filter(role => role === 'student').length, 51);
    assert.ok(!JSON.stringify(result).includes('test-hash'));
    console.log('HTTP import checks passed: >100 students, immediate 202, protected progress, concurrent-write lock and file-size enforcement.');
  } finally {
    release();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
