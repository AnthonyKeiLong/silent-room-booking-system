'use strict';

require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const path = require('path');
const { TextDecoder } = require('node:util');
const express = require('express');
const bcrypt = require('bcryptjs');
const { createStudentImportJobs } = require('./student-import-jobs');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const { pool, verifyDatabaseConnection } = require('./db');
const {
  normalizeAppBasePath,
  createAppBasePathMiddleware
} = require('./app-base-path');
const { readCookie } = require('./cookie');
const { createPortalClient, PortalAccessError } = require('./portal-client.cjs');
const {
  clearOAuthCookie,
  createAttemptCookie,
  oauthCookie,
  readAttemptCookie,
  readGoogleOAuthConfig
} = require('./google-oauth');
const { slotBounds } = require('./timetable');
const { createTimetableService, lockTimetable, staleTimetable } = require('./timetable-service');
const {
  classifyBookingDate,
  createSchoolClock,
  currentBookingWindow,
  isValidDateString
} = require('./booking-window');
const {
  MAX_CSV_BYTES,
  StudentCsvError,
  parseStudentCsv
} = require('./public/student-csv-import');

function readBoundedInteger(name, fallback, minimum, maximum) {
  const rawValue = process.env[name];
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be a whole number between ${minimum} and ${maximum}.`
    );
  }
  return value;
}

const app = express();
const port = readBoundedInteger('PORT', 3000, 1, 65535);
const publicDirectory = path.join(__dirname, 'public');
const appBasePath = normalizeAppBasePath(process.env.APP_BASE_PATH);
const sessionCookiePath = appBasePath ? `${appBasePath}/` : '/';
const googleOAuthCookiePath = appBasePath
  ? `${appBasePath}/api/auth/google/`
  : '/api/auth/google/';
const sessionTtlHours = readBoundedInteger('SESSION_TTL_HOURS', 12, 1, 168);
const schoolTimeZone = process.env.SCHOOL_TIME_ZONE || 'Asia/Hong_Kong';
const sessionCookieName = 'silent_booth_session';
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !process.env.SCHOOL_PORTAL_SSO_KEY) {
  throw new Error('SCHOOL_PORTAL_SSO_KEY is required for the central school login.');
}
const portalClient = process.env.SCHOOL_PORTAL_SSO_KEY
  ? createPortalClient({ application: 'silent-room-booking', key: process.env.SCHOOL_PORTAL_SSO_KEY })
  : null;
const bcryptRounds = 12;
const studentImportJobs = createStudentImportJobs({ pool, hashPassword: password => bcrypt.hash(password, bcryptRounds) });
const dummyPasswordHash = bcrypt.hashSync('not-a-real-password', bcryptRounds);
const googleOAuth = readGoogleOAuthConfig(process.env, appBasePath);
const googleOAuthClient = googleOAuth.enabled
  ? new OAuth2Client({
    clientId: googleOAuth.clientId,
    clientSecret: googleOAuth.clientSecret,
    redirectUri: googleOAuth.redirectUri
  })
  : null;

let schoolNowParts;
try {
  schoolNowParts = createSchoolClock(schoolTimeZone);
} catch (error) {
  throw new Error(`SCHOOL_TIME_ZONE is invalid: ${schoolTimeZone}`);
}

const timetable = createTimetableService({ pool, schoolNowParts, publicBookingWindow });

app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  }
}));
app.use(createAppBasePathMiddleware(appBasePath));
app.use(express.json({ limit: '768kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');

  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const allowsEmptyBody =
      req.method === 'POST' && req.path === '/auth/logout';
    const allowsCsvBody =
      req.method === 'POST' && req.path === '/admin/users/import';
    if (
      !allowsEmptyBody && !allowsCsvBody &&
      (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))
    ) {
      return res.status(400).json({ error: '請提交有效的資料。' });
    }

    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite === 'cross-site') {
      return res.status(403).json({ error: '不允許跨網站請求。' });
    }

    const origin = req.get('origin');
    if (origin) {
      const expectedOrigin = `${req.protocol}://${req.get('host')}`;
      if (origin !== expectedOrigin) {
        return res.status(403).json({ error: '請求來源無效。' });
      }
    }
  }

  next();
});
app.use(express.static(publicDirectory));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: '登入嘗試次數過多，請在 15 分鐘後再試。' }
});

const googleLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Google 登入嘗試次數過多，請在 15 分鐘後再試。' }
});

const studentImportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  keyGenerator: (req) => req.user.email,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'CSV 匯入次數過多，請在 15 分鐘後再試。' }
});

const timetablePreviewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => req.user.email,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: '時間表預覽次數過多，請稍後再試。' }
});

let accountMutationActive = false;

const studentCsvBodyParser = express.raw({
  type: 'text/csv',
  limit: MAX_CSV_BYTES,
  inflate: false
});

function requireUtf8Csv(req, res, next) {
  const contentType = String(req.get('content-type') || '').trim();
  if (!/^text\/csv(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType)) {
    return res.status(415).json({
      error: '請上載 UTF-8 格式的 CSV 檔案。'
    });
  }
  next();
}

function asyncRoute(handler) {
  return function wrappedRoute(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function withAccountMutationLock(handler) {
  return asyncRoute(async (req, res, next) => {
    if (accountMutationActive || studentImportJobs.isRunning()) {
      if (Buffer.isBuffer(req.body)) {
        req.body.fill(0);
      }
      return res.status(409).json({
        error: '另一項帳戶操作正在進行，請稍後重新載入帳戶名單。'
      });
    }
    accountMutationActive = true;
    try {
      return await handler(req, res, next);
    } finally {
      accountMutationActive = false;
    }
  });
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function computeUsersRevision(users) {
  const revisionRows = users
    .map((user) => [
      String(user.email || ''),
      String(user.name || ''),
      String(user.class || ''),
      String(user.role || ''),
      String(user.updatedAt || '')
    ])
    .sort((left, right) => left[0].localeCompare(right[0], 'en'));

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(revisionRows), 'utf8')
    .digest('hex');
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function slotStartMinutes(slot) {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(slot);
  if (!match) return null;
  const startHour = Number(match[1]);
  const startMinute = Number(match[2]);
  const endHour = Number(match[3]);
  const endMinute = Number(match[4]);
  if (
    startHour > 23 ||
    endHour > 23 ||
    startMinute > 59 ||
    endMinute > 59 ||
    endHour * 60 + endMinute <= startHour * 60 + startMinute
  ) {
    return null;
  }
  return startHour * 60 + startMinute;
}

function publicBookingWindow(now = schoolNowParts()) {
  const window = currentBookingWindow(now.date);
  return {
    timeZone: schoolTimeZone,
    schoolDate: window.schoolDate,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    open: window.open,
    bookableFrom: window.bookableFrom,
    bookableThrough: window.bookableThrough,
    nextWeekStart: window.nextWeekStart,
    nextWeekEnd: window.nextWeekEnd,
    refreshAfterSeconds: Math.max(1, 86400 - now.secondsSinceMidnight)
  };
}

function bookingDateProblem(date, now = schoolNowParts()) {
  const classification = classifyBookingDate(date, now.date);
  const bookingWindow = publicBookingWindow(now);
  switch (classification.status) {
    case 'invalid':
      return {
        code: 'INVALID_BOOKING_DATE',
        message: '請選擇有效日期。',
        bookingWindow
      };
    case 'past':
      return {
        code: 'BOOKING_DATE_IN_PAST',
        message: '不能預約過去的日期。',
        bookingWindow
      };
    case 'closed':
      return {
        code: 'BOOKING_WINDOW_CLOSED',
        message: `星期日不開放預約；下一個預約週期將於 ${bookingWindow.nextWeekStart} 00:00 開放。`,
        bookingWindow
      };
    case 'outside':
      return {
        code: 'DATE_OUTSIDE_CURRENT_SCHOOL_WEEK',
        message: `只可預約本星期至 ${bookingWindow.bookableThrough}（星期六）的時段；下星期預約將於 ${bookingWindow.nextWeekStart} 00:00 開放。`,
        bookingWindow
      };
    default:
      return null;
  }
}

function validateBookingTiming(date, slot, now = schoolNowParts()) {
  const dateProblem = bookingDateProblem(date, now);
  if (dateProblem) {
    return dateProblem;
  }
  const startMinutes = slotStartMinutes(slot);
  if (startMinutes === null) {
    return {
      code: 'INVALID_BOOKING_SLOT',
      message: '預約時段無效。',
      bookingWindow: publicBookingWindow(now)
    };
  }
  if (date === now.date && startMinutes <= now.minutes) {
    return {
      code: 'BOOKING_SLOT_STARTED',
      message: '該時段已經開始。',
      bookingWindow: publicBookingWindow(now)
    };
  }
  return null;
}

function hasSlotStarted(date, slot) {
  const now = schoolNowParts();
  const startMinutes = slotStartMinutes(slot);
  return (
    !isValidDateString(date) ||
    startMinutes === null ||
    date < now.date ||
    (date === now.date && startMinutes <= now.minutes)
  );
}

function databaseDateTimeToIso(value) {
  if (!value) return null;
  return `${String(value).replace(' ', 'T')}Z`;
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionCookie(token, sameSite = 'Strict') {
  const attributes = [
    `${sessionCookieName}=${encodeURIComponent(token)}`,
    `Path=${sessionCookiePath}`,
    'HttpOnly',
    `SameSite=${sameSite}`,
    `Max-Age=${sessionTtlHours * 3600}`
  ];
  if (isProduction) attributes.push('Secure');
  return attributes.join('; ');
}

async function createUserSession(executor, email) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionTtlHours * 3600000)
    .toISOString()
    .slice(0, 23)
    .replace('T', ' ');
  await executor.execute(
    `INSERT INTO sessions (token_hash, user_email, expires_at)
     VALUES (?, ?, ?)`,
    [hashSessionToken(token), email, expiresAt]
  );
  await executor.query('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP(3)');
  return token;
}

function googleLoginRedirect(errorCode = '') {
  const url = new URL(googleOAuth.publicBaseUrl);
  if (errorCode) url.searchParams.set('google_error', errorCode);
  return url.toString();
}

function safeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function signInGoogleUser(identity) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT email, google_subject, display_name, class_name, role, active
         FROM users
        WHERE email = ? OR google_subject = ?
        FOR UPDATE`,
      [identity.email, identity.subject]
    );
    const user = rows.find((row) => row.email === identity.email);
    const subjectOwner = rows.find((row) => row.google_subject === identity.subject);
    if (!user || Number(user.active) !== 1 ||
        (subjectOwner && subjectOwner.email !== identity.email) ||
        (user.google_subject && user.google_subject !== identity.subject)) {
      throw Object.assign(new Error('Google identity is not available for this account.'), {
        googleLoginCode: 'not_authorized'
      });
    }

    if (!user.google_subject) {
      await connection.execute(
        `UPDATE users
            SET google_subject = ?
          WHERE email = ? AND google_subject IS NULL`,
        [identity.subject, identity.email]
      );
    }

    const token = await createUserSession(connection, user.email);
    await connection.commit();
    return token;
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      error.googleLoginCode = 'not_authorized';
    }
    throw error;
  } finally {
    connection.release();
  }
}

function expiredSessionCookie() {
  const attributes = [
    `${sessionCookieName}=`,
    `Path=${sessionCookiePath}`,
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0'
  ];
  if (isProduction) attributes.push('Secure');
  return attributes.join('; ');
}

function publicUser(row) {
  return {
    email: row.email,
    username: row.username || null,
    name: row.display_name,
    class: row.class_name,
    role: row.role,
    isTeacher: row.role === 'teacher',
    isStudent: row.role === 'student'
  };
}

async function authenticateUser(req, res, next) {
  try {
    if (portalClient) {
      const access = await portalClient.verifySession(req);
      const email = normalizeEmail(access.identity.email);
      const subject = access.identity.sub;
      const role = access.role === 'student' ? 'student' : 'teacher';
      if (!email.endsWith('@keilong.edu.hk') || !subject || !['student', 'teacher'].includes(role)) {
        throw new PortalAccessError('school_identity_required', 403);
      }
      let [rows] = await pool.execute(
        `SELECT email, username, google_subject, display_name, class_name, role, active
           FROM users WHERE email = ? OR google_subject = ? LIMIT 2`, [email, subject]);
      if (rows.length > 1 || (rows[0] && (rows[0].email !== email ||
          (rows[0].google_subject && rows[0].google_subject !== subject)))) {
        throw new PortalAccessError('application_account_conflict', 403);
      }
      if (!rows[0]) {
        // Student class membership comes from the booking roster, not Google
        // profile claims. Do not create a usable account with an empty class.
        if (role === 'student') {
          throw new PortalAccessError('student_roster_account_required', 403);
        }
        const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString('base64url'), bcryptRounds);
        try {
          await pool.execute(
            `INSERT INTO users (email, google_subject, password_hash, display_name, class_name, role, active)
             VALUES (?, ?, ?, ?, '', ?, 1)`,
            [email, subject, passwordHash, access.identity.name.slice(0, 100) || email, role]);
        } catch (error) {
          if (error.code !== 'ER_DUP_ENTRY') throw error;
        }
        [rows] = await pool.execute(
          `SELECT email, username, google_subject, display_name, class_name, role, active
             FROM users WHERE email = ? OR google_subject = ? LIMIT 2`, [email, subject]);
        if (rows.length !== 1 || rows[0].email !== email || rows[0].google_subject !== subject) {
          throw new PortalAccessError('application_account_conflict', 403);
        }
      }
      if (!rows[0].active) throw new PortalAccessError('application_account_disabled', 403);
      if (!rows[0].google_subject) {
        await pool.execute('UPDATE users SET google_subject = ? WHERE email = ? AND google_subject IS NULL', [subject, email]);
      }
      req.portalCsrf = access.csrf;
      req.user = publicUser({ ...rows[0], role });
      return next();
    }
    const token = readCookie(req, sessionCookieName);
    if (!token) {
      return res.status(401).json({ error: '請先登入。' });
    }

    const [rows] = await pool.execute(
      `SELECT u.email, u.username, u.display_name, u.class_name, u.role
         FROM sessions s
         JOIN users u ON u.email = s.user_email
        WHERE s.token_hash = ?
          AND s.expires_at > UTC_TIMESTAMP(3)
          AND u.active = 1
        LIMIT 1`,
      [hashSessionToken(token)]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: '登入已過期，請重新登入。' });
    }

    req.sessionTokenHash = hashSessionToken(token);
    req.user = publicUser(rows[0]);
    next();
  } catch (error) {
    next(error);
  }
}

function requireTeacher(req, res, next) {
  if (!req.user.isTeacher) {
    return res.status(403).json({ error: '沒有管理員權限。' });
  }
  next();
}

app.get('/api/health', asyncRoute(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', database: 'connected' });
}));

app.get('/api/auth/google/start', googleLoginLimiter, asyncRoute(async (req, res) => {
  if (portalClient) return res.status(410).json({ error: '請先在 /admin-panel/ 使用學校 Google 帳戶登入。' });
  if (!googleOAuth.enabled) {
    return res.status(404).json({ error: 'Google 登入尚未啟用。' });
  }

  const { codeVerifier, codeChallenge } =
    await googleOAuthClient.generateCodeVerifierAsync();
  const attempt = {
    state: crypto.randomBytes(32).toString('base64url'),
    nonce: crypto.randomBytes(32).toString('base64url'),
    codeVerifier,
    createdAt: Date.now()
  };
  const authorizationUrl = googleOAuthClient.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email'],
    state: attempt.state,
    nonce: attempt.nonce,
    hd: googleOAuth.allowedDomain,
    prompt: 'select_account',
    code_challenge_method: 'S256',
    code_challenge: codeChallenge
  });

  res.setHeader(
    'Set-Cookie',
    oauthCookie(
      createAttemptCookie(attempt, googleOAuth.stateSecret),
      googleOAuthCookiePath,
      isProduction
    )
  );
  res.redirect(302, authorizationUrl);
}));

app.get('/api/auth/google/callback', googleLoginLimiter, asyncRoute(async (req, res) => {
  if (portalClient) return res.redirect(303, '/admin-panel/');
  if (!googleOAuth.enabled) {
    return res.status(404).json({ error: 'Google 登入尚未啟用。' });
  }

  const expiredOAuthCookie = clearOAuthCookie(googleOAuthCookiePath, isProduction);
  const attempt = readAttemptCookie(
    readCookie(req, 'silent_booth_google_oauth'),
    googleOAuth.stateSecret
  );
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';

  if (req.query.error) {
    res.setHeader('Set-Cookie', expiredOAuthCookie);
    const result = attempt && safeStringEqual(state, attempt.state)
      ? 'cancelled'
      : 'expired';
    return res.redirect(303, googleLoginRedirect(result));
  }
  if (!attempt || !safeStringEqual(state, attempt.state) ||
      !code || code.length > 4096) {
    res.setHeader('Set-Cookie', expiredOAuthCookie);
    return res.redirect(303, googleLoginRedirect('expired'));
  }

  try {
    const { tokens } = await googleOAuthClient.getToken({
      code,
      codeVerifier: attempt.codeVerifier,
      redirect_uri: googleOAuth.redirectUri
    });
    if (!tokens.id_token) {
      throw new Error('Google did not return an ID token.');
    }
    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: googleOAuth.clientId
    });
    const payload = ticket.getPayload();
    const email = normalizeEmail(payload?.email);
    const subject = String(payload?.sub || '');
    const domainSuffix = `@${googleOAuth.allowedDomain}`;
    if (
      !payload || payload.email_verified !== true ||
      String(payload.hd || '').toLowerCase() !== googleOAuth.allowedDomain ||
      !email.endsWith(domainSuffix) || email.length <= domainSuffix.length ||
      !safeStringEqual(payload.nonce, attempt.nonce) ||
      !/^[A-Za-z0-9_-]{1,255}$/.test(subject)
    ) {
      throw Object.assign(new Error('Google Workspace identity was rejected.'), {
        googleLoginCode: 'not_authorized'
      });
    }

    const token = await signInGoogleUser({ email, subject });
    res.setHeader('Set-Cookie', [
      expiredOAuthCookie,
      sessionCookie(token, 'Lax')
    ]);
    return res.redirect(303, googleLoginRedirect());
  } catch (error) {
    if (!error.googleLoginCode) {
      console.error('Google sign-in callback failed; no OAuth credentials were logged.');
    }
    res.setHeader('Set-Cookie', expiredOAuthCookie);
    return res.redirect(
      303,
      googleLoginRedirect(error.googleLoginCode || 'unavailable')
    );
  }
}));

app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  if (portalClient) return res.status(410).json({ error: '請先在 /admin-panel/ 使用學校 Google 帳戶登入。' });
  const identifier = String(req.body.email || req.body.username || '').trim();
  const email = normalizeEmail(identifier);
  const password = String(req.body.password || '');

  if (
    (!isValidEmail(email) && !/^[a-z]{2,4}$/i.test(identifier)) ||
    password.length === 0 ||
    Buffer.byteLength(password, 'utf8') > 72
  ) {
    return res.status(400).json({ error: '請輸入有效的電郵地址和密碼。' });
  }

  const [rows] = await pool.execute(
    `SELECT email, username, password_hash, display_name, class_name, role
       FROM users
      WHERE (email = ? OR username = ?) AND active = 1
      LIMIT 1`,
    [email, identifier.toUpperCase()]
  );

  const user = rows[0];
  const passwordMatches = await bcrypt.compare(
    password,
    user?.password_hash || dummyPasswordHash
  );

  if (!passwordMatches) {
    return res.status(401).json({ error: '電郵地址或密碼不正確。' });
  }

  const token = await createUserSession(pool, user.email);

  const userResponse = publicUser(user);
  res.setHeader('Set-Cookie', sessionCookie(token));
  res.json({ user: userResponse });
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  if (portalClient) {
    await portalClient.revokeSession(req);
    res.setHeader('Set-Cookie', '__Host-school_portal=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
    return res.json({ success: true });
  }
  const token = readCookie(req, sessionCookieName);
  if (token) {
    await pool.execute('DELETE FROM sessions WHERE token_hash = ?', [
      hashSessionToken(token)
    ]);
  }
  res.setHeader('Set-Cookie', expiredSessionCookie());
  res.json({ success: true });
}));

app.get('/api/auth/verify', authenticateUser, (req, res) => {
  res.json({ user: req.user, ...(portalClient ? { csrf: req.portalCsrf } : {}) });
});

app.get('/api/config', asyncRoute(async (req, res) => {
  res.json({
    ...(await timetable.getConfig()),
    schoolPortalSso: !!portalClient,
    googleLogin: {
      enabled: !portalClient && googleOAuth.enabled,
      domain: googleOAuth.enabled ? googleOAuth.allowedDomain : null
    }
  });
}));

app.get('/api/admin/timetable', authenticateUser, requireTeacher, asyncRoute(async (req, res) => {
  res.json({
    ...await timetable.getConfig(),
    notifications: { configured: false, pending: 0, sending: 0, sent: 0, failed: 0 }
  });
}));

app.post('/api/admin/timetable/preview', authenticateUser, requireTeacher, timetablePreviewLimiter,
  asyncRoute(async (req, res) => {
    res.json(await timetable.preview({
      revision: req.body.revision, change: req.body.change,
      actorEmail: req.user.email, sessionTokenHash: req.sessionTokenHash
    }));
  })
);

app.post('/api/admin/timetable/apply', authenticateUser, requireTeacher, asyncRoute(async (req, res) => {
  res.json(await timetable.apply({
    previewId: req.body.previewId, confirmAffectedBookings: req.body.confirmAffectedBookings,
    actorEmail: req.user.email, sessionTokenHash: req.sessionTokenHash
  }));
}));

app.get('/api/schedule', authenticateUser, asyncRoute(async (req, res) => {
  const date = String(req.query.date || '');
  if (!isValidDateString(date)) return res.status(400).json({ error: '請選擇有效日期。' });
  if (!req.user.isTeacher) {
    const problem = bookingDateProblem(date);
    if (problem) {
      return res.status(400).json({
        error: problem.message, code: problem.code, bookingWindow: problem.bookingWindow
      });
    }
  }
  res.json(await timetable.getSchedule(date, req.user));
}));

app.get('/api/bookings/administrative-cancellations', authenticateUser, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT id, booking_id AS bookingId, booking_date AS date, slot, reason, cancelled_at AS cancelledAt
       FROM administrative_cancellations
      WHERE student_email = ? AND cancelled_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 90 DAY)
      ORDER BY cancelled_at DESC, id DESC LIMIT 100`,
    [req.user.email]
  );
  res.json(rows.map((row) => ({ ...row, cancelledAt: databaseDateTimeToIso(row.cancelledAt) })));
}));

app.get(
  '/api/admin/config',
  authenticateUser,
  requireTeacher,
  asyncRoute(async (req, res) => {
    const [users] = await pool.query(
      `SELECT
         email,
         display_name AS name,
         class_name AS class,
         role,
         DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updatedAt
         FROM users
        WHERE active = 1
        ORDER BY role DESC, email`
    );
    const [cancellations] = await pool.query(
      `SELECT
         id,
         booking_id AS bookingId,
         booking_date AS date,
         slot,
         student_email AS studentEmail,
         student_name AS studentName,
         reason,
         cancelled_at AS cancelledAt
       FROM cancellations
       ORDER BY cancelled_at ASC`
    );

    res.json({
      users: users.map(({ email, name, class: className, role }) => ({
        email,
        name,
        class: className,
        role
      })),
      usersRevision: computeUsersRevision(users),
      cancellations: cancellations.map((entry) => ({
        id: entry.id,
        bookingId: entry.bookingId,
        date: entry.date,
        slot: entry.slot,
        studentEmail: entry.studentEmail,
        studentName: entry.studentName,
        reason: entry.reason,
        timestamp: databaseDateTimeToIso(entry.cancelledAt)
      }))
    });
  })
);

app.post(
  '/api/admin/users/import',
  authenticateUser,
  requireTeacher,
  studentImportLimiter,
  requireUtf8Csv,
  studentCsvBodyParser,
  withAccountMutationLock(async (req, res) => {
    let csvText;
    try {
      csvText = new TextDecoder('utf-8', { fatal: true }).decode(req.body);
    } catch {
      return res.status(400).json({ error: 'CSV 必須是有效的 UTF-8 文字檔。' });
    }

    let parsed;
    try {
      parsed = parseStudentCsv(csvText);
    } catch (error) {
      if (error instanceof StudentCsvError) {
        return res.status(error.statusCode).json({
          error: error.message,
          ...(error.row ? { row: error.row } : {}),
          ...(error.field ? { field: error.field } : {})
        });
      }
      throw error;
    } finally {
      csvText = '';
      if (Buffer.isBuffer(req.body)) {
        req.body.fill(0);
      }
    }

    const students = parsed.students
      .sort((left, right) => left.email.localeCompare(right.email, 'en'));
    const job = studentImportJobs.start(students, req.user.email, req.sessionTokenHash);
    res.status(202).json(job);
  })
);

app.get('/api/admin/users/import/:jobId', authenticateUser, requireTeacher, (req, res) => {
  const job = studentImportJobs.get(req.params.jobId, req.user.email);
  if (!job) {
    return res.status(404).json({
      error: '找不到匯入記錄（可能伺服器已重啟或記錄已過期）；請先核對帳戶名單再重試。'
    });
  }
  res.json(job);
});

app.post(
  '/api/admin/config/users',
  authenticateUser,
  requireTeacher,
  withAccountMutationLock(async (req, res) => {
    const submittedRevision = String(req.body.usersRevision || '').trim();
    if (!/^[a-f0-9]{64}$/.test(submittedRevision)) {
      return res.status(400).json({
        error: '帳戶名單版本無效，請重新載入管理員頁面後再試。'
      });
    }

    const submittedUsers = req.body.users;
    if (!Array.isArray(submittedUsers) || submittedUsers.length > 2000) {
      return res.status(400).json({ error: '使用者資料格式無效。' });
    }

    const normalizedUsers = [];
    const seenEmails = new Set();

    for (const input of submittedUsers) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return res.status(400).json({ error: '使用者資料格式無效。' });
      }
      const email = normalizeEmail(input.email);
      const password = String(input.password || '');
      const name = String(input.name || '').trim();
      const className = String(input.class || '').trim();
      const role = input.role === 'teacher' ? 'teacher' : 'student';

      if (
        !isValidEmail(email) ||
        !name ||
        name.length > 100 ||
        !className ||
        className.length > 50 ||
        Buffer.byteLength(password, 'utf8') > 72 ||
        seenEmails.has(email)
      ) {
        return res.status(400).json({
          error: `使用者資料無效或重複：${email || '(沒有電郵地址)'}`
        });
      }

      seenEmails.add(email);
      normalizedUsers.push({ email, password, name, className, role });
    }

    const currentAdmin = normalizedUsers.find(
      (user) => user.email === req.user.email && user.role === 'teacher'
    );
    if (!currentAdmin) {
      return res.status(400).json({
        error: '你不能刪除自己的管理員帳戶或移除自己的管理員權限。'
      });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [lockedUsers] = await connection.query(
        `SELECT
           email,
           display_name AS name,
           class_name AS class,
           role,
           DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updatedAt
         FROM users
        WHERE active = 1
        ORDER BY email
        FOR UPDATE`
      );
      if (computeUsersRevision(lockedUsers) !== submittedRevision) {
        throw Object.assign(new Error('Stale account list revision'), {
          statusCode: 409,
          publicMessage: '帳戶名單已被另一項操作更新。為免覆蓋新資料，請重新載入名單後再作修改。'
        });
      }

      for (const user of normalizedUsers) {
        const [existingRows] = await connection.execute(
          `SELECT password_hash, role, active
             FROM users
            WHERE email = ?
            FOR UPDATE`,
          [user.email]
        );

        const existingUser = existingRows[0];
        let passwordHash = existingUser?.password_hash;
        let revokeSessions = false;
        if (user.password) {
          if (user.password.length < 10) {
            throw Object.assign(
              new Error(`Password too short for ${user.email}`),
              { statusCode: 400, publicMessage: `密碼最少需要 10 個字元：${user.email}` }
            );
          }
          passwordHash = await bcrypt.hash(user.password, bcryptRounds);
          revokeSessions = true;
        } else if (existingUser && !existingUser.active) {
          throw Object.assign(
            new Error(`Reactivated user needs a new password: ${user.email}`),
            {
              statusCode: 400,
              publicMessage: `重新啟用帳戶時必須設定新密碼：${user.email}`
            }
          );
        }

        if (!passwordHash) {
          throw Object.assign(
            new Error(`New user has no password: ${user.email}`),
            { statusCode: 400, publicMessage: `新使用者必須設定密碼：${user.email}` }
          );
        }

        await connection.execute(
          `INSERT INTO users
             (email, password_hash, display_name, class_name, role, active)
           VALUES (?, ?, ?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE
             password_hash = VALUES(password_hash),
             display_name = VALUES(display_name),
             class_name = VALUES(class_name),
             role = VALUES(role),
             active = 1`,
          [
            user.email,
            passwordHash,
            user.name,
            user.className,
            user.role
          ]
        );

        if (
          revokeSessions ||
          (existingUser && existingUser.role !== user.role) ||
          (existingUser && !existingUser.active)
        ) {
          await connection.execute(
            'DELETE FROM sessions WHERE user_email = ?',
            [user.email]
          );
        }
      }

      if (normalizedUsers.length === 0) {
        throw Object.assign(new Error('At least one user is required'), {
          statusCode: 400,
          publicMessage: '至少需要保留一個管理員帳戶。'
        });
      }

      const placeholders = normalizedUsers.map(() => '?').join(', ');
      await connection.execute(
        `UPDATE users SET active = 0 WHERE email NOT IN (${placeholders})`,
        normalizedUsers.map((user) => user.email)
      );
      await connection.execute(
        `DELETE FROM sessions WHERE user_email NOT IN (${placeholders})`,
        normalizedUsers.map((user) => user.email)
      );

      await connection.commit();
      res.json({ success: true });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  })
);

// Old clients must not bypass impact preview and explicit confirmation.
app.post('/api/admin/config/calendar', authenticateUser, requireTeacher, (req, res) => {
  res.status(409).json({
    code: 'TIMETABLE_PREVIEW_REQUIRED',
    error: '請重新載入管理頁面，使用時間表預覽及確認功能儲存修改。'
  });
});

app.get(
  '/api/bookings',
  authenticateUser,
  asyncRoute(async (req, res) => {
    if (req.query.querySelf === 'true') {
      const [rows] = await pool.execute(
        `SELECT
           id,
           booking_date AS date,
           slot,
           student_email AS studentEmail,
           student_name AS studentName,
           student_class AS studentClass,
           created_at AS createdAt
         FROM bookings
         WHERE student_email = ? AND booking_date >= ?
         ORDER BY booking_date, slot`,
        [req.user.email, schoolNowParts().date]
      );
      return res.json(
        rows
          .filter((booking) => !hasSlotStarted(booking.date, booking.slot))
          .map((booking) => ({
            ...booking,
            createdAt: databaseDateTimeToIso(booking.createdAt)
          }))
      );
    }

    const date = String(req.query.date || '');
    if (!isValidDateString(date)) {
      return res.status(400).json({ error: '請選擇有效日期。' });
    }
    if (!req.user.isTeacher) {
      const dateProblem = bookingDateProblem(date);
      if (dateProblem) {
        return res.status(400).json({
          error: dateProblem.message,
          code: dateProblem.code,
          bookingWindow: dateProblem.bookingWindow
        });
      }
    }

    res.json((await timetable.getSchedule(date, req.user)).bookings);
  })
);

app.post(
  '/api/bookings',
  authenticateUser,
  asyncRoute(async (req, res) => {
    const date = String(req.body.date || '');
    const slot = String(req.body.slot || '');

    const timingProblem = validateBookingTiming(date, slot);
    if (timingProblem || slot.length > 32) {
      const problem = timingProblem || {
        code: 'INVALID_BOOKING_SLOT',
        message: '預約時段無效。',
        bookingWindow: publicBookingWindow()
      };
      return res.status(400).json({
        error: problem.message,
        code: problem.code,
        bookingWindow: problem.bookingWindow
      });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const timetableRevision = await lockTimetable(connection);
      if (req.body.timetableRevision !== timetableRevision) {
        throw staleTimetable(timetableRevision);
      }

      // Lock the user row so simultaneous requests cannot bypass booking quotas.
      const [userRows] = await connection.execute(
        `SELECT email, display_name, class_name
           FROM users
          WHERE email = ? AND active = 1
          FOR UPDATE`,
        [req.user.email]
      );
      if (userRows.length === 0) {
        throw Object.assign(new Error('User is no longer active'), {
          statusCode: 401,
          publicMessage: '帳戶已停用，請重新登入。'
        });
      }

      const [cancellationRows] = await connection.execute(
        `SELECT cancelled_at
           FROM cancellations
          WHERE student_email = ?
            AND cancelled_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY)
          ORDER BY cancelled_at DESC`,
        [req.user.email]
      );
      if (cancellationRows.length >= 3) {
        const latestCancellation = new Date(
          `${cancellationRows[0].cancelled_at.replace(' ', 'T')}Z`
        );
        const banEnd = new Date(latestCancellation.getTime() + 7 * 86400000);
        if (Date.now() < banEnd.getTime()) {
          throw Object.assign(new Error('Cancellation limit reached'), {
            statusCode: 403,
            publicMessage: `你在過去 7 日已取消 ${cancellationRows.length} 次預約。暫停預約至 ${banEnd.toLocaleString('zh-HK', { timeZone: schoolTimeZone })}。`
          });
        }
      }

      const [slotRows] = await connection.execute(
        `SELECT ms.slot
           FROM mode_slots ms
          WHERE ms.mode_code = COALESCE(
                  (SELECT c.mode_code FROM calendar c WHERE c.booking_date = ?),
                  'default'
                )
            AND ms.slot = ?
          LIMIT 1`,
        [date, slot]
      );
      if (slotRows.length === 0) {
        throw Object.assign(new Error('Invalid operational slot'), {
          statusCode: 400,
          publicMessage: '該時段不適用於所選日期。'
        });
      }

      // A timetable edit preserves already-started reservations. A new slot must
      // not overlap one of those retained reservations, even if its label differs.
      const bounds = slotBounds(slot);
      const [overlapping] = await connection.execute(
        `SELECT slot FROM bookings WHERE booking_date = ?
           AND SUBSTRING(slot, 1, 5) < ? AND SUBSTRING(slot, 7, 5) > ? LIMIT 1`,
        [date, slot.slice(6), slot.slice(0, 5)]
      );
      if (overlapping.length > 0 || !bounds) {
        throw Object.assign(new Error('Booking interval is occupied'), {
          statusCode: 409, publicMessage: '該時段已被預約，或與已有預約重疊。'
        });
      }

      const [countRows] = await connection.execute(
        `SELECT COUNT(*) AS booking_count
           FROM bookings
          WHERE booking_date = ? AND student_email = ?`,
        [date, req.user.email]
      );
      if (Number(countRows[0].booking_count) >= 2) {
        throw Object.assign(new Error('Daily booking quota reached'), {
          statusCode: 429,
          publicMessage: '每位學生每日最多預約兩個時段。'
        });
      }

      const bookingWeek = currentBookingWindow(schoolNowParts().date);
      const [weeklyCountRows] = await connection.execute(
        `SELECT COUNT(*) AS booking_count
           FROM bookings
          WHERE student_email = ?
            AND booking_date BETWEEN ? AND ?`,
        [req.user.email, bookingWeek.weekStart, bookingWeek.weekEnd]
      );
      if (Number(weeklyCountRows[0].booking_count) >= 4) {
        throw Object.assign(new Error('Weekly booking quota reached'), {
          statusCode: 429,
          publicMessage: '每位學生每星期最多預約四個時段。'
        });
      }

      const id = crypto.randomUUID();
      const user = userRows[0];
      const commitTimingProblem = validateBookingTiming(date, slot);
      if (commitTimingProblem) {
        throw Object.assign(new Error('Booking window changed before insert'), {
          bookingProblem: commitTimingProblem
        });
      }
      await connection.execute(
        `INSERT INTO bookings
           (id, booking_date, slot, student_email, student_name, student_class, created_at)
         VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
        [id, date, slot, req.user.email, user.display_name, user.class_name]
      );

      await connection.commit();
      res.status(201).json({
        success: true,
        booking: {
          id,
          date,
          slot,
          studentEmail: req.user.email,
          studentName: user.display_name,
          studentClass: user.class_name,
          createdAt: new Date().toISOString()
        }
      });
    } catch (error) {
      await connection.rollback();
      if (error.bookingProblem) {
        return res.status(400).json({
          error: error.bookingProblem.message,
          code: error.bookingProblem.code,
          bookingWindow: error.bookingProblem.bookingWindow
        });
      }
      if (error.code === 'ER_DUP_ENTRY') {
        error.statusCode = 409;
        error.publicMessage = '該時段已被預約。';
      }
      throw error;
    } finally {
      connection.release();
    }
  })
);

app.post(
  '/api/bookings/cancel',
  authenticateUser,
  asyncRoute(async (req, res) => {
    const bookingId = String(req.body.bookingId || '');
    const reason = String(req.body.reason || '').trim() || '沒有提供原因';

    if (!/^[0-9a-f-]{36}$/i.test(bookingId) || reason.length > 500) {
      return res.status(400).json({ error: '取消資料無效。' });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await lockTimetable(connection);
      const [bookingRows] = await connection.execute(
        `SELECT
           id,
           booking_date,
           slot,
           student_email,
           student_name
         FROM bookings
         WHERE id = ?
         FOR UPDATE`,
        [bookingId]
      );

      if (bookingRows.length === 0) {
        throw Object.assign(new Error('Booking not found'), {
          statusCode: 404,
          publicMessage: '找不到該預約。'
        });
      }

      const booking = bookingRows[0];
      if (
        booking.student_email !== req.user.email &&
        !req.user.isTeacher
      ) {
        throw Object.assign(new Error('Cannot cancel another user booking'), {
          statusCode: 403,
          publicMessage: '你沒有權限取消該預約。'
        });
      }

      if (!req.user.isTeacher) {
        if (hasSlotStarted(booking.booking_date, booking.slot)) {
          throw Object.assign(new Error('Booking has already started'), {
            statusCode: 400,
            publicMessage: '已開始或已過期的預約不能取消。'
          });
        }

        await connection.execute(
          `INSERT INTO cancellations
             (id, booking_id, booking_date, slot, student_email, student_name, reason, cancelled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
          [
            crypto.randomUUID(),
            booking.id,
            booking.booking_date,
            booking.slot,
            booking.student_email,
            booking.student_name,
            reason
          ]
        );
      }

      await connection.execute('DELETE FROM bookings WHERE id = ?', [bookingId]);
      await connection.commit();
      res.json({ success: true });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  })
);

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDirectory, 'index.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: '找不到此 API。' });
  }
  res.status(404).send('Not found');
});

app.use((error, req, res, next) => {
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: '提交的檔案或資料太大。' });
  }
  if (error.type === 'encoding.unsupported') {
    return res.status(415).json({ error: '不支援壓縮的提交內容。' });
  }
  console.error(error);
  if (res.headersSent) {
    return next(error);
  }
  res.status(error.statusCode || 500).json({
    error: error.publicMessage || '伺服器發生錯誤，請稍後再試。',
    ...(error.publicCode ? { code: error.publicCode } : {}),
    ...(error.details || {})
  });
});

async function start() {
  await verifyDatabaseConnection();
  await timetable.getConfig();
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Silent Booth Booking is listening on http://127.0.0.1:${port}`);
  });

  async function shutdown(signal) {
    console.log(`${signal} received; shutting down.`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('Application failed to start:', error);
  process.exit(1);
});
