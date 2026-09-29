'use strict';
const assert = require('node:assert/strict');
const { createStudentImportJobs } = require('../student-import-jobs');

function students(count) {
  return Array.from({ length: count }, (_, i) => ({
    email: `student${i}@keilong.edu.hk`, password: `Private-password-${i}`,
    displayName: `Student ${i}`, className: '1A'
  }));
}

function fixture(options = {}) {
  const state = { rows: [], pending: [], hashes: 0, rolledBack: 0, commits: 0 };
  const connection = {
    async beginTransaction() { state.pending = []; },
    async execute(sql, values) {
      if (sql.includes('JOIN users')) return [options.expired ? [] : [{ email: 'teacher@keilong.edu.hk' }]];
      if (sql.startsWith('SELECT email')) return [options.race ? [{ email: 'already@keilong.edu.hk' }] : []];
      if (sql.startsWith('INSERT')) {
        if (options.insertFailure && state.pending.length === 50) throw new Error('Insert failed');
        assert.equal(values[2].startsWith('hashed-'), true);
        state.pending.push(values[0]); return [{}];
      }
      throw new Error('Unexpected query');
    },
    async commit() {
      state.rows.push(...state.pending); state.commits++;
      if (options.commitFailure) throw new Error('Connection lost after commit');
    },
    async rollback() { state.pending = []; state.rolledBack++; },
    release() {}
  };
  const pool = {
    async execute(sql, values) {
      assert.ok(values.length <= 250, 'Queries must stay in bounded chunks');
      return [options.existing ? [{ email: 'already@keilong.edu.hk' }] : []];
    },
    async getConnection() { return connection; }
  };
  let clock = Date.now();
  const jobs = createStudentImportJobs({
    pool, now: () => clock,
    hashPassword: async (password) => {
      state.hashes++;
      if (options.hashFailure) throw new Error('Hash failed');
      if (options.hashGate) await options.hashGate;
      return 'hashed-' + password;
    }
  });
  return { jobs, state, advance: () => { clock += 3600001; } };
}

async function finish(jobs, id) {
  for (let i = 0; i < 200; i++) {
    await new Promise(setImmediate);
    const job = jobs.get(id, 'teacher@keilong.edu.hk');
    if (['completed', 'failed', 'unknown'].includes(job.status)) return job;
  }
  throw new Error('Job did not finish');
}

async function main() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ hashGate: gate });
  const input = students(1200);
  const accepted = f.jobs.start(input, 'teacher@keilong.edu.hk', 'session-hash');
  assert.equal(accepted.status, 'queued');
  assert.equal(f.jobs.isRunning(), true);
  assert.equal(f.jobs.get(accepted.jobId, 'other-teacher@keilong.edu.hk'), null);
  assert.throws(() => f.jobs.start(students(1), 'teacher', 'token'));
  await new Promise(setImmediate);
  assert.equal(f.state.rows.length, 0);
  assert.equal(f.jobs.get(accepted.jobId, 'teacher@keilong.edu.hk').status, 'hashing');
  assert.ok(!JSON.stringify(accepted).includes('Private-password'));
  release();
  const done = await finish(f.jobs, accepted.jobId);
  assert.equal(done.createdCount, 1200);
  assert.equal(f.state.commits, 1);
  assert.equal(f.state.rows.length, 1200);
  assert.equal(input.length, 0);
  assert.equal(f.jobs.isRunning(), false);
  f.advance();
  assert.equal(f.jobs.get(accepted.jobId, 'teacher@keilong.edu.hk'), null);

  for (const option of ['existing', 'expired', 'race', 'hashFailure', 'insertFailure']) {
    const f = fixture({ [option]: true });
    const input = students(101);
    const job = f.jobs.start(input, 'teacher@keilong.edu.hk', 'session-hash');
    const done = await finish(f.jobs, job.jobId);
    assert.equal(done.status, 'failed', option);
    assert.equal(f.state.rows.length, 0, option);
    assert.equal(f.state.commits, 0, option);
    assert.equal(f.jobs.isRunning(), false, option);
    assert.equal(input.length, 0, option);
  }
  const uncertain = fixture({ commitFailure: true });
  const job = uncertain.jobs.start(students(101), 'teacher@keilong.edu.hk', 'token');
  assert.equal((await finish(uncertain.jobs, job.jobId)).status, 'unknown');
  assert.equal(uncertain.state.rows.length, 101);
  console.log('Background import checks passed: 1200 students, progress, owner privacy, locking, rollback, authorization expiry, credential cleanup and uncertain commit.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
