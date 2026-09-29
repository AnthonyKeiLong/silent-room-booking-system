'use strict';

require('dotenv').config({ quiet: true });
const { pool, verifyDatabaseConnection } = require('../db');

const requiredTables = [
  'bookings', 'calendar', 'cancellations', 'mode_slots', 'modes', 'sessions',
  'users', 'timetable_state', 'timetable_change_previews', 'timetable_changes',
  'administrative_cancellations'
];

async function main() {
  await verifyDatabaseConnection();
  const [tables] = await pool.query('SHOW TABLES');
  const installedTables = new Set(tables.map((row) => Object.values(row)[0]));
  const missingTables = requiredTables.filter((name) => !installedTables.has(name));
  if (missingTables.length) {
    throw new Error(
      `Required version 2.5.0 tables are missing: ${missingTables.join(', ')}. ` +
      'Apply database/migrations/2.4.0-timetable.sql as the database administrator; ' +
      'do not rerun the full schema on an existing installation.'
    );
  }

  // Check the new columns without displaying previews or student records.
  await pool.query(
    `SELECT id, actor_email, session_token_hash, base_revision, proposal_json,
       impact_hash, created_at, expires_at, consumed_at, result_json
     FROM timetable_change_previews LIMIT 0`
  );
  await pool.query(
    `SELECT id, actor_email, revision_before, revision_after, change_json,
       affected_count, created_at FROM timetable_changes LIMIT 0`
  );
  await pool.query(
    `SELECT id, change_id, booking_id, booking_date, slot, student_email,
       student_name, student_class, reason, cancelled_at
     FROM administrative_cancellations LIMIT 0`
  );
  await pool.query(
    `SELECT email, google_subject, password_hash, display_name, class_name,
       role, active FROM users LIMIT 0`
  );
  const [googleSubjectIndexes] = await pool.query(
    `SELECT COLUMN_NAME AS column_name, NON_UNIQUE AS non_unique,
       SEQ_IN_INDEX AS sequence_number
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'users'
       AND INDEX_NAME = 'uq_users_google_subject'`
  );
  if (
    googleSubjectIndexes.length !== 1 ||
    googleSubjectIndexes[0].column_name !== 'google_subject' ||
    Number(googleSubjectIndexes[0].non_unique) !== 0 ||
    Number(googleSubjectIndexes[0].sequence_number) !== 1
  ) {
    throw new Error('The unique Google subject identity index is missing or invalid.');
  }
  const [states] = await pool.query('SELECT id, revision FROM timetable_state');
  if (states.length !== 1 || Number(states[0].id) !== 1 ||
      !/^\d+$/.test(String(states[0].revision)) || BigInt(states[0].revision) < 1n) {
    throw new Error('The timetable revision singleton is missing or invalid.');
  }
  const [userCounts] = await pool.query(
    `SELECT
       COUNT(*) AS total_users,
       SUM(role = 'teacher' AND active = 1) AS active_teachers
     FROM users`
  );

  console.log(
    `Database connection OK (UTC); ${tables.length} tables, ` +
    `${Number(userCounts[0].total_users)} users, and ` +
    `${Number(userCounts[0].active_teachers || 0)} active teachers.`
  );
  console.log('Version 2.5.0 schema OK; Google subject linking, timetable state and no-penalty cancellation records are available.');
}

main()
  .catch((error) => {
    console.error(`Database check failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
