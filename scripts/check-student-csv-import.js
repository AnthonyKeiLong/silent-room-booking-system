'use strict';

const assert = require('node:assert/strict');
const {
  MAX_CSV_BYTES,
  StudentCsvError,
  createTemplate,
  parseStudentCsv
} = require('../public/student-csv-import');

function expectCsvError(csv, pattern, expectedStatus = 400) {
  assert.throws(
    () => parseStudentCsv(csv),
    (error) => {
      assert.ok(error instanceof StudentCsvError);
      assert.equal(error.statusCode, expectedStatus);
      assert.match(error.message, pattern);
      return true;
    }
  );
}

let result = parseStudentCsv(
  'email,password,display_name\n' +
  'student01@school.edu.hk,Temporary-2026-01,Student 01\n'
);
assert.equal(result.rowCount, 1);
assert.deepEqual(result.students[0], {
  email: 'student01@school.edu.hk',
  password: 'Temporary-2026-01',
  displayName: 'Student 01',
  className: 'Student',
  role: 'student',
  username: null,
  sourceRow: 2
});

result = parseStudentCsv(
  '\ufeffdisplay_name,class_name,password,email\r\n' +
  '"Chan, Tai ""Alex""",1A,Temporary-2026-02,STUDENT02@SCHOOL.EDU.HK\r\n'
);
assert.equal(result.rowCount, 1);
assert.equal(result.students[0].email, 'student02@school.edu.hk');
assert.equal(result.students[0].displayName, 'Chan, Tai "Alex"');
assert.equal(result.students[0].className, '1A');

result = parseStudentCsv(
  'email,password,display_name,class_name\n' +
  'student03@school.edu.hk,Temporary-2026-03,Student 03,\n'
);
assert.equal(result.students[0].className, 'Student');

const template = createTemplate();
assert.match(template, /^email,password,display_name,class_name,role,username\r\n/);
assert.match(template, /student01@keilong\.edu\.hk,,Student 01,1A,student/);
assert.match(template, /teacher01@keilong\.edu\.hk,,Teacher 01,Staff,teacher,ABCD/);
assert.doesNotMatch(template, /Temporary-|password\d|changeme/i);
expectCsvError(template, /10 至 72 bytes/);

expectCsvError(
  'email,password\nstudent@school.edu.hk,Temporary-2026-03\n',
  /display_name/
);
expectCsvError(
  'email,password,display_name,role\n' +
  'student@school.edu.hk,Temporary-2026-03,Student,admin\n',
  /role 必須/
);
expectCsvError(
  'email,password,display_name\n' +
  'student@school.edu.hk,Temporary-2026-03,Student,extra\n',
  /欄位數目/
);
expectCsvError(
  'email,password,display_name\n' +
  'student@school.edu.hk,"Temporary-2026-03,Student\n',
  /未完成的引號/
);
expectCsvError(
  'email,password,display_name\n' +
  'Student@School.edu.hk,Temporary-2026-04,Student One\n' +
  'student@school.edu.hk,Temporary-2026-05,Student Two\n',
  /重複/
);
expectCsvError(
  'email,password,display_name\n' +
  'student01@school.edu.hk,Temporary-2026-06,Student One\n' +
  'student02@school.edu.hk,Temporary-2026-06,Student Two\n',
  /相同密碼/
);
expectCsvError(
  'email,password,display_name\nstudent@school.edu.hk,short,Student\n',
  /10 至 72 bytes/
);
expectCsvError(
  `email,password,display_name\nstudent@school.edu.hk,${'a'.repeat(73)},Student\n`,
  /10 至 72 bytes/
);
expectCsvError(
  'email,password,display_name\n' +
  'student@school.edu.hk,Temporary-2026-07,"Student\nName"\n',
  /顯示名稱無效/
);
expectCsvError(
  'email,password,display_name\n' +
  'student@school.edu.hk,Temporary-2026-08,Student\ufffd\n',
  /UTF-8/
);

const maximumRows = ['email,password,display_name'];
for (let index = 1; index <= 5000; index += 1) {
  maximumRows.push(
    `student${index}@school.edu.hk,Temporary-${String(index).padStart(6, '0')},Student ${index}`
  );
}
assert.equal(parseStudentCsv(maximumRows.join('\n')).rowCount, 5000);
maximumRows.push('extra@school.edu.hk,Temporary-extra-001,Extra Student');
assert.equal(parseStudentCsv(maximumRows.join('\n')).rowCount, 5001);

expectCsvError('x'.repeat(MAX_CSV_BYTES + 1), /512 KiB/, 413);

const mixed = parseStudentCsv('email,password,display_name,role,username\n' +
  's@keilong.edu.hk,Unique-student-01,Student,student,\n' +
  't@keilong.edu.hk,Unique-teacher-01,Teacher, TEACHER ,ABCD\n');
assert.equal(mixed.students[0].role, 'student');
assert.equal(mixed.students[1].role, 'teacher');
assert.equal(mixed.students[1].username, 'ABCD');
assert.equal(mixed.students[1].className, 'Staff');
for (const role of ['', 'admin', 'teacher student', '1']) {
  expectCsvError(`email,password,display_name,role\ns@keilong.edu.hk,Unique-password-01,Name,${role}\n`, /role 必須/);
}
console.log('Account CSV checks passed: mixed roles, legacy student defaults, invalid-role rejection and 5001 accounts.');
