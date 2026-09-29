'use strict';

// Deterministic DOM-level regression tests. No network, browser, database, or real timers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class TestElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.disabled = false;
    this.checked = false;
    this.replacements = 0;
    this.events = {};
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const add = force === undefined ? !classes.has(name) : force;
        if (add) classes.add(name); else classes.delete(name);
        return add;
      }
    };
  }

  append(...elements) {
    for (const element of elements) {
      this.children.push(element);
      element.parentElement = this;
    }
  }

  appendChild(element) { this.append(element); return element; }
  replaceChildren(...elements) { this.children = []; this.replacements += 1; this.append(...elements); }
  addEventListener(name, callback) { this.events[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  toggleAttribute(name, value) { if (value) this.attributes[name] = ''; else delete this.attributes[name]; }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return true; }
  focus() { this.focused = true; }
  remove() { this.parentElement.children = this.parentElement.children.filter((element) => element !== this); }

  querySelectorAll(selector) {
    const descendants = [];
    const walk = (element) => element.children.forEach((child) => { descendants.push(child); walk(child); });
    walk(this);
    return descendants.filter((element) => {
      if (selector === 'input') return element.tagName === 'input';
      if (selector === 'input[type="time"]') return element.tagName === 'input' && element.type === 'time';
      if (selector === '[data-slot-row]') return element.dataset.slotRow === 'true';
      if (selector === '[data-add-slot]') return element.dataset.addSlot === 'true';
      if (selector === 'button[type="submit"]') return element.tagName === 'button' && element.type === 'submit';
      return element.tagName === selector;
    });
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function createBrowserHarness(fileName) {
  const elements = new Map();
  const requests = [];
  const alerts = [];
  const timers = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new TestElement());
    return elements.get(id);
  };
  let nextTimer = 1;
  const harness = { get, requests, alerts, handle: async () => ({ body: {} }) };
  const context = {
    URL, Blob, Date, console,
    alert: (message) => alerts.push(message),
    confirm: () => true,
    fetch: async (url, options) => {
      const parsed = new URL(url);
      const request = { path: parsed.pathname, search: parsed.search, options };
      requests.push(request);
      const reply = await harness.handle(request);
      const status = reply.status || 200;
      return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(reply.body) };
    },
    document: {
      getElementById: get,
      createElement: (tagName) => new TestElement(tagName),
      body: new TestElement('body'),
      visibilityState: 'visible',
      addEventListener: () => {}
    },
    window: {
      location: { href: `https://school.example/nodeapp/${fileName.replace('.js', '.html')}`, replace: () => {} },
      setTimeout: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
      clearTimeout: (id) => timers.delete(id),
      setInterval: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
      addEventListener: () => {}
    }
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', fileName), 'utf8');
  assert.equal((source.match(/void initialize\(\);/g) || []).length, 1);
  vm.runInContext(source.replace('void initialize();', ''), context, { filename: fileName });
  harness.context = context;
  harness.run = (code) => vm.runInContext(code, context);
  return harness;
}

function schoolWindow(schoolDate = '2026-08-26') {
  if (schoolDate === '2026-08-31') {
    return { timeZone: 'Asia/Hong_Kong', schoolDate, weekStart: '2026-08-31', weekEnd: '2026-09-05', open: true, bookableFrom: schoolDate, bookableThrough: '2026-09-05', nextWeekStart: '2026-09-07', nextWeekEnd: '2026-09-12', refreshAfterSeconds: 86399 };
  }
  const open = schoolDate !== '2026-08-30';
  return { timeZone: 'Asia/Hong_Kong', schoolDate, weekStart: '2026-08-24', weekEnd: '2026-08-29', open, bookableFrom: open ? schoolDate : null, bookableThrough: open ? '2026-08-29' : null, nextWeekStart: '2026-08-31', nextWeekEnd: '2026-09-05', refreshAfterSeconds: 1 };
}

function modes() {
  return {
    default: { name: '正常時間表', slots: ['09:00-09:30', '09:30-10:00'] },
    exam: { name: '考試時間表', slots: ['10:00-10:30'] },
    f6_study: { name: '中六備試', slots: ['11:00-11:30'] }
  };
}

async function checkAdministrator() {
  const browser = createBrowserHarness('admin.js');
  const state = { revision: '1', modes: modes(), calendar: { '2026-08-27': 'exam' }, bookingWindow: schoolWindow(), notifications: { configured: false } };
  let applyBehavior = 'success';
  browser.handle = async ({ path: endpoint }) => {
    if (endpoint.endsWith('/preview')) {
      return { body: { previewId: `preview-${state.revision}`, revision: state.revision, expiresAt: '2026-08-26T04:00:00.000Z', affectedCount: 1, affectedStudentCount: 1, affectedBookings: [{ id: 'booking-1', date: '2026-08-27', slot: '10:00-10:30', studentEmail: 'student@example.test', studentName: '學生' }], notificationConfigured: false } };
    }
    if (endpoint.endsWith('/apply')) {
      state.revision = String(Number(state.revision) + 1);
      if (applyBehavior === 'stale') return { status: 409, body: { code: 'PREVIEW_STALE', error: 'Preview changed' } };
      if (applyBehavior === 'unknown') throw new Error('Connection lost after commit');
      return { body: { success: true, revision: state.revision, cancelledCount: 1, emailsQueued: 0 } };
    }
    return { body: endpoint.includes('/api/bookings') ? [] : state };
  };
  await browser.run('loadTimetable()');
  assert.equal(browser.get('modeSlotEditors').children.length, 3);
  const firstForm = browser.get('modeSlotEditors').children[0];
  assert.equal(firstForm.attributes['aria-labelledby'], 'mode-editor-title-default');
  const firstInputs = firstForm.querySelectorAll('input[type="time"]');
  assert.equal(firstInputs.length, 4);
  assert.equal(firstInputs[0].required, true);
  assert.equal(firstInputs[0].parentElement.querySelector('label').htmlFor, firstInputs[0].id);
  firstInputs[1].value = '08:30';
  browser.context.testForm = firstForm;
  assert.throws(() => browser.run('modeSlotsFromForm(testForm)'), /結束時間必須晚於/);
  firstInputs[1].value = '09:45';
  assert.throws(() => browser.run('modeSlotsFromForm(testForm)'), /不可重疊/);
  firstInputs[1].value = '09:30';

  const preview = () => browser.run("requestTimetablePreview({type:'replace_mode_slots',modeCode:'default',slots:['09:00-10:00']})");
  await preview();
  assert.equal(browser.get('timetableControls').disabled, true);
  assert.equal(browser.get('applyTimetableButton').disabled, true);
  await browser.run('applyTimetablePreview()');
  assert.equal(browser.requests.filter((request) => request.path.endsWith('/apply')).length, 0);
  browser.get('confirmTimetableImpact').checked = true;
  browser.run('updateTimetableControls()');
  assert.equal(browser.get('applyTimetableButton').disabled, false, 'No-email mode must not block an impacted apply.');
  await browser.run('applyTimetablePreview()');
  assert.equal(browser.get('timetableControls').disabled, false);
  assert.match(browser.get('timetableStatus').textContent, /未寄出電郵/);
  assert.match(browser.get('timetableStatus').textContent, /沒有任何處罰/);
  assert.deepEqual(JSON.parse(browser.requests.find((request) => request.path.endsWith('/apply')).options.body), { previewId: 'preview-1', confirmAffectedBookings: true });

  await preview();
  const beforeDiscard = browser.requests.length;
  browser.run('discardTimetablePreview()');
  assert.equal(browser.requests.length, beforeDiscard, 'Discard is local and must not apply.');
  assert.equal(browser.get('timetableControls').disabled, false);

  applyBehavior = 'stale';
  await preview();
  browser.get('confirmTimetableImpact').checked = true;
  await browser.run('applyTimetablePreview()');
  assert.match(browser.get('timetableError').textContent, /重新.*預覽/);
  assert.equal(browser.run('timetablePreview'), null);

  applyBehavior = 'unknown';
  await preview();
  browser.get('confirmTimetableImpact').checked = true;
  const appliesBefore = browser.requests.filter((request) => request.path.endsWith('/apply')).length;
  await browser.run('applyTimetablePreview()');
  assert.equal(browser.requests.filter((request) => request.path.endsWith('/apply')).length, appliesBefore + 1);
  assert.match(browser.get('timetableStatus').textContent, /不能假設沒有預約被取消/);
  assert.equal(browser.run('timetablePreview'), null);
}

async function checkStudent() {
  const browser = createBrowserHarness('index.js');
  const state = {
    timetableRevision: '1',
    modes: modes(),
    calendar: {},
    bookingWindow: schoolWindow(),
    googleLogin: { enabled: false, domain: null }
  };
  let scheduleRevision = null;
  let occupied = [];
  let scheduleFailure = false;
  let personal = [];
  const notices = [{ id: 'notice-1', bookingId: 'old-1', date: '2026-08-27', slot: '10:00-10:30', reason: '老師調整時間表', cancelledAt: '2026-08-26T02:00:00Z' }];
  browser.handle = async ({ path: endpoint, search, options }) => {
    if (endpoint.endsWith('/api/config')) return { body: state };
    if (endpoint.endsWith('/api/schedule')) {
      if (scheduleFailure) throw new Error('Offline');
      return { body: { date: new URLSearchParams(search).get('date'), modeCode: 'default', mode: state.modes.default, bookings: occupied, timetableRevision: scheduleRevision || state.timetableRevision, bookingWindow: state.bookingWindow } };
    }
    if (endpoint.endsWith('/administrative-cancellations')) return { body: notices };
    if (options.method === 'POST' && endpoint.endsWith('/api/bookings')) {
      const request = JSON.parse(options.body);
      personal = [{ id: 'new-booking', date: request.date, slot: request.slot }];
      return { body: { success: true } };
    }
    return { body: personal };
  };
  await browser.run('refreshSystemConfig()');
  browser.run("showAuthenticatedState({name:'學生',class:'1A',isTeacher:false})");
  assert.equal(browser.get('bookingDate').min, '2026-08-26');
  assert.equal(browser.get('bookingDate').max, '2026-08-29');
  await browser.run('loadDaySchedule()');
  assert.equal(browser.get('slotsContainer').children.length, 2);
  assert(browser.requests.some((request) => request.path.endsWith('/api/schedule')));
  assert(!browser.requests.some((request) => request.path.endsWith('/api/bookings') && request.search.startsWith('?date=')), 'Student must use the atomic schedule endpoint.');
  const replacements = browser.get('slotsContainer').replacements;
  await browser.run('loadDaySchedule({background:true})');
  assert.equal(browser.get('slotsContainer').replacements, replacements, 'Unchanged background data must not replace the DOM.');

  browser.run("openBookingModal('09:00-09:30',dateInput.value,bookingWindowSignature(currentBookingWindow()),currentTimetableRevision())");
  assert.equal(browser.run('selectedBooking.timetableRevision'), '1');
  state.timetableRevision = '2';
  state.modes.default.slots = ['09:00-09:30', '09:30-10:00', '10:00-10:30'];
  occupied = [{ id: 'started-booking', slot: '09:15-09:45', studentName: '已開始使用', studentClass: '1A' }];
  await browser.run('loadDaySchedule({background:true})');
  assert.equal(browser.run('selectedBooking'), null, 'A new revision must close the old modal.');
  assert.equal(browser.get('slotsContainer').children[0].attributes.role, undefined);
  assert.equal(browser.get('slotsContainer').children[1].attributes.role, undefined, 'An old started booking blocks every overlapping new slot.');
  assert.equal(browser.get('slotsContainer').children[2].attributes.role, 'button');
  scheduleRevision = '1';
  await browser.run('loadDaySchedule({background:true})');
  assert.equal(browser.run('currentTimetableRevision()'), '2', 'Older responses must not roll back the revision.');
  scheduleRevision = null;

  browser.run("openBookingModal('10:00-10:30',dateInput.value,bookingWindowSignature(currentBookingWindow()),currentTimetableRevision())");
  await browser.run('submitBooking()');
  const bookingPost = browser.requests.find((request) => request.path.endsWith('/api/bookings') && request.options.method === 'POST');
  assert.equal(JSON.parse(bookingPost.options.body).timetableRevision, '2');
  browser.run("openBookingModal('10:00-10:30',dateInput.value,bookingWindowSignature(currentBookingWindow()),currentTimetableRevision())");
  state.timetableRevision = '3';
  const postsBefore = browser.requests.filter((request) => request.path.endsWith('/api/bookings') && request.options.method === 'POST').length;
  await browser.run('submitBooking()');
  assert.equal(browser.requests.filter((request) => request.path.endsWith('/api/bookings') && request.options.method === 'POST').length, postsBefore, 'A refreshed revision invalidates confirmation before POST.');

  await browser.run('loadAdministrativeCancellations()');
  assert.equal(browser.get('administrativeCancellationList').children.length, 1);
  assert.match(browser.get('administrativeCancellationList').children[0].children[2].textContent, /不計取消次數/);
  const noticesReplacements = browser.get('administrativeCancellationList').replacements;
  await browser.run('loadAdministrativeCancellations({background:true})');
  assert.equal(browser.get('administrativeCancellationList').replacements, noticesReplacements);

  scheduleFailure = true;
  await browser.run('loadDaySchedule({background:true})');
  assert.equal(browser.run('selectedBooking'), null);
  assert.equal(browser.get('slotsContainer').children[0].tagName, 'p');
  scheduleFailure = false;
  state.bookingWindow = schoolWindow('2026-08-30');
  await browser.run('refreshSystemConfig()');
  assert.equal(browser.get('bookingDate').disabled, true);
  assert.equal(browser.get('bookingDate').value, '');
  state.bookingWindow = schoolWindow('2026-08-31');
  await browser.run('refreshBookingWindow({reloadSchedule:true})');
  assert.equal(browser.get('bookingDate').disabled, false);
  assert.equal(browser.get('bookingDate').min, '2026-08-31');
  assert.equal(browser.get('bookingDate').max, '2026-09-05');
  state.bookingWindow = schoolWindow();
  await browser.run('refreshSystemConfig()');
  assert.equal(browser.get('bookingDate').min, '2026-08-31', 'Older school-day responses must not undo Monday rollover.');

  browser.context.document.visibilityState = 'hidden';
  const requestsBefore = browser.requests.length;
  await browser.run('refreshLiveView()');
  assert.equal(browser.requests.length, requestsBefore, 'Hidden tabs must not poll.');
  browser.context.document.visibilityState = 'visible';
  browser.run('showGuestState()');
  await browser.run('refreshLiveView()');
  assert.equal(browser.requests.length, requestsBefore, 'Logged-out tabs must not poll private data.');
}

Promise.resolve()
  .then(checkAdministrator)
  .then(checkStudent)
  .then(() => console.log('Timetable browser-function checks passed: explicit preview/apply, no-email/no-penalty notices, atomic schedules, revision guards, overlap protection, Sunday/Monday rollover, and refresh gating.'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
