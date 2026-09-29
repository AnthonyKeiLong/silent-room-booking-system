-- Additive migration for Google Workspace sign-in.
-- Existing users, passwords, roles, sessions, bookings and timetables are unchanged.
SET NAMES utf8mb4;
SET time_zone = '+00:00';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS google_subject
    VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL
    AFTER email;

SET @google_subject_index_exists = (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'users'
     AND INDEX_NAME = 'uq_users_google_subject'
);
SET @google_subject_index_sql = IF(
  @google_subject_index_exists = 0,
  'ALTER TABLE users ADD UNIQUE KEY uq_users_google_subject (google_subject)',
  'DO 0'
);
PREPARE google_subject_index_statement FROM @google_subject_index_sql;
EXECUTE google_subject_index_statement;
DEALLOCATE PREPARE google_subject_index_statement;
