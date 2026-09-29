SET NAMES utf8mb4;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(4) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER email;
SET @username_index_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uq_users_username');
SET @username_index_sql = IF(@username_index_exists = 0, 'ALTER TABLE users ADD UNIQUE KEY uq_users_username (username)', 'DO 0');
PREPARE username_index_statement FROM @username_index_sql;
EXECUTE username_index_statement;
DEALLOCATE PREPARE username_index_statement;
