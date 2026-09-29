'use strict';

(function exposeStudentCsvImport(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.StudentCsvImport = api;
  }
})(typeof globalThis === 'object' ? globalThis : this, function createStudentCsvImport() {
  const MAX_CSV_BYTES = 512 * 1024;
  const MAX_RECORD_BYTES = 2048;
  const REQUIRED_HEADERS = ['email', 'password', 'display_name'];
  const ALLOWED_HEADERS = [...REQUIRED_HEADERS, 'class_name', 'role', 'username'];
  const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

  class StudentCsvError extends Error {
    constructor(message, details = {}) {
      super(message);
      this.name = 'StudentCsvError';
      this.statusCode = details.statusCode || 400;
      this.row = details.row || null;
      this.field = details.field || null;
    }
  }

  function utf8ByteLength(value) {
    if (typeof Buffer === 'function' && typeof Buffer.byteLength === 'function') {
      return Buffer.byteLength(value, 'utf8');
    }
    return new TextEncoder().encode(value).length;
  }

  function fail(message, details) {
    throw new StudentCsvError(message, details);
  }

  function finishRecord(records, record, field, recordStartLine) {
    record.push(field);
    records.push({ line: recordStartLine, values: record });
  }

  function parseCsvRecords(csvText) {
    const records = [];
    let record = [];
    let field = '';
    let state = 'plain';
    let line = 1;
    let recordStartLine = 1;

    for (let index = 0; index < csvText.length; index += 1) {
      const character = csvText[index];

      if (state === 'quoted') {
        if (character === '"') {
          if (csvText[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            state = 'after-quote';
          }
        } else {
          field += character;
          if (character === '\n' || (character === '\r' && csvText[index + 1] !== '\n')) {
            line += 1;
          }
        }
        continue;
      }

      if (state === 'after-quote') {
        if (character === ',') {
          record.push(field);
          field = '';
          state = 'plain';
          continue;
        }
        if (character === '\r' || character === '\n') {
          finishRecord(records, record, field, recordStartLine);
          record = [];
          field = '';
          state = 'plain';
          if (character === '\r' && csvText[index + 1] === '\n') {
            index += 1;
          }
          line += 1;
          recordStartLine = line;
          continue;
        }
        fail(`第 ${line} 行的引號欄位後有無效字元。`, { row: line });
      }

      if (character === '"') {
        if (field.length !== 0) {
          fail(`第 ${line} 行的引號必須位於欄位開頭。`, { row: line });
        }
        state = 'quoted';
      } else if (character === ',') {
        record.push(field);
        field = '';
      } else if (character === '\r' || character === '\n') {
        finishRecord(records, record, field, recordStartLine);
        record = [];
        field = '';
        if (character === '\r' && csvText[index + 1] === '\n') {
          index += 1;
        }
        line += 1;
        recordStartLine = line;
      } else {
        field += character;
      }
    }

    if (state === 'quoted') {
      fail(`第 ${recordStartLine} 行有未完成的引號欄位。`, {
        row: recordStartLine
      });
    }

    const endsWithLineBreak = /(?:\r\n|\r|\n)$/.test(csvText);
    if (!endsWithLineBreak || field.length > 0 || record.length > 0) {
      finishRecord(records, record, field, recordStartLine);
    }

    return records.filter((entry) =>
      entry.values.some((value) => String(value).trim() !== '')
    );
  }

  function validateHeader(headerRecord) {
    const headers = headerRecord.values.map((value) => String(value).trim().toLowerCase());
    const seenHeaders = new Set();

    for (const header of headers) {
      if (!header || seenHeaders.has(header)) {
        fail('CSV 標題列含有空白或重複欄名。', { row: headerRecord.line });
      }
      seenHeaders.add(header);
    }

    const missingHeaders = REQUIRED_HEADERS.filter((header) => !seenHeaders.has(header));
    const unexpectedHeaders = headers.filter((header) => !ALLOWED_HEADERS.includes(header));
    if (
      missingHeaders.length > 0 ||
      unexpectedHeaders.length > 0 ||
      headers.length < 3 ||
      headers.length > 6
    ) {
      fail(
        'CSV 必須包含 email、password、display_name；teacher 必須提供 2 至 4 個英文字母的 username；role 可填 student 或 teacher，沒有 role 欄時預設 student。',
        { row: headerRecord.line }
      );
    }

    return Object.fromEntries(headers.map((header, index) => [header, index]));
  }

  function normalizeEmail(value) {
    return String(value).trim().toLowerCase();
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
  }

  function parseStudentCsv(rawText) {
    if (typeof rawText !== 'string') {
      fail('無法讀取 CSV 檔案。');
    }
    if (utf8ByteLength(rawText) > MAX_CSV_BYTES) {
      fail('CSV 檔案不可超過 512 KiB。', { statusCode: 413 });
    }
    if (rawText.includes('\u0000') || rawText.includes('\ufffd')) {
      fail('CSV 必須是有效的 UTF-8 文字檔。');
    }

    const csvText = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
    const records = parseCsvRecords(csvText);
    if (records.length < 2) {
      fail('CSV 必須包含標題列及至少一個帳戶。');
    }

    const headerIndexes = validateHeader(records[0]);
    const dataRecords = records.slice(1);

    const seenEmails = new Map();
    const seenUsernames = new Map();
    const seenPasswords = new Map();
    const students = [];

    for (const record of dataRecords) {
      if (record.values.length !== Object.keys(headerIndexes).length) {
        fail(`第 ${record.line} 行的欄位數目不正確。`, { row: record.line });
      }
      if (utf8ByteLength(record.values.join(',')) > MAX_RECORD_BYTES) {
        fail(`第 ${record.line} 行的資料過長。`, { row: record.line });
      }

      const email = normalizeEmail(record.values[headerIndexes.email]);
      const password = String(record.values[headerIndexes.password]);
      const displayName = String(record.values[headerIndexes.display_name]).trim();
      const submittedClassName = headerIndexes.class_name === undefined
        ? ''
        : String(record.values[headerIndexes.class_name]).trim();
      const role = headerIndexes.role === undefined
        ? 'student'
        : String(record.values[headerIndexes.role]).trim().toLowerCase();
      if (role !== 'student' && role !== 'teacher') {
        fail(`第 ${record.line} 行的 role 必須填寫 student 或 teacher。`, {
          row: record.line, field: 'role'
        });
      }
      const className = submittedClassName || (role === 'teacher' ? 'Staff' : 'Student');
      const username = headerIndexes.username === undefined
        ? ''
        : String(record.values[headerIndexes.username]).trim().toUpperCase();
      if (role === 'teacher' && !/^[A-Z]{2,4}$/.test(username)) {
        fail(`第 ${record.line} 行的 teacher username 必須是 2 至 4 個英文字母。`, { row: record.line, field: 'username' });
      }
      if (role === 'student' && username) {
        fail(`第 ${record.line} 行的 student 不應填寫 username。`, { row: record.line, field: 'username' });
      }
      if (username && seenUsernames.has(username)) {
        fail(`第 ${record.line} 行的教師姓名縮寫在 CSV 內重複。`, { row: record.line, field: 'username' });
      }

      if (!isValidEmail(email)) {
        fail(`第 ${record.line} 行的電郵地址無效。`, {
          row: record.line,
          field: 'email'
        });
      }
      if (seenEmails.has(email)) {
        fail(`第 ${record.line} 行的電郵地址在 CSV 內重複。`, {
          row: record.line,
          field: 'email'
        });
      }
      if (
        password.length < 10 ||
        utf8ByteLength(password) > 72 ||
        CONTROL_CHARACTER_PATTERN.test(password)
      ) {
        fail(`第 ${record.line} 行的密碼必須為 10 至 72 bytes，並且不可含控制字元。`, {
          row: record.line,
          field: 'password'
        });
      }
      if (seenPasswords.has(password)) {
        fail(`第 ${record.line} 行與另一個帳戶使用相同密碼。`, {
          row: record.line,
          field: 'password'
        });
      }
      if (
        !displayName ||
        displayName.length > 100 ||
        CONTROL_CHARACTER_PATTERN.test(displayName)
      ) {
        fail(`第 ${record.line} 行的顯示名稱無效或超過 100 個字元。`, {
          row: record.line,
          field: 'display_name'
        });
      }
      if (
        !className ||
        className.length > 50 ||
        CONTROL_CHARACTER_PATTERN.test(className)
      ) {
        fail(`第 ${record.line} 行的班別無效或超過 50 個字元。`, {
          row: record.line,
          field: 'class_name'
        });
      }

      seenEmails.set(email, record.line);
      if (username) seenUsernames.set(username, record.line);
      seenPasswords.set(password, record.line);
      students.push({
        email,
        password,
        displayName,
        className,
        role,
        username: username || null,
        sourceRow: record.line
      });
    }

    return { students, rowCount: students.length };
  }

  function createTemplate() {
    return [
      'email,password,display_name,class_name,role,username',
      'student01@keilong.edu.hk,,Student 01,1A,student,',
      'teacher01@keilong.edu.hk,,Teacher 01,Staff,teacher,ABCD'
    ].join('\r\n');
  }

  return {
    MAX_CSV_BYTES,
    StudentCsvError,
    createTemplate,
    parseStudentCsv
  };
});
