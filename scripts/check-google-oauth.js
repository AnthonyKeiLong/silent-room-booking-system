'use strict';

const assert = require('assert');
const fs = require('fs');
const {
  clearOAuthCookie,
  createAttemptCookie,
  oauthCookie,
  readAttemptCookie,
  readGoogleOAuthConfig
} = require('../google-oauth');

const completeEnvironment = {
  GOOGLE_OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'test-client-secret-value',
  GOOGLE_OAUTH_STATE_SECRET: '0123456789abcdef0123456789abcdef',
  GOOGLE_OAUTH_ALLOWED_DOMAIN: 'keilong.edu.hk',
  PUBLIC_BASE_URL: 'https://testing.keilong.edu.hk/nodeapp/'
};

assert.deepStrictEqual(readGoogleOAuthConfig({}, '/nodeapp'), { enabled: false });
const config = readGoogleOAuthConfig(completeEnvironment, '/nodeapp');
assert.strictEqual(config.enabled, true);
assert.strictEqual(config.allowedDomain, 'keilong.edu.hk');
assert.strictEqual(
  config.redirectUri,
  'https://testing.keilong.edu.hk/nodeapp/api/auth/google/callback'
);

assert.throws(
  () => readGoogleOAuthConfig({ GOOGLE_OAUTH_CLIENT_ID: completeEnvironment.GOOGLE_OAUTH_CLIENT_ID }, '/nodeapp'),
  /incomplete/
);
assert.throws(
  () => readGoogleOAuthConfig({ ...completeEnvironment, PUBLIC_BASE_URL: 'http://testing.keilong.edu.hk/nodeapp/' }, '/nodeapp'),
  /HTTPS/
);
assert.throws(
  () => readGoogleOAuthConfig({ ...completeEnvironment, PUBLIC_BASE_URL: 'https://testing.keilong.edu.hk/' }, '/nodeapp'),
  /APP_BASE_PATH/
);

const now = 1770000000000;
const attempt = {
  state: 'a'.repeat(43),
  nonce: 'b'.repeat(43),
  codeVerifier: `${'c'.repeat(63)}~`,
  createdAt: now
};
const signed = createAttemptCookie(attempt, completeEnvironment.GOOGLE_OAUTH_STATE_SECRET);
assert.deepStrictEqual(
  readAttemptCookie(signed, completeEnvironment.GOOGLE_OAUTH_STATE_SECRET, now + 1000),
  attempt
);
assert.strictEqual(
  readAttemptCookie(`${signed.slice(0, -1)}x`, completeEnvironment.GOOGLE_OAUTH_STATE_SECRET, now + 1000),
  null
);
assert.strictEqual(
  readAttemptCookie(signed, completeEnvironment.GOOGLE_OAUTH_STATE_SECRET, now + 601000),
  null
);

const cookie = oauthCookie(signed, '/nodeapp/api/auth/google/', true);
assert.match(cookie, /HttpOnly/);
assert.match(cookie, /SameSite=Lax/);
assert.match(cookie, /Secure/);
assert.match(clearOAuthCookie('/nodeapp/api/auth/google/', true), /Max-Age=0/);

const server = fs.readFileSync('server.js', 'utf8');
for (const required of [
  "payload.email_verified !== true",
  "String(payload.hd || '').toLowerCase() !== googleOAuth.allowedDomain",
  "safeStringEqual(payload.nonce, attempt.nonce)",
  "audience: googleOAuth.clientId",
  "google_subject = ?",
  "prompt: 'select_account'",
  "scope: ['openid', 'email']",
  "code_challenge_method: 'S256'",
  "attempt && safeStringEqual(state, attempt.state)"
]) {
  assert.ok(server.includes(required), `server.js is missing Google security check: ${required}`);
}

const html = fs.readFileSync('public/index.html', 'utf8');
assert.ok(html.includes('id="googleLoginArea"'));
assert.ok(html.includes('id="googleLoginButton"'));
assert.ok(html.includes('src="google-signin-light.svg"'));
assert.ok(html.includes('@keilong.edu.hk'));

const googleButtonAsset = fs.readFileSync('public/google-signin-light.svg', 'utf8');
assert.ok(googleButtonAsset.startsWith('<svg width="180" height="40"'));
assert.ok(googleButtonAsset.length > 20000);

const migration = fs.readFileSync('database/migrations/2.5.0-google-oauth.sql', 'utf8');
assert.ok(migration.includes('ADD COLUMN IF NOT EXISTS google_subject'));
assert.ok(migration.includes('UNIQUE KEY uq_users_google_subject (google_subject)'));

console.log('Google Workspace OAuth configuration, state/nonce/PKCE, domain, linking and UI checks passed.');
