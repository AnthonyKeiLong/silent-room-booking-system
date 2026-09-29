'use strict';

const assert = require('node:assert/strict');
const { readCookie } = require('../cookie');

function request(cookie = '') {
  return { headers: { cookie } };
}

assert.equal(readCookie(request(), 'silent_booth_session'), null);
assert.equal(
  readCookie(request('other=value'), 'silent_booth_session'),
  null
);
assert.equal(
  readCookie(
    request('other=value; silent_booth_session=token%20value'),
    'silent_booth_session'
  ),
  'token value'
);
assert.equal(
  readCookie(
    request('silent_booth_session=token=with=equals'),
    'silent_booth_session'
  ),
  'token=with=equals'
);
assert.equal(
  readCookie(request('silent_booth_session=broken%'), 'silent_booth_session'),
  null
);
assert.equal(
  readCookie(request('silent_booth_session=%E0%A4%A'), 'silent_booth_session'),
  null
);

console.log('Cookie parsing checks passed.');
