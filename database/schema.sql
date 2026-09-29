-- Run this file while connected to the silent_booth_booking database.
-- It is safe to run more than once.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS users (
  email VARCHAR(254) NOT NULL,
  username VARCHAR(4) CHARACTER SET ascii COLLATE ascii_bin NULL,
  google_subject VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  password_hash VARCHAR(100) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  class_name VARCHAR(50) NOT NULL,
  role ENUM('student', 'teacher') NOT NULL DEFAULT 'student',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (email),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_google_subject (google_subject),
  CONSTRAINT chk_users_active CHECK (active IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS modes (
  mode_code VARCHAR(40) NOT NULL,
  mode_name VARCHAR(100) NOT NULL,
  PRIMARY KEY (mode_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mode_slots (
  mode_code VARCHAR(40) NOT NULL,
  slot VARCHAR(32) NOT NULL,
  slot_order SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (mode_code, slot),
  UNIQUE KEY uq_mode_slot_order (mode_code, slot_order),
  CONSTRAINT fk_mode_slots_mode
    FOREIGN KEY (mode_code) REFERENCES modes (mode_code)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS calendar (
  booking_date DATE NOT NULL,
  mode_code VARCHAR(40) NOT NULL,
  PRIMARY KEY (booking_date),
  CONSTRAINT fk_calendar_mode
    FOREIGN KEY (mode_code) REFERENCES modes (mode_code)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bookings (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  booking_date DATE NOT NULL,
  slot VARCHAR(32) NOT NULL,
  student_email VARCHAR(254) NOT NULL,
  student_name VARCHAR(100) NOT NULL,
  student_class VARCHAR(50) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_booking_date_slot (booking_date, slot),
  KEY idx_bookings_student_date (student_email, booking_date),
  CONSTRAINT fk_bookings_user
    FOREIGN KEY (student_email) REFERENCES users (email)
    ON UPDATE CASCADE ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cancellations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  booking_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  booking_date DATE NOT NULL,
  slot VARCHAR(32) NOT NULL,
  student_email VARCHAR(254) NOT NULL,
  student_name VARCHAR(100) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  cancelled_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_cancellations_student_time (student_email, cancelled_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_email VARCHAR(254) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_sessions_expiry (expires_at),
  KEY idx_sessions_user (user_email),
  CONSTRAINT fk_sessions_user
    FOREIGN KEY (user_email) REFERENCES users (email)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Additive migration: existing bookings, users and penalty cancellations are unchanged.
-- Run as the database administrator before starting release 2.4.0.
SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS timetable_state (
  id TINYINT UNSIGNED NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  CONSTRAINT chk_timetable_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO timetable_state (id, revision) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS timetable_change_previews (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_email VARCHAR(254) NOT NULL,
  session_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  base_revision BIGINT UNSIGNED NOT NULL,
  proposal_json LONGTEXT NOT NULL,
  impact_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  result_json LONGTEXT NULL,
  PRIMARY KEY (id),
  KEY idx_timetable_preview_expiry (expires_at),
  CONSTRAINT chk_timetable_proposal_json CHECK (JSON_VALID(proposal_json)),
  CONSTRAINT chk_timetable_result_json CHECK (result_json IS NULL OR JSON_VALID(result_json))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS timetable_changes (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_email VARCHAR(254) NOT NULL,
  revision_before BIGINT UNSIGNED NOT NULL,
  revision_after BIGINT UNSIGNED NOT NULL,
  change_json LONGTEXT NOT NULL,
  affected_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_timetable_change_revision (revision_after),
  CONSTRAINT chk_timetable_change_json CHECK (JSON_VALID(change_json))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Never insert timetable-driven cancellations into the student penalty table.
CREATE TABLE IF NOT EXISTS administrative_cancellations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  change_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  booking_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  booking_date DATE NOT NULL,
  slot VARCHAR(32) NOT NULL,
  student_email VARCHAR(254) NOT NULL,
  student_name VARCHAR(100) NOT NULL,
  student_class VARCHAR(50) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  cancelled_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_cancel_booking (booking_id),
  KEY idx_admin_cancellations_student_time (student_email, cancelled_at),
  CONSTRAINT fk_admin_cancellation_change FOREIGN KEY (change_id) REFERENCES timetable_changes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed only brand-new modes, inside one transaction. Rerunning this schema must
-- NEVER put removed default slots back into a teacher-customized timetable.
START TRANSACTION;
SET @seed_default = NOT EXISTS (SELECT 1 FROM modes WHERE mode_code = 'default');
SET @seed_exam = NOT EXISTS (SELECT 1 FROM modes WHERE mode_code = 'exam');
SET @seed_f6_study = NOT EXISTS (SELECT 1 FROM modes WHERE mode_code = 'f6_study');
INSERT IGNORE INTO modes (mode_code, mode_name) VALUES
  ('default', '正常上課日 (Normal Day)'),
  ('exam', '考試期間 (Exam Period)'),
  ('f6_study', '中六溫習假期 (F6 Study Leave)');
INSERT INTO mode_slots (mode_code, slot, slot_order)
SELECT 'default', '13:25-13:55', 1 WHERE @seed_default = 1
UNION ALL SELECT 'default', '16:00-16:30', 2 WHERE @seed_default = 1
UNION ALL SELECT 'default', '16:30-17:00', 3 WHERE @seed_default = 1
UNION ALL SELECT 'default', '17:00-17:30', 4 WHERE @seed_default = 1
UNION ALL SELECT 'default', '17:30-18:00', 5 WHERE @seed_default = 1
UNION ALL SELECT 'exam', '11:00-12:00', 1 WHERE @seed_exam = 1
UNION ALL SELECT 'exam', '12:00-13:00', 2 WHERE @seed_exam = 1
UNION ALL SELECT 'exam', '14:00-15:00', 3 WHERE @seed_exam = 1
UNION ALL SELECT 'exam', '15:00-16:00', 4 WHERE @seed_exam = 1
UNION ALL SELECT 'exam', '16:00-17:00', 5 WHERE @seed_exam = 1
UNION ALL SELECT 'exam', '17:00-18:00', 6 WHERE @seed_exam = 1
UNION ALL SELECT 'exam', '18:00-19:00', 7 WHERE @seed_exam = 1
UNION ALL SELECT 'f6_study', '08:00-09:00', 1 WHERE @seed_f6_study = 1
UNION ALL SELECT 'f6_study', '09:00-10:00', 2 WHERE @seed_f6_study = 1
UNION ALL SELECT 'f6_study', '10:00-11:00', 3 WHERE @seed_f6_study = 1
UNION ALL SELECT 'f6_study', '11:00-12:00', 4 WHERE @seed_f6_study = 1
UNION ALL SELECT 'f6_study', '12:00-13:00', 5 WHERE @seed_f6_study = 1
UNION ALL SELECT 'f6_study', '14:00-15:00', 6 WHERE @seed_f6_study = 1
UNION ALL SELECT 'f6_study', '15:00-16:00', 7 WHERE @seed_f6_study = 1;
COMMIT;
