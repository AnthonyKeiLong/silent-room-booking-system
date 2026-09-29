'use strict';

require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');

const requiredVariables = ['DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const missingVariables = requiredVariables.filter((name) => !process.env[name]);

if (missingVariables.length > 0) {
  throw new Error(
    `Missing required database environment variables: ${missingVariables.join(', ')}`
  );
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: true,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  maxIdle: Number(process.env.DB_CONNECTION_LIMIT || 10),
  idleTimeout: 60000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

// mysql2's `timezone` option controls JavaScript conversion, but it does not
// change MariaDB's session timezone. Queue this as the first command on every
// newly-created pooled connection so CURRENT_TIMESTAMP and UTC comparisons
// are consistent regardless of the server's operating-system timezone.
pool.on('connection', (connection) => {
  connection.query("SET SESSION time_zone = '+00:00'", (error) => {
    if (error) {
      console.error('Could not set MariaDB session timezone to UTC:', error);
      connection.destroy();
    }
  });
});

async function verifyDatabaseConnection() {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query(
      'SELECT 1 AS connected, @@session.time_zone AS session_time_zone'
    );
    if (rows[0]?.session_time_zone !== '+00:00') {
      throw new Error('MariaDB session timezone is not UTC.');
    }
  } finally {
    connection.release();
  }
}

module.exports = { pool, verifyDatabaseConnection };
