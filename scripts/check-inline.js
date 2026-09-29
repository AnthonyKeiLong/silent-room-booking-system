'use strict';

const fs = require('fs');

for (const file of ['public/index.html', 'public/admin.html']) {
  const html = fs.readFileSync(file, 'utf8');
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const scriptBody = match[1].replace(/<!--|-->/g, '').trim();
    if (scriptBody) {
      throw new Error(`${file} contains forbidden inline script`);
    }
  }
  const forbidden = [
    [/\son[a-z]+\s*=/i, 'inline event handler'],
    [/cdn\.tailwindcss\.com/i, 'Tailwind CDN'],
    [/\blocalStorage\b/i, 'localStorage token storage'],
    [/\bAuthorization\b/i, 'browser Authorization header'],
    [/<base\b/i, 'base element'],
    [/\b(?:href|src)\s*=\s*["']\/(?!\/)/i, 'root-absolute browser URL']
  ];

  for (const [pattern, description] of forbidden) {
    if (pattern.test(html)) {
      throw new Error(`${file} contains forbidden ${description}`);
    }
  }

  console.log(`${file}: external scripts only`);
}

for (const file of [
  'public/index.js',
  'public/admin.js',
  'public/student-csv-import.js'
]) {
  const source = fs.readFileSync(file, 'utf8');
  const forbidden = [
    [/\blocalStorage\b/i, 'localStorage token storage'],
    [/\bsessionId\b/i, 'browser session identifier'],
    [/\bAuthorization\b/i, 'browser Authorization header'],
    [/\.innerHTML\b/, 'innerHTML assignment'],
    [/(?:apiRequest|fetch)\s*\(\s*[`"']\/api\//, 'root-absolute API URL'],
    [/window\.location\.(?:replace|assign)\s*\(\s*["']\//, 'root-absolute navigation']
  ];

  for (const [pattern, description] of forbidden) {
    if (pattern.test(source)) {
      throw new Error(`${file} contains forbidden ${description}`);
    }
  }

  if (
    file !== 'public/student-csv-import.js' &&
    !source.includes('fetch(resolveAppUrl(url),')
  ) {
    throw new Error(`${file} does not resolve API URLs from the application root`);
  }

  console.log(`${file}: browser security checks passed`);
}

const basePathCases = [
  ['https://school.example/', 'styles.css', '/styles.css'],
  ['https://school.example/index.html', 'api/config', '/api/config'],
  ['https://school.example/nodeapp/', 'styles.css', '/nodeapp/styles.css'],
  ['https://school.example/nodeapp/index.html', 'admin.html', '/nodeapp/admin.html'],
  ['https://school.example/nodeapp/admin.html', 'api/auth/verify', '/nodeapp/api/auth/verify'],
  ['https://school.example/nodeapp/admin.html', '', '/nodeapp/']
];

for (const [pageUrl, relativePath, expectedPath] of basePathCases) {
  const applicationRoot = new URL('.', pageUrl);
  const resolvedPath = new URL(relativePath, applicationRoot).pathname;
  if (resolvedPath !== expectedPath) {
    throw new Error(
      `URL resolution failed for ${pageUrl} + ${relativePath}: ${resolvedPath}`
    );
  }
}
console.log('browser root and /nodeapp/ URL checks passed');

const css = fs.readFileSync('public/styles.css', 'utf8');
if (css.length < 1000) {
  throw new Error('public/styles.css is missing or unexpectedly small');
}
console.log('public/styles.css: present');
