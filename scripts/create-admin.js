'use strict';

require('dotenv').config({ quiet: true });

const readline = require('readline/promises');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const bcryptRounds = 12;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function hiddenQuestion(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('An interactive terminal is required to enter the password safely.');
  }

  return new Promise((resolve, reject) => {
    let answer = '';
    const previousRawMode = process.stdin.isRaw;
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function cleanup() {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(Boolean(previousRawMode));
      process.stdin.pause();
      process.stdout.write('\n');
    }

    function onData(chunk) {
      for (const character of chunk) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(answer);
          return;
        }
        if (character === '\u0008' || character === '\u007f') {
          answer = answer.slice(0, -1);
          continue;
        }
        if (character >= ' ') {
          answer += character;
        }
      }
    }

    process.stdin.on('data', onData);
  });
}

async function main() {
  const terminal = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let email;
  let displayName;
  let className;
  try {
    email = normalizeEmail(await terminal.question('Administrator email: '));
    displayName = (await terminal.question('Display name: ')).trim();
    className = (await terminal.question('Class/department [Staff]: ')).trim() || 'Staff';
  } finally {
    terminal.close();
  }

  if (!isValidEmail(email)) throw new Error('The email address is invalid.');
  if (!displayName || displayName.length > 100) {
    throw new Error('Display name must contain 1 to 100 characters.');
  }
  if (className.length > 50) {
    throw new Error('Class/department must contain at most 50 characters.');
  }

  const password = await hiddenQuestion('New password (input is hidden): ');
  const confirmation = await hiddenQuestion('Confirm password: ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  if (password.length < 10) throw new Error('Password must contain at least 10 characters.');
  if (Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('Password must contain at most 72 UTF-8 bytes.');
  }

  const passwordHash = await bcrypt.hash(password, bcryptRounds);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [teachers] = await connection.query(
      `SELECT email
         FROM users
        WHERE role = 'teacher' AND active = 1
        FOR UPDATE`
    );
    if (teachers.length > 0) {
      throw new Error(
        'An active administrator already exists. Use the administrator page to manage accounts.'
      );
    }

    await connection.execute(
      `INSERT INTO users
         (email, password_hash, display_name, class_name, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'teacher', 1, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         password_hash = VALUES(password_hash),
         display_name = VALUES(display_name),
         class_name = VALUES(class_name),
         role = 'teacher',
         active = 1,
         updated_at = UTC_TIMESTAMP(3)`,
      [email, passwordHash, displayName, className]
    );
    await connection.execute('DELETE FROM sessions WHERE user_email = ?', [email]);
    await connection.commit();
    console.log(`Administrator created: ${email}`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch(async (error) => {
  console.error(`Administrator creation failed: ${error.message}`);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});
