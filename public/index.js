'use strict';

class ApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

let systemConfig = null;
let selectedBooking = null;
let currentUser = null;
let portalCsrf = null;
let scheduleRequestSequence = 0;
let configRefreshPromise = null;
let bookingWindowRefreshTimer = null;
let resumeRefreshTimer = null;
let liveRefreshPromise = null;
let renderedScheduleSignature = '';
let personalBookingsSignature = '';
let administrativeCancellationSignature = '';
let personalBookingsRequestSequence = 0;
let administrativeCancellationRequestSequence = 0;
let bookingSubmissionInProgress = false;
let personalBookingsLoads = 0;
let administrativeCancellationLoads = 0;

const applicationRootUrl = new URL('.', window.location.href);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIMETABLE_REVISION_PATTERN = /^(0|[1-9]\d{0,19})$/;
const SLOT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

const dateInput = document.getElementById('bookingDate');
const bookingDateHelp = document.getElementById('bookingDateHelp');
const bookingWindowStatus = document.getElementById('bookingWindowStatus');
const refreshScheduleButton = document.getElementById('refreshScheduleButton');
const guestOverlay = document.getElementById('guestOverlay');
const appWorkspace = document.getElementById('appWorkspace');
const userProfile = document.getElementById('userProfile');
const userNameText = document.getElementById('userNameText');
const adminLink = document.getElementById('adminLink');
const dayInfo = document.getElementById('dayInfo');
const activeModeName = document.getElementById('activeModeName');
const slotsContainer = document.getElementById('slotsContainer');
const myBookingsList = document.getElementById('myBookingsList');
const administrativeCancellationList = document.getElementById('administrativeCancellationList');
const scheduleUpdateStatus = document.getElementById('scheduleUpdateStatus');
const bookingModal = document.getElementById('bookingModal');
const cancelModal = document.getElementById('cancelModal');
const loginForm = document.getElementById('loginForm');
const loginStatus = document.getElementById('loginStatus');
const googleLoginArea = document.getElementById('googleLoginArea');
const googleLoginButton = document.getElementById('googleLoginButton');
const cancellationForm = document.getElementById('cancellationForm');

function resolveAppUrl(relativePath = '') {
  return new URL(relativePath, applicationRootUrl);
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = String(text ?? '');
  }
  return element;
}

function errorMessage(error, fallback) {
  if (error instanceof ApiError && error.message) {
    return error.message;
  }
  return fallback;
}

async function readResponsePayload(response) {
  const body = await response.text();
  if (!body) {
    return null;
  }

  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function payloadError(payload, fallback) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }
    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message;
    }
  }
  return fallback;
}

async function apiRequest(url, options = {}, settings = {}) {
  let response;
  try {
    response = await fetch(resolveAppUrl(url), {
      ...options,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(options.headers || {})
      }
    });
  } catch {
    throw new ApiError('暫時無法連線至伺服器，請稍後再試。');
  }

  const payload = await readResponsePayload(response);
  if (response.status === 401) {
    showGuestState();
    throw new ApiError(
      payloadError(payload, '登入狀態已失效，請重新登入。'),
      response.status,
      payload
    );
  }

  if (!response.ok) {
    throw new ApiError(
      payloadError(payload, settings.fallbackError || '操作失敗，請稍後再試。'),
      response.status,
      payload
    );
  }

  return payload;
}

function setModalOpen(modal, isOpen) {
  modal.classList.toggle('hidden', !isOpen);
  modal.classList.toggle('flex', isOpen);
}

function renderMessage(container, text, className = 'text-xs text-slate-400') {
  container.replaceChildren(createElement('p', className, text));
}

function applyGoogleLoginConfig(value, schoolPortalSso = false) {
  const enabled = schoolPortalSso === true || value && value.enabled === true;
  if (schoolPortalSso) {
    googleLoginArea.classList.toggle('hidden', false);
    googleLoginButton.href = '/admin-panel/auth/google?returnTo=%2Fadmin-panel%2Froom-booking%2F';
    loginForm.hidden = true;
    return { enabled: true, domain: 'keilong.edu.hk' };
  }
  const domain = enabled && typeof value.domain === 'string'
    ? value.domain.trim().toLowerCase()
    : '';
  if (enabled && domain !== 'keilong.edu.hk') {
    throw new ApiError('Google 登入網域設定不正確。');
  }
  googleLoginArea.classList.toggle('hidden', !enabled);
  if (enabled) {
    googleLoginButton.href = resolveAppUrl('api/auth/google/start').toString();
  } else {
    googleLoginButton.removeAttribute('href');
  }
  return { enabled, domain: enabled ? domain : null };
}

function showGoogleLoginResult() {
  const url = new URL(window.location.href);
  const errorCode = url.searchParams.get('google_error');
  if (!errorCode) return;

  const messages = {
    cancelled: 'Google 登入已取消。你仍可使用電子郵件及密碼登入。',
    expired: 'Google 登入請求已過期或無效，請重新嘗試。',
    not_authorized: '此 Google 帳戶未獲授權。請使用已加入系統的 @keilong.edu.hk 帳戶。',
    unavailable: '暫時無法完成 Google 登入，請稍後再試或使用密碼登入。'
  };
  loginStatus.textContent = messages[errorCode] || messages.unavailable;
  loginStatus.classList.remove('hidden');
  url.searchParams.delete('google_error');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function normalizeBookingWindow(value) {
  if (!value || typeof value !== 'object') {
    throw new ApiError('伺服器未提供可預約日期範圍。');
  }

  const requiredDates = [
    value.schoolDate,
    value.weekStart,
    value.weekEnd,
    value.nextWeekStart,
    value.nextWeekEnd
  ];
  const refreshAfterSeconds = Number(value.refreshAfterSeconds);
  if (
    typeof value.timeZone !== 'string' ||
    !value.timeZone.trim() ||
    typeof value.open !== 'boolean' ||
    requiredDates.some((date) => !isValidDateString(date)) ||
    !Number.isFinite(refreshAfterSeconds) ||
    refreshAfterSeconds <= 0 ||
    value.weekStart > value.weekEnd ||
    value.weekEnd >= value.nextWeekStart ||
    value.nextWeekStart > value.nextWeekEnd
  ) {
    throw new ApiError('伺服器傳回的可預約日期範圍格式不正確。');
  }

  if (value.open) {
    if (
      !isValidDateString(value.bookableFrom) ||
      !isValidDateString(value.bookableThrough) ||
      value.bookableFrom !== value.schoolDate ||
      value.bookableThrough !== value.weekEnd ||
      value.schoolDate < value.weekStart ||
      value.schoolDate > value.weekEnd ||
      value.bookableFrom > value.bookableThrough
    ) {
      throw new ApiError('伺服器傳回的可預約日期範圍格式不正確。');
    }
  } else if (
    value.bookableFrom !== null ||
    value.bookableThrough !== null ||
    value.schoolDate <= value.weekEnd ||
    value.schoolDate >= value.nextWeekStart
  ) {
    throw new ApiError('伺服器傳回的休息日設定格式不正確。');
  }

  return {
    timeZone: value.timeZone.trim(),
    schoolDate: value.schoolDate,
    weekStart: value.weekStart,
    weekEnd: value.weekEnd,
    open: value.open,
    bookableFrom: value.bookableFrom,
    bookableThrough: value.bookableThrough,
    nextWeekStart: value.nextWeekStart,
    nextWeekEnd: value.nextWeekEnd,
    refreshAfterSeconds
  };
}

function bookingWindowSignature(window) {
  if (!window) {
    return '';
  }
  return [
    window.timeZone,
    window.schoolDate,
    window.weekStart,
    window.weekEnd,
    window.open ? 'open' : 'closed',
    window.bookableFrom ?? '',
    window.bookableThrough ?? '',
    window.nextWeekStart,
    window.nextWeekEnd
  ].join('|');
}

function currentBookingWindow() {
  return systemConfig && systemConfig.bookingWindow
    ? systemConfig.bookingWindow
    : null;
}

function currentTimetableRevision() {
  return systemConfig && typeof systemConfig.timetableRevision === 'string'
    ? systemConfig.timetableRevision : '';
}

function adoptTimetableRevision(revision, { clearSchedule = true } = {}) {
  if (typeof revision !== 'string' || !TIMETABLE_REVISION_PATTERN.test(revision)) {
    throw new ApiError('伺服器未提供有效的時間表版本，請重新查詢。');
  }
  const previous = currentTimetableRevision();
  if (previous && BigInt(revision) < BigInt(previous)) {
    return { changed: false, ignored: true };
  }
  const changed = previous !== revision;
  systemConfig.timetableRevision = revision;
  if (changed && previous) {
    closeBookingModal();
    if (clearSchedule) {
      clearBookingSchedule('時間表已更新，正在核對最新時段。');
    }
    scheduleUpdateStatus.textContent = '老師已更新時間表，舊的預約確認視窗已關閉。請核對最新時段及取消通知後重新選擇。';
    if (currentUser) {
      void Promise.allSettled([
        loadPersonalBookings({ background: true }),
        loadAdministrativeCancellations({ background: true })
      ]);
    }
  }
  return { changed, ignored: false };
}

function bookingDateProblem(date, window = currentBookingWindow()) {
  if (!window) {
    return '預約系統設定尚未載入，請稍後再試。';
  }
  if (!window.open) {
    return `星期日不開放預約；下一個預約週期將於 ${window.nextWeekStart} 00:00 開放。`;
  }
  if (!isValidDateString(date)) {
    return '請選擇有效的預約日期。';
  }
  if (date < window.bookableFrom || date > window.bookableThrough) {
    return `只可預約 ${window.bookableFrom} 至 ${window.bookableThrough}（星期六）的時段。`;
  }
  return '';
}

function clearBookingSchedule(message) {
  scheduleRequestSequence += 1;
  renderedScheduleSignature = '';
  dayInfo.classList.add('hidden');
  activeModeName.textContent = '---';
  renderMessage(slotsContainer, message);
}

function invalidatePendingBooking(message) {
  closeBookingModal();
  clearBookingSchedule(message);
}

function renderBookingWindowStatus(window) {
  if (window.open) {
    bookingWindowStatus.className = 'text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded p-3 mb-6';
    bookingWindowStatus.textContent = `現可預約 ${window.bookableFrom} 至 ${window.bookableThrough}（星期六）；下星期於 ${window.nextWeekStart} 00:00 開放。`;
    bookingDateHelp.textContent = `日期以 ${window.timeZone} 時區為準，只可選擇今天至本星期六。`;
    return;
  }

  bookingWindowStatus.className = 'text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-6';
  bookingWindowStatus.textContent = `星期日不開放預約；下一個預約週期將於 ${window.nextWeekStart} 00:00 開放。`;
  bookingDateHelp.textContent = `日期以 ${window.timeZone} 時區為準；星期日不開放預約。`;
}

function scheduleBookingWindowRefresh(bookingWindow) {
  if (bookingWindowRefreshTimer !== null) {
    window.clearTimeout(bookingWindowRefreshTimer);
  }
  const delay = Math.min(
    Math.max(Math.ceil(bookingWindow.refreshAfterSeconds * 1000) + 1500, 1000),
    2147483647
  );
  bookingWindowRefreshTimer = window.setTimeout(() => {
    bookingWindowRefreshTimer = null;
    void refreshBookingWindow({ reloadSchedule: true, markUnavailableOnError: true }).catch(() => {});
  }, delay);
}

function applyBookingWindow(window) {
  const previousWindow = currentBookingWindow();
  const previousSignature = bookingWindowSignature(previousWindow);
  const previousDate = dateInput.value;

  systemConfig.bookingWindow = window;
  const nextSignature = bookingWindowSignature(window);
  const windowChanged = previousSignature !== nextSignature;

  if (window.open) {
    dateInput.min = window.bookableFrom;
    dateInput.max = window.bookableThrough;
    dateInput.disabled = false;
    refreshScheduleButton.disabled = false;
    if (bookingDateProblem(previousDate, window)) {
      dateInput.value = window.bookableFrom;
    }
    dateInput.setCustomValidity('');
  } else {
    dateInput.min = '';
    dateInput.max = '';
    dateInput.value = '';
    dateInput.disabled = true;
    refreshScheduleButton.disabled = true;
  }

  renderBookingWindowStatus(window);
  scheduleBookingWindowRefresh(window);

  const dateChanged = previousDate !== dateInput.value;
  if (windowChanged || dateChanged) {
    invalidatePendingBooking(
      window.open
        ? '請選擇日期並查詢可用時段。'
        : `星期日不開放預約；${window.nextWeekStart} 00:00 開放新一週。`
    );
  }

  return { windowChanged, dateChanged };
}

function markBookingWindowUnavailable() {
  if (bookingWindowRefreshTimer !== null) {
    window.clearTimeout(bookingWindowRefreshTimer);
  }
  dateInput.disabled = true;
  refreshScheduleButton.disabled = true;
  bookingWindowStatus.className = 'text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-6';
  bookingWindowStatus.textContent = '暫時無法向伺服器確認可預約日期，預約功能已暫停。請檢查連線後再試。';
  invalidatePendingBooking('暫時無法確認可預約日期。');
  bookingWindowRefreshTimer = window.setTimeout(() => {
    bookingWindowRefreshTimer = null;
    void refreshBookingWindow({ reloadSchedule: true, markUnavailableOnError: true }).catch(() => {});
  }, 60000);
}

function showGuestState() {
  currentUser = null;
  selectedBooking = null;
  scheduleRequestSequence += 1;
  personalBookingsRequestSequence += 1;
  administrativeCancellationRequestSequence += 1;
  renderedScheduleSignature = '';
  personalBookingsSignature = '';
  administrativeCancellationSignature = '';
  guestOverlay.classList.remove('hidden');
  appWorkspace.classList.add('hidden');
  userProfile.classList.add('hidden');
  adminLink.classList.add('hidden');
  userNameText.textContent = '';
  dayInfo.classList.add('hidden');
  slotsContainer.replaceChildren();
  renderMessage(myBookingsList, '請先登入以查看預約紀錄。');
  renderMessage(administrativeCancellationList, '請先登入以查看通知。');
  setModalOpen(bookingModal, false);
  setModalOpen(cancelModal, false);
}

function showAuthenticatedState(user) {
  currentUser = user;
  guestOverlay.classList.add('hidden');
  appWorkspace.classList.remove('hidden');
  userProfile.classList.remove('hidden');
  userNameText.textContent = `${String(user.name ?? '')} (${String(user.class ?? '')})`;
  adminLink.classList.toggle('hidden', user.isTeacher !== true);
  const window = currentBookingWindow();
  if (window && !window.open) {
    renderMessage(
      slotsContainer,
      `星期日不開放預約；${window.nextWeekStart} 00:00 開放新一週。`
    );
  }
}

async function loadConfig() {
  const data = await apiRequest('api/config', {}, {
    fallbackError: '無法載入預約系統設定。'
  });

  if (
    !data ||
    typeof data !== 'object' ||
    !data.modes ||
    typeof data.modes !== 'object' ||
    !data.calendar ||
    typeof data.calendar !== 'object' ||
    !data.bookingWindow ||
    typeof data.bookingWindow !== 'object' ||
    !data.googleLogin ||
    typeof data.googleLogin !== 'object' ||
    typeof data.schoolPortalSso !== 'boolean' ||
    typeof data.timetableRevision !== 'string' ||
    !TIMETABLE_REVISION_PATTERN.test(data.timetableRevision)
  ) {
    throw new ApiError('伺服器傳回的預約系統設定格式不正確。');
  }

  const bookingWindow = normalizeBookingWindow(data.bookingWindow);
  if (!systemConfig) {
    systemConfig = {
      modes: data.modes,
      calendar: data.calendar,
      bookingWindow: null,
      timetableRevision: '',
      googleLogin: null
    };
  }
  const existingWindow = currentBookingWindow();
  if (existingWindow && bookingWindow.schoolDate < existingWindow.schoolDate) {
    return { windowChanged: false, dateChanged: false, revisionChanged: false };
  }
  const revision = adoptTimetableRevision(data.timetableRevision);
  if (!revision.ignored) {
    systemConfig.modes = data.modes;
    systemConfig.calendar = data.calendar;
  }
  systemConfig.googleLogin = applyGoogleLoginConfig(data.googleLogin, data.schoolPortalSso === true);
  return { ...applyBookingWindow(bookingWindow), revisionChanged: revision.changed };
}

async function refreshSystemConfig() {
  if (!configRefreshPromise) {
    configRefreshPromise = loadConfig().finally(() => {
      configRefreshPromise = null;
    });
  }
  return configRefreshPromise;
}

function adoptBookingWindowFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || !systemConfig) {
    return false;
  }
  try {
    let adopted = false;
    if (payload.bookingWindow) {
      const bookingWindow = normalizeBookingWindow(payload.bookingWindow);
      if (!currentBookingWindow() || bookingWindow.schoolDate >= currentBookingWindow().schoolDate) {
        applyBookingWindow(bookingWindow);
        adopted = true;
      }
    }
    if (typeof payload.timetableRevision === 'string') {
      adoptTimetableRevision(payload.timetableRevision);
      adopted = true;
    }
    return adopted;
  } catch {
    return false;
  }
}

async function refreshBookingWindow({ reloadSchedule = false, markUnavailableOnError = false, background = false } = {}) {
  try {
    await refreshSystemConfig();
    if (reloadSchedule && currentUser && !bookingDateProblem(dateInput.value)) {
      await loadDaySchedule({ background });
    }
    return true;
  } catch (error) {
    if (markUnavailableOnError) {
      markBookingWindowUnavailable();
    }
    throw error;
  }
}

function queueResumeRefresh() {
  if (document.visibilityState === 'hidden') {
    return;
  }
  if (resumeRefreshTimer !== null) {
    window.clearTimeout(resumeRefreshTimer);
  }
  resumeRefreshTimer = window.setTimeout(() => {
    resumeRefreshTimer = null;
    void refreshLiveView();
  }, 250);
}

async function refreshLiveView() {
  if (document.visibilityState === 'hidden' || !currentUser || bookingSubmissionInProgress) {
    return;
  }
  if (!liveRefreshPromise) {
    liveRefreshPromise = Promise.allSettled([
      refreshBookingWindow({ reloadSchedule: true, markUnavailableOnError: true, background: true }),
      loadPersonalBookings({ background: true }),
      loadAdministrativeCancellations({ background: true })
    ])
      .finally(() => { liveRefreshPromise = null; });
  }
  return liveRefreshPromise;
}

async function verifyLogin({ silentUnauthorized = false } = {}) {
  try {
    const data = await apiRequest('api/auth/verify', {}, {
      fallbackError: '無法核對登入狀態。'
    });

    if (!data || typeof data !== 'object' || !data.user || typeof data.user !== 'object') {
      throw new ApiError('伺服器傳回的登入資料格式不正確。');
    }

    showAuthenticatedState(data.user);
    portalCsrf = typeof data.csrf === 'string' ? data.csrf : null;
    void loadDaySchedule();
    void loadPersonalBookings();
    void loadAdministrativeCancellations();
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      window.location.replace('/admin-panel/auth/google?returnTo=%2Fadmin-panel%2Froom-booking%2F');
      return false;
    }
    if (!(silentUnauthorized && error instanceof ApiError && error.status === 401)) {
      alert(errorMessage(error, '無法核對登入狀態。'));
    }
    return false;
  }
}

async function handleLogin(event) {
  event.preventDefault();
  const submitButton = loginForm.querySelector('button[type="submit"]');
  const email = document.getElementById('loginEmail').value.trim();
  const passwordInput = document.getElementById('loginPassword');

  submitButton.disabled = true;
  try {
    await apiRequest('api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: passwordInput.value })
    }, {
      fallbackError: '登入失敗，請檢查輸入資料。'
    });

    passwordInput.value = '';
    await verifyLogin();
  } catch (error) {
    passwordInput.value = '';
    alert(`登入失敗: ${errorMessage(error, '請稍後再試。')}`);
  } finally {
    submitButton.disabled = false;
  }
}

async function handleLogout() {
  const logoutButton = document.getElementById('logoutButton');
  logoutButton.disabled = true;
  try {
    await apiRequest('api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(portalCsrf ? { 'X-CSRF-Token': portalCsrf } : {}) },
      body: JSON.stringify({})
    }, {
      fallbackError: '登出失敗。'
    });
    window.location.replace('/admin-panel/');
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      alert(errorMessage(error, '登出失敗，請稍後再試。'));
    }
  } finally {
    logoutButton.disabled = false;
  }
}

function renderBookedSlot(card, slot, booking) {
  card.className = 'p-4 border rounded-lg bg-slate-100 border-slate-200 flex justify-between items-center';

  const details = createElement('div');
  details.append(
    createElement('span', 'text-sm font-semibold text-slate-400 line-through', slot),
    createElement(
      'span',
      'block text-xs text-slate-400 mt-1',
      `${String(booking.studentClass ?? '')} ${String(booking.studentName ?? '')} 已預約`
    )
  );
  card.append(
    details,
    createElement(
      'span',
      'text-xs font-semibold text-slate-400 bg-slate-200 px-2 py-1 rounded',
      '不可預約'
    )
  );
}

function slotsOverlap(first, second) {
  return typeof first === 'string' && typeof second === 'string' &&
    SLOT_PATTERN.test(first) && SLOT_PATTERN.test(second) &&
    first.slice(0, 5) < second.slice(6) && second.slice(0, 5) < first.slice(6);
}

function renderAvailableSlot(card, slot, bookingDate, windowSignature, timetableRevision) {
  card.className = 'p-4 border rounded-lg bg-white border-blue-100 hover:border-blue-400 cursor-pointer shadow-sm hover:shadow transition flex justify-between items-center';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `預約 ${slot}`);

  const details = createElement('div');
  details.append(
    createElement('span', 'text-sm font-bold text-slate-700', slot),
    createElement('span', 'block text-xs text-green-600 mt-1', '● 尚有空位')
  );
  card.append(
    details,
    createElement('span', 'text-xs font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded', '點擊預約')
  );

  const open = () => openBookingModal(slot, bookingDate, windowSignature, timetableRevision);
  card.addEventListener('click', open);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
}

async function loadDaySchedule({ background = false } = {}) {
  const dateVal = dateInput.value;
  if (!dateVal || !currentUser) {
    return;
  }

  if (!systemConfig) {
    alert('預約系統設定尚未載入，請重新整理頁面。');
    return;
  }

  const dateProblem = bookingDateProblem(dateVal);
  if (dateProblem) {
    dateInput.setCustomValidity(dateProblem);
    if (!background) {
      dateInput.reportValidity();
      dateInput.focus();
    }
    invalidatePendingBooking(dateProblem);
    return;
  }
  dateInput.setCustomValidity('');

  if (!background) {
    closeBookingModal();
    renderedScheduleSignature = '';
    renderMessage(slotsContainer, '載入時段中...');
  }
  const requestId = ++scheduleRequestSequence;
  const requestUser = currentUser;

  try {
    const data = await apiRequest(`api/schedule?date=${encodeURIComponent(dateVal)}`, {}, {
      fallbackError: '無法載入當日時間表與預約。'
    });
    if (
      requestId !== scheduleRequestSequence ||
      dateInput.value !== dateVal ||
      currentUser !== requestUser
    ) {
      return;
    }
    if (
      !data || data.date !== dateVal || typeof data.modeCode !== 'string' ||
      !data.mode || typeof data.mode.name !== 'string' || !Array.isArray(data.mode.slots) ||
      data.mode.slots.some((slot) => typeof slot !== 'string' || !SLOT_PATTERN.test(slot)) ||
      !Array.isArray(data.bookings) || typeof data.timetableRevision !== 'string' ||
      !TIMETABLE_REVISION_PATTERN.test(data.timetableRevision)
    ) {
      throw new ApiError('伺服器傳回的時間表資料格式不正確。');
    }
    const serverWindow = normalizeBookingWindow(data.bookingWindow);
    const existingWindow = currentBookingWindow();
    if (
      (existingWindow && serverWindow.schoolDate < existingWindow.schoolDate) ||
      (currentTimetableRevision() && BigInt(data.timetableRevision) < BigInt(currentTimetableRevision()))
    ) {
      return;
    }
    applyBookingWindow(serverWindow);
    adoptTimetableRevision(data.timetableRevision, { clearSchedule: false });
    if (dateInput.value !== dateVal || bookingDateProblem(dateVal)) {
      return;
    }

    const modeData = data.mode;
    const bookings = data.bookings;
    const windowSignature = bookingWindowSignature(currentBookingWindow());
    const signature = JSON.stringify({ date: dateVal, mode: modeData, bookings, revision: data.timetableRevision, window: windowSignature });
    if (selectedBooking && bookings.some((booking) => booking && slotsOverlap(booking.slot, selectedBooking.slot))) {
      closeBookingModal();
      scheduleUpdateStatus.textContent = '剛才選擇的時段已被預約，請選擇其他時段。';
    }
    if (renderedScheduleSignature === signature) {
      return;
    }
    dayInfo.classList.remove('hidden');
    activeModeName.textContent = modeData.name;

    const cards = modeData.slots.map((rawSlot) => {
      const slot = String(rawSlot ?? '');
      const booking = bookings.find((item) => item && slotsOverlap(String(item.slot ?? ''), slot));
      const card = document.createElement('div');
      if (booking) {
        renderBookedSlot(card, slot, booking);
      } else {
        renderAvailableSlot(card, slot, dateVal, windowSignature, data.timetableRevision);
      }
      return card;
    });

    if (cards.length === 0) {
      renderMessage(slotsContainer, '當日暫無可用時段。');
    } else {
      slotsContainer.replaceChildren(...cards);
    }
    renderedScheduleSignature = signature;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return;
    }
    if (requestId !== scheduleRequestSequence || currentUser !== requestUser || dateInput.value !== dateVal) {
      return;
    }
    adoptBookingWindowFromPayload(error instanceof ApiError ? error.payload : null);
    if (dateInput.value !== dateVal || bookingDateProblem(dateVal)) {
      return;
    }
    invalidatePendingBooking('未能核對最新時間表，請稍後再查詢。');
    renderMessage(slotsContainer, errorMessage(error, '無法載入當日預約。'), 'text-sm text-red-600');
  }
}

function handleBookingDateChange() {
  const problem = bookingDateProblem(dateInput.value);
  dateInput.setCustomValidity(problem);
  invalidatePendingBooking(
    problem || '日期已更改，請按「查詢時段」載入可用時段。'
  );
  if (problem) {
    dateInput.reportValidity();
  }
}

function createPersonalBooking(booking) {
  const item = createElement('div', 'p-3 border rounded border-slate-200 bg-slate-50 space-y-2');
  const row = createElement('div', 'flex justify-between items-start');
  const details = createElement('div');
  details.append(
    createElement('strong', 'text-slate-800', booking.date),
    createElement('span', 'block text-xs text-slate-500', booking.slot)
  );

  const cancelButton = createElement(
    'button',
    'text-xs text-red-600 hover:underline font-bold',
    '取消預約'
  );
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', () => openCancelModal(String(booking.id ?? '')));
  row.append(details, cancelButton);
  item.appendChild(row);
  return item;
}

async function loadPersonalBookings({ background = false } = {}) {
  if (!currentUser || (background && personalBookingsLoads > 0)) {
    return;
  }

  const requestUser = currentUser;
  const requestId = ++personalBookingsRequestSequence;
  personalBookingsLoads += 1;
  if (!background) {
    personalBookingsSignature = '';
    renderMessage(myBookingsList, '載入中...');
  }
  try {
    const bookings = await apiRequest('api/bookings?querySelf=true', {}, {
      fallbackError: '無法載入個人預約紀錄。'
    });
    if (!Array.isArray(bookings)) {
      throw new ApiError('伺服器傳回的預約紀錄格式不正確。');
    }
    if (currentUser !== requestUser || requestId !== personalBookingsRequestSequence) {
      return;
    }
    const pendingCancellation = document.getElementById('cancelBookingId').value;
    if (pendingCancellation && !bookings.some((booking) => String(booking.id) === pendingCancellation)) {
      closeCancelModal();
    }
    const signature = JSON.stringify(bookings);
    if (personalBookingsSignature === signature) {
      return;
    }
    personalBookingsSignature = signature;

    if (bookings.length === 0) {
      renderMessage(myBookingsList, '目前沒有活躍的預約紀錄。');
      return;
    }
    myBookingsList.replaceChildren(...bookings.map(createPersonalBooking));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return;
    }
    if (currentUser !== requestUser || requestId !== personalBookingsRequestSequence) {
      return;
    }
    personalBookingsSignature = '';
    renderMessage(
      myBookingsList,
      errorMessage(error, '無法載入個人預約紀錄。'),
      'text-xs text-red-600'
    );
  } finally {
    personalBookingsLoads -= 1;
  }
}

async function loadAdministrativeCancellations({ background = false } = {}) {
  if (!currentUser || (background && administrativeCancellationLoads > 0)) {
    return;
  }
  const requestUser = currentUser;
  const requestId = ++administrativeCancellationRequestSequence;
  administrativeCancellationLoads += 1;
  if (!background) {
    administrativeCancellationSignature = '';
    renderMessage(administrativeCancellationList, '載入通知中…');
  }
  try {
    const notices = await apiRequest('api/bookings/administrative-cancellations', {}, {
      fallbackError: '無法載入時間表變更通知。'
    });
    if (!Array.isArray(notices) || notices.some((notice) => !notice || !isValidDateString(notice.date) || typeof notice.slot !== 'string' || typeof notice.reason !== 'string')) {
      throw new ApiError('伺服器傳回的取消通知格式不正確。');
    }
    if (currentUser !== requestUser || requestId !== administrativeCancellationRequestSequence) {
      return;
    }
    const signature = JSON.stringify(notices);
    if (administrativeCancellationSignature === signature) {
      return;
    }
    administrativeCancellationSignature = signature;
    if (notices.length === 0) {
      renderMessage(administrativeCancellationList, '近期沒有因時間表調整而取消的預約。');
      return;
    }
    const cards = notices.map((notice) => {
      const card = createElement('div', 'rounded border border-amber-200 bg-amber-50 p-3 space-y-1');
      const cancelledAt = new Date(notice.cancelledAt);
      const timestamp = Number.isNaN(cancelledAt.getTime()) ? '' : cancelledAt.toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });
      card.append(
        createElement('strong', 'block text-sm text-slate-800', `${notice.date} ${notice.slot} — 已取消`),
        createElement('p', 'text-xs text-slate-700', notice.reason),
        createElement('p', 'text-xs font-semibold text-blue-900', '由老師調整時間表造成，不計取消次數，沒有任何處罰。')
      );
      if (timestamp) {
        card.appendChild(createElement('p', 'text-xs text-slate-500', `處理時間：${timestamp}（香港時間）`));
      }
      return card;
    });
    administrativeCancellationList.replaceChildren(...cards);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return;
    }
    if (currentUser !== requestUser || requestId !== administrativeCancellationRequestSequence) {
      return;
    }
    administrativeCancellationSignature = '';
    renderMessage(administrativeCancellationList, errorMessage(error, '無法載入取消通知。'), 'text-xs text-red-600');
  } finally {
    administrativeCancellationLoads -= 1;
  }
}

function openBookingModal(slot, bookingDate, windowSignature, timetableRevision) {
  if (!currentUser) {
    showGuestState();
    return;
  }
  const currentSignature = bookingWindowSignature(currentBookingWindow());
  const dateProblem = bookingDateProblem(bookingDate);
  if (
    !slot ||
    dateInput.value !== bookingDate ||
    currentSignature !== windowSignature ||
    currentTimetableRevision() !== timetableRevision ||
    dateProblem
  ) {
    invalidatePendingBooking(dateProblem || '可預約日期或時間表已更新，請重新查詢時段。');
    dateInput.focus();
    return;
  }

  selectedBooking = {
    date: bookingDate,
    slot: String(slot),
    windowSignature,
    timetableRevision
  };
  document.getElementById('modalDate').textContent = selectedBooking.date;
  document.getElementById('modalSlot').textContent = selectedBooking.slot;
  document.getElementById('modalUser').textContent = `${String(currentUser.name ?? '')} (${String(currentUser.class ?? '')})`;
  setModalOpen(bookingModal, true);
}

function closeBookingModal() {
  selectedBooking = null;
  setModalOpen(bookingModal, false);
}

async function submitBooking() {
  if (bookingSubmissionInProgress) {
    return;
  }
  if (!selectedBooking) {
    alert('請先選擇預約時段。');
    return;
  }

  const confirmButton = document.getElementById('confirmBookingButton');
  confirmButton.disabled = true;
  bookingSubmissionInProgress = true;
  try {
    const bookingToSubmit = { ...selectedBooking };
    await refreshBookingWindow();
    const dateProblem = bookingDateProblem(bookingToSubmit.date);
    if (
      !selectedBooking ||
      selectedBooking.date !== bookingToSubmit.date ||
      selectedBooking.slot !== bookingToSubmit.slot ||
      selectedBooking.timetableRevision !== bookingToSubmit.timetableRevision ||
      dateInput.value !== bookingToSubmit.date ||
      bookingWindowSignature(currentBookingWindow()) !== bookingToSubmit.windowSignature ||
      currentTimetableRevision() !== bookingToSubmit.timetableRevision ||
      dateProblem
    ) {
      invalidatePendingBooking(dateProblem || '可預約日期或時間表已更新，請重新查詢時段。');
      alert(dateProblem || '可預約日期或時間表已更新，請重新查詢時段。');
      await loadDaySchedule();
      return;
    }

    await apiRequest('api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: bookingToSubmit.date,
        slot: bookingToSubmit.slot,
        timetableRevision: bookingToSubmit.timetableRevision
      })
    }, {
      fallbackError: '預約失敗。'
    });
    alert('預約已成功登記！');
    closeBookingModal();
    await Promise.allSettled([loadDaySchedule(), loadPersonalBookings()]);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      adoptBookingWindowFromPayload(error instanceof ApiError ? error.payload : null);
      closeBookingModal();
      const unknown = !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
      alert(unknown
        ? '未能確認預約結果。請先核對「我的預約紀錄」，切勿立即重複提交。'
        : `錯誤: ${errorMessage(error, '預約未獲接納，請重新查詢時段。')}`);
      await Promise.allSettled([loadDaySchedule(), loadPersonalBookings(), loadAdministrativeCancellations()]);
    }
  } finally {
    confirmButton.disabled = false;
    bookingSubmissionInProgress = false;
  }
}

function openCancelModal(bookingId) {
  if (!bookingId) {
    alert('無法識別該預約紀錄。');
    return;
  }
  document.getElementById('cancelBookingId').value = bookingId;
  setModalOpen(cancelModal, true);
}

function closeCancelModal() {
  document.getElementById('cancelBookingId').value = '';
  setModalOpen(cancelModal, false);
}

async function submitCancellation(event) {
  event.preventDefault();
  const bookingId = document.getElementById('cancelBookingId').value;
  const reasonInput = document.getElementById('cancelReason');
  const submitButton = cancellationForm.querySelector('button[type="submit"]');

  if (!bookingId) {
    alert('無法識別該預約紀錄。');
    return;
  }

  submitButton.disabled = true;
  try {
    await apiRequest('api/bookings/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId, reason: reasonInput.value })
    }, {
      fallbackError: '取消預約失敗。'
    });
    alert('預約時段已被釋放！');
    reasonInput.value = '';
    closeCancelModal();
    await Promise.allSettled([loadDaySchedule(), loadPersonalBookings()]);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      alert(`錯誤: ${errorMessage(error, '取消預約失敗。')}`);
    }
  } finally {
    submitButton.disabled = false;
  }
}

async function initialize() {
  showGuestState();
  showGoogleLoginResult();

  loginForm.addEventListener('submit', handleLogin);
  document.getElementById('logoutButton').addEventListener('click', handleLogout);
  refreshScheduleButton.addEventListener('click', loadDaySchedule);
  dateInput.addEventListener('change', handleBookingDateChange);
  document.getElementById('closeBookingModalButton').addEventListener('click', closeBookingModal);
  document.getElementById('confirmBookingButton').addEventListener('click', submitBooking);
  document.getElementById('closeCancelModalButton').addEventListener('click', closeCancelModal);
  cancellationForm.addEventListener('submit', submitCancellation);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeBookingModal();
      closeCancelModal();
    }
  });
  window.addEventListener('focus', queueResumeRefresh);
  window.addEventListener('pageshow', queueResumeRefresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      queueResumeRefresh();
    }
  });
  window.setInterval(() => { void refreshLiveView(); }, 15000);

  try {
    await refreshSystemConfig();
    await verifyLogin({ silentUnauthorized: true });
  } catch (error) {
    markBookingWindowUnavailable();
    alert(errorMessage(error, '無法啟動預約系統。'));
  }
}

void initialize();
