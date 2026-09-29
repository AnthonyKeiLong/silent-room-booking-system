'use strict';

const crypto = require('node:crypto');

// Only public progress is retained. Passwords and hashes belong to the running
// operation and are cleared when it finishes. No credentials are written to disk.
function createStudentImportJobs({ pool, hashPassword, now = Date.now }) {
  const jobs = new Map();
  let running = false;
  const retentionMs = 60 * 60 * 1000;

  function prune() {
    for (const [id, job] of jobs) {
      if (job.finishedAt && now() - job.finishedAt >= retentionMs) jobs.delete(id);
    }
    while (jobs.size >= 32) {
      const terminal = [...jobs.values()].find((job) => job.finishedAt);
      if (!terminal) break;
      jobs.delete(terminal.id);
    }
  }

  function snapshot(job) {
    if (!job) return null;
    return {
      jobId: job.id, status: job.status, total: job.total,
      processed: job.processed, createdCount: job.createdCount,
      error: job.error || null
    };
  }

  function reject(message) {
    return Object.assign(new Error('Student import rejected'), { publicMessage: message });
  }

  async function checkExisting(executor, students, lock = false) {
    for (let offset = 0; offset < students.length; offset += 250) {
      const emails = students.slice(offset, offset + 250).map((student) => student.email);
      const [rows] = await executor.execute(
        `SELECT email FROM users WHERE email IN (${emails.map(() => '?').join(',')})${lock ? ' FOR UPDATE' : ''}`,
        emails
      );
      if (rows.length) {
        throw reject('CSV 含有已存在的電郵；本次沒有建立任何帳戶。請核對名單後重新匯入。');
      }
    }
    const usernames = students.filter((student) => student.username).map((student) => student.username);
    if (usernames.length) {
      const [rows] = await executor.execute(
        `SELECT username FROM users WHERE username IN (${usernames.map(() => '?').join(',')})${lock ? ' FOR UPDATE' : ''}`,
        usernames
      );
      if (rows.length) throw reject('CSV 含有已存在的教師姓名縮寫；本次沒有建立任何帳戶。請使用不重複的縮寫。');
    }
  }

  async function run(job, students, sessionTokenHash) {
    let connection;
    let transaction = false;
    let committing = false;
    const prepared = [];
    try {
      await checkExisting(pool, students);
      job.status = 'hashing';
      for (const student of students) {
        const passwordHash = await hashPassword(student.password);
        student.password = '';
        prepared.push({ ...student, passwordHash });
        job.processed += 1;
      }
      job.status = 'saving';
      connection = await pool.getConnection();
      await connection.beginTransaction();
      transaction = true;
      // Recheck authorization after potentially several minutes of hashing.
      const [authorized] = await connection.execute(
        `SELECT u.email FROM sessions s JOIN users u ON u.email = s.user_email
         WHERE s.token_hash = ? AND s.user_email = ?
           AND s.expires_at > UTC_TIMESTAMP(3) AND u.active = 1
           AND u.role = 'teacher' FOR UPDATE`,
        [sessionTokenHash, job.owner]
      );
      if (!authorized.length) {
        throw reject('管理員登入已失效；本次沒有建立任何帳戶。請重新登入再匯入。');
      }
      await checkExisting(connection, students, true);
      for (const student of prepared) {
        await connection.execute(
          `INSERT INTO users (email, username, password_hash, display_name, class_name, role, active)
           VALUES (?, ?, ?, ?, ?, ?, 1)`,
          [student.email, student.username, student.passwordHash, student.displayName, student.className, student.role]
        );
      }
      committing = true;
      await connection.commit();
      transaction = false;
      job.createdCount = prepared.length;
      job.status = 'completed';
    } catch (error) {
      let rolledBack = !transaction;
      if (transaction && connection) {
        try { await connection.rollback(); rolledBack = true; } catch { /* Unknown outcome shown below. */ }
      }
      job.status = committing || !rolledBack ? 'unknown' : 'failed';
      job.error = job.status === 'unknown'
        ? '未能確認資料庫提交結果；請先核對帳戶名單，切勿直接重試。'
        : error.publicMessage || '匯入失敗；本次沒有建立任何帳戶。請核對名單後重試。';
    } finally {
      if (connection) connection.release();
      for (const student of students) student.password = '';
      for (const student of prepared) student.passwordHash = '';
      students.length = 0;
      prepared.length = 0;
      job.finishedAt = now();
      running = false;
    }
  }

  return {
    isRunning: () => running,
    get(id, owner) {
      prune();
      const job = jobs.get(id);
      return job && job.owner === owner ? snapshot(job) : null;
    },
    start(students, owner, sessionTokenHash) {
      if (running) throw reject('另一項帳戶匯入正在進行，請稍後再試。');
      prune();
      const job = {
        id: crypto.randomUUID(), owner, status: 'queued', total: students.length,
        processed: 0, createdCount: 0, finishedAt: null
      };
      jobs.set(job.id, job);
      running = true;
      setImmediate(() => { void run(job, students, sessionTokenHash); });
      return snapshot(job);
    }
  };
}

module.exports = { createStudentImportJobs };
