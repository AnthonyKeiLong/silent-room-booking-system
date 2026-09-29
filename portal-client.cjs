'use strict';

const crypto = require('node:crypto');
const COOKIE = '__Host-school_portal';
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function readPortalToken(header) {
  if (typeof header !== 'string' || header.length > 16384) return null;
  const matches = header.split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(COOKIE.length + 1);
  return validToken(token) ? token : null;
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || Buffer.byteLength(a) !== Buffer.byteLength(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
class PortalAccessError extends Error {
  constructor(code, status = 401) {
    super(code); this.code = code; this.status = status; this.statusCode = status;
    this.publicMessage = status === 401
      ? '請先登入學校平台。'
      : status === 403
        ? '此學校帳戶尚未設定靜音艙預約資料，請聯絡管理員。'
        : '學校登入服務暫時無法使用，請稍後重試。';
  }
}
function createPortalClient({ application, key, endpoint = 'http://127.0.0.1:3005', fetchImpl = fetch }) {
  const url = new URL(endpoint);
  if (!['cpd', 'silent-room-booking', 'detention'].includes(application) || !validToken(key) ||
      url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' ||
      url.username || url.password || url.search || url.hash) throw new TypeError('Invalid portal client configuration');

  async function call(req, action, revoke = false) {
    const token = readPortalToken(req.headers.cookie);
    if (!token) throw new PortalAccessError('sign_in_required', 401);
    try {
      const response = await fetchImpl(`${url.origin}/internal/${action}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-School-Application': application },
        body: JSON.stringify({ token, ...(revoke ? { csrf: req.headers['x-csrf-token'] } : {}) }),
      });
      if (!response.ok) throw new PortalAccessError(response.status === 401 ? 'sign_in_required' : response.status === 403 ? 'access_denied' : 'portal_unavailable', response.status === 401 ? 401 : response.status === 403 ? 403 : 503);
      const body = await response.json();
      if (revoke) {
        if (body.ok !== true) throw new PortalAccessError('portal_unavailable', 503);
      } else if (!validToken(body.sessionId) || !validToken(body.csrf) || !Number.isSafeInteger(body.expires) ||
          body.expires <= Date.now() || !body.apps?.includes(application) ||
          !['student', 'staff', 'administrator'].includes(body.role) ||
          typeof body.identity?.sub !== 'string' || typeof body.identity?.email !== 'string') {
        throw new PortalAccessError('invalid_portal_response', 503);
      }
      return body;
    } catch (error) {
      if (error instanceof PortalAccessError) throw error;
      throw new PortalAccessError('portal_unavailable', 503);
    }
  }
  return Object.freeze({ verifySession: req => call(req, 'verify'), revokeSession: req => call(req, 'revoke', true) });
}

module.exports = { createPortalClient, PortalAccessError, readPortalToken, safeEqual };
