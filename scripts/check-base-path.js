'use strict';

const assert = require('node:assert/strict');
const {
  normalizeAppBasePath,
  createAppBasePathMiddleware
} = require('../app-base-path');

assert.equal(normalizeAppBasePath(undefined), '');
assert.equal(normalizeAppBasePath(''), '');
assert.equal(normalizeAppBasePath('/'), '');
assert.equal(normalizeAppBasePath(' nodeapp/ '), '/nodeapp');
assert.equal(normalizeAppBasePath('/apps/nodeapp///'), '/apps/nodeapp');

for (const invalidValue of [
  '//nodeapp',
  '/node app',
  '/nodeapp?debug=1',
  '/nodeapp#fragment',
  '/nodeapp/../admin',
  '/nodeapp/%2e%2e',
  '/nodeapp\\admin'
]) {
  assert.throws(
    () => normalizeAppBasePath(invalidValue),
    /APP_BASE_PATH/
  );
}

function runMiddleware(url, path) {
  const req = { url, originalUrl: url, path };
  const result = { nextCalled: false, redirect: null };
  const res = {
    redirect(status, location) {
      result.redirect = { status, location };
    }
  };
  createAppBasePathMiddleware('/nodeapp')(req, res, () => {
    result.nextCalled = true;
  });
  return { req, result };
}

let outcome = runMiddleware('/nodeapp?source=test', '/nodeapp');
assert.deepEqual(outcome.result.redirect, {
  status: 308,
  location: '/nodeapp/?source=test'
});
assert.equal(outcome.result.nextCalled, false);

outcome = runMiddleware('/nodeapp/api/health?full=1', '/nodeapp/api/health');
assert.equal(outcome.req.url, '/api/health?full=1');
assert.equal(outcome.result.nextCalled, true);
assert.equal(outcome.result.redirect, null);

outcome = runMiddleware('/nodeapp/', '/nodeapp/');
assert.equal(outcome.req.url, '/');
assert.equal(outcome.result.nextCalled, true);

outcome = runMiddleware('/nodeapplication/api/health', '/nodeapplication/api/health');
assert.equal(outcome.req.url, '/nodeapplication/api/health');
assert.equal(outcome.result.nextCalled, true);

console.log('Base-path normalization and request rewriting checks passed.');
