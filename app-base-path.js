'use strict';

function normalizeAppBasePath(rawValue) {
  const trimmedValue = String(rawValue ?? '').trim();
  if (!trimmedValue || trimmedValue === '/') return '';

  const valueWithLeadingSlash = trimmedValue.startsWith('/')
    ? trimmedValue
    : `/${trimmedValue}`;
  const normalizedValue = valueWithLeadingSlash.replace(/\/+$/, '');
  const segments = normalizedValue.slice(1).split('/');
  const isSafePath =
    normalizedValue.length <= 200 &&
    segments.every(
      (segment) =>
        segment &&
        segment !== '.' &&
        segment !== '..' &&
        /^[A-Za-z0-9._~-]+$/.test(segment)
    );

  if (!isSafePath) {
    throw new Error(
      'APP_BASE_PATH must contain only safe URL path segments, for example /nodeapp.'
    );
  }

  return normalizedValue;
}

function createAppBasePathMiddleware(appBasePath) {
  return function appBasePathMiddleware(req, res, next) {
    if (!appBasePath) return next();

    if (req.path === appBasePath) {
      const queryIndex = req.originalUrl.indexOf('?');
      const queryString =
        queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
      return res.redirect(308, `${appBasePath}/${queryString}`);
    }

    if (req.path.startsWith(`${appBasePath}/`)) {
      req.url = req.url.slice(appBasePath.length) || '/';
    }

    next();
  };
}

module.exports = { normalizeAppBasePath, createAppBasePathMiddleware };
