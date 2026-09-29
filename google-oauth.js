'use strict';

const crypto = require('crypto');

const ATTEMPT_TTL_SECONDS = 10 * 60;
const VALUE_PATTERN = /^[A-Za-z0-9_-]+$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]+$/;

function requiredString(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required when Google sign-in is enabled.`);
  }
  return value;
}

function readGoogleOAuthConfig(env, appBasePath) {
  const names = [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GOOGLE_OAUTH_STATE_SECRET',
    'GOOGLE_OAUTH_ALLOWED_DOMAIN',
    'PUBLIC_BASE_URL'
  ];
  const configured = names.filter((name) => String(env[name] || '').trim());
  if (configured.length === 0) {
    return { enabled: false };
  }
  if (configured.length !== names.length) {
    const missing = names.filter((name) => !String(env[name] || '').trim());
    throw new Error(`Google sign-in configuration is incomplete: ${missing.join(', ')}`);
  }

  const clientId = requiredString(env, 'GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = requiredString(env, 'GOOGLE_OAUTH_CLIENT_SECRET');
  const stateSecret = requiredString(env, 'GOOGLE_OAUTH_STATE_SECRET');
  const allowedDomain = requiredString(env, 'GOOGLE_OAUTH_ALLOWED_DOMAIN').toLowerCase();
  const publicBaseUrl = new URL(requiredString(env, 'PUBLIC_BASE_URL'));

  if (!/^[A-Za-z0-9._-]{10,255}\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID is not a valid Google web client ID.');
  }
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(clientSecret)) {
    throw new Error('GOOGLE_OAUTH_CLIENT_SECRET has an invalid length.');
  }
  if (Buffer.byteLength(stateSecret, 'utf8') < 32 || stateSecret.length > 512) {
    throw new Error('GOOGLE_OAUTH_STATE_SECRET must contain at least 32 bytes.');
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(allowedDomain)) {
    throw new Error('GOOGLE_OAUTH_ALLOWED_DOMAIN is not a valid domain.');
  }
  if (
    publicBaseUrl.protocol !== 'https:' ||
    publicBaseUrl.username || publicBaseUrl.password ||
    publicBaseUrl.search || publicBaseUrl.hash
  ) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS URL without credentials, query, or fragment.');
  }

  const expectedPath = appBasePath || '';
  const actualPath = publicBaseUrl.pathname.replace(/\/+$/, '');
  if (actualPath !== expectedPath) {
    throw new Error(`PUBLIC_BASE_URL path must match APP_BASE_PATH (${expectedPath || '/'}).`);
  }
  publicBaseUrl.pathname = `${actualPath}/`;

  return {
    enabled: true,
    clientId,
    clientSecret,
    stateSecret,
    allowedDomain,
    publicBaseUrl: publicBaseUrl.toString(),
    redirectUri: new URL('api/auth/google/callback', publicBaseUrl).toString()
  };
}

function signPayload(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload, 'ascii').digest('base64url');
}

function createAttemptCookie(attempt, secret) {
  const payload = Buffer.from(JSON.stringify(attempt), 'utf8').toString('base64url');
  return `${payload}.${signPayload(payload, secret)}`;
}

function readAttemptCookie(value, secret, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const parts = value.split('.');
  if (parts.length !== 2 || !parts.every((part) => VALUE_PATTERN.test(part))) return null;

  const [payload, signature] = parts;
  const expected = signPayload(payload, secret);
  const suppliedBuffer = Buffer.from(signature, 'ascii');
  const expectedBuffer = Buffer.from(expected, 'ascii');
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return null;
  }

  let attempt;
  try {
    attempt = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    !attempt || typeof attempt !== 'object' ||
    !VALUE_PATTERN.test(attempt.state || '') || attempt.state.length < 32 ||
    !VALUE_PATTERN.test(attempt.nonce || '') || attempt.nonce.length < 32 ||
    !CODE_VERIFIER_PATTERN.test(attempt.codeVerifier || '') ||
    attempt.codeVerifier.length < 43 || attempt.codeVerifier.length > 128 ||
    !Number.isSafeInteger(attempt.createdAt) ||
    attempt.createdAt > now + 30000 ||
    now - attempt.createdAt > ATTEMPT_TTL_SECONDS * 1000
  ) {
    return null;
  }

  return attempt;
}

function oauthCookie(value, path, secure, maxAge = ATTEMPT_TTL_SECONDS) {
  const attributes = [
    `silent_booth_google_oauth=${encodeURIComponent(value)}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function clearOAuthCookie(path, secure) {
  return oauthCookie('', path, secure, 0);
}

module.exports = {
  ATTEMPT_TTL_SECONDS,
  clearOAuthCookie,
  createAttemptCookie,
  oauthCookie,
  readAttemptCookie,
  readGoogleOAuthConfig
};
