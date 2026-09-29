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
