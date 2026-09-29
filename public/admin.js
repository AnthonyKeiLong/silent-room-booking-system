'use strict';

class ApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

let cachedUsers = [];
let cachedUsersRevision = '';
let redirectingToLogin = false;
let selectedStudentCsv = null;
let studentImportInProgress = false;
let accountSaveInProgress = false;
let timetableState = null;
let timetablePreview = null;
let timetableBusy = false;
let timetableDraftDirty = false;
let slotFieldSequence = 0;

const MODE_CODES = ['default', 'exam', 'f6_study'];
const TIMETABLE_REVISION_PATTERN = /^(0|[1-9]\d{0,19})$/;
const SLOT_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

const applicationRootUrl = new URL('.', window.location.href);
const studentCsvTools = window.StudentCsvImport;

const queryDate = document.getElementById('adminQueryDate');
const authLoading = document.getElementById('authLoading');
const adminMain = document.getElementById('adminMain');
const usersListContainer = document.getElementById('usersListContainer');
const cancelLogsTable = document.getElementById('cancelLogsTable');
const adminBookingsTable = document.getElementById('adminBookingsTable');
const calendarModeForm = document.getElementById('calendarModeForm');
const timetableControls = document.getElementById('timetableControls');
const modeSlotEditors = document.getElementById('modeSlotEditors');
const calendarOverridesTable = document.getElementById('calendarOverridesTable');
const timetableStatus = document.getElementById('timetableStatus');
const timetableError = document.getElementById('timetableError');
const reloadTimetableButton = document.getElementById('reloadTimetableButton');
const timetablePreviewPanel = document.getElementById('timetablePreviewPanel');
const timetablePreviewSummary = document.getElementById('timetablePreviewSummary');
const timetablePreviewImpact = document.getElementById('timetablePreviewImpact');
const timetablePreviewExpiry = document.getElementById('timetablePreviewExpiry');
const timetablePreviewWarning = document.getElementById('timetablePreviewWarning');
const timetableAffectedBookings = document.getElementById('timetableAffectedBookings');
const confirmTimetableImpact = document.getElementById('confirmTimetableImpact');
const applyTimetableButton = document.getElementById('applyTimetableButton');
const discardTimetablePreviewButton = document.getElementById('discardTimetablePreviewButton');
const studentCsvPanel = document.getElementById('studentCsvPanel');
const accountEditorControls = document.getElementById('accountEditorControls');
const addUserButton = document.getElementById('addUserButton');
const saveUsersButton = document.getElementById('saveUsersButton');
const studentCsvFile = document.getElementById('studentCsvFile');
const studentCsvStatus = document.getElementById('studentCsvStatus');
const studentCsvError = document.getElementById('studentCsvError');
const importStudentsButton = document.getElementById('importStudentsButton');
const downloadStudentCsvTemplateButton = document.getElementById(
  'downloadStudentCsvTemplateButton'
);

function resolveAppUrl(relativePath = '') {
  return new URL(relativePath, applicationRootUrl);
}

function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
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

function redirectToLogin(message = '登入狀態已失效，正在返回首頁...') {
  if (redirectingToLogin) {
    return;
  }
  redirectingToLogin = true;
  adminMain.classList.add('hidden');
  authLoading.classList.remove('hidden');
  const loadingText = authLoading.querySelector('p');
  if (loadingText) {
    loadingText.textContent = message;
  }
  window.location.replace(resolveAppUrl().href);
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
    redirectToLogin();
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

function addTableMessage(tbody, columnCount, text, className = 'p-4 text-center text-slate-400') {
  const row = document.createElement('tr');
  const cell = createElement('td', className, text);
  cell.colSpan = columnCount;
  row.appendChild(cell);
  tbody.replaceChildren(row);
}

function createCell(className, text) {
  return createElement('td', className, text);
}

function normalizeUser(user) {
  const source = user && typeof user === 'object' ? user : {};
  return {
    email: String(source.email ?? ''),
    password: '',
    name: String(source.name ?? ''),
    class: String(source.class ?? ''),
    role: source.role === 'teacher' ? 'teacher' : 'student',
    isNew: false
  };
}

function formatTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value ?? '');
  }
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

async function verifyTeacherRole() {
  try {
    const data = await apiRequest('api/auth/verify', {}, {
      fallbackError: '無法核對登入狀態。'
    });
    if (!data || typeof data !== 'object' || !data.user || typeof data.user !== 'object') {
      throw new ApiError('伺服器傳回的登入資料格式不正確。');
    }
    if (data.user.isTeacher !== true) {
      alert('權限不足');
      redirectToLogin('權限不足，正在返回首頁...');
      return false;
    }

    authLoading.classList.add('hidden');
    adminMain.classList.remove('hidden');
    return true;
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      alert(errorMessage(error, '無法核對登入狀態。'));
      redirectToLogin('無法核對登入狀態，正在返回首頁...');
    }
    return false;
  }
}

function renderCancellationLogs(cancellations) {
  if (cancellations.length === 0) {
    addTableMessage(cancelLogsTable, 4, '無任何取消歷史紀錄');
    return;
  }

  const rows = cancellations.slice().reverse().map((rawLog) => {
    const log = rawLog && typeof rawLog === 'object' ? rawLog : {};
    const row = createElement('tr', 'hover:bg-slate-50 text-xs');
    row.append(
      createCell('p-3 font-mono text-slate-500', formatTimestamp(log.timestamp)),
      createCell(
        'p-3 font-semibold text-slate-700',
        `${String(log.studentName ?? '')} (${String(log.studentEmail ?? '')})`
      ),
      createCell('p-3', `${String(log.date ?? '')} ${String(log.slot ?? '')}`),
      createCell('p-3 text-red-700 italic font-medium bg-red-50/50', log.reason)
    );
    return row;
  });
  cancelLogsTable.replaceChildren(...rows);
}

async function loadAdminData() {
  try {
    const data = await apiRequest('api/admin/config', {}, {
      fallbackError: '無法載入管理員設定。'
    });
    if (
      !data ||
      typeof data !== 'object' ||
      !Array.isArray(data.users) ||
      !Array.isArray(data.cancellations) ||
      typeof data.usersRevision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.usersRevision)
    ) {
      throw new ApiError('伺服器傳回的管理員設定格式不正確。');
    }

    cachedUsers = data.users.map(normalizeUser);
    cachedUsersRevision = data.usersRevision;
    renderUsersList();
    renderCancellationLogs(data.cancellations);
    return true;
  } catch (error) {
    cachedUsersRevision = '';
    if (error instanceof ApiError && error.status === 401) {
      return false;
    }
    alert(errorMessage(error, '無法載入管理員設定。'));
    usersListContainer.replaceChildren(
      createElement('p', 'p-3 text-xs text-red-600', errorMessage(error, '無法載入帳戶名單。'))
    );
    addTableMessage(
      cancelLogsTable,
      4,
      errorMessage(error, '無法載入取消紀錄。'),
      'p-4 text-center text-red-600'
    );
    return false;
  }
}

function setStudentCsvStatus(message) {
  studentCsvStatus.textContent = message;
}

function setStudentCsvError(message = '') {
  studentCsvError.textContent = message;
  studentCsvError.classList.toggle('hidden', !message);
}

function setAccountEditorBusy(isBusy) {
  accountEditorControls.toggleAttribute('inert', isBusy);
  accountEditorControls.setAttribute('aria-busy', isBusy ? 'true' : 'false');
  addUserButton.disabled = isBusy;
  saveUsersButton.disabled = isBusy;
}

function setStudentCsvControlsBusy(isBusy, makePanelInert = false) {
  studentCsvPanel.toggleAttribute('inert', isBusy && makePanelInert);
  if (isBusy) {
    studentCsvPanel.setAttribute('aria-busy', 'true');
  } else {
    studentCsvPanel.removeAttribute('aria-busy');
  }

  const csvUnavailable = !studentCsvTools;
  studentCsvFile.disabled = isBusy || csvUnavailable;
  downloadStudentCsvTemplateButton.disabled = isBusy || csvUnavailable;
  importStudentsButton.disabled =
    isBusy || csvUnavailable || !selectedStudentCsv;
}

function clearSelectedStudentCsv(clearInput = true) {
  if (selectedStudentCsv) {
    selectedStudentCsv.text = '';
  }
  selectedStudentCsv = null;
  if (clearInput) {
    studentCsvFile.value = '';
  }
  importStudentsButton.disabled = true;
}

async function handleStudentCsvSelection() {
  if (accountSaveInProgress || studentImportInProgress) {
    return;
  }
  clearSelectedStudentCsv(false);
  setStudentCsvError('');

  const file = studentCsvFile.files && studentCsvFile.files[0];
  if (!file) {
    setStudentCsvStatus('尚未選擇 CSV 檔案。');
    return;
  }
  if (!/\.csv$/i.test(file.name)) {
    setStudentCsvStatus('檔案未通過檢查。');
    setStudentCsvError('請選擇副檔名為 .csv 的檔案。');
    studentCsvFile.value = '';
    return;
  }
  if (!studentCsvTools || file.size > studentCsvTools.MAX_CSV_BYTES) {
    setStudentCsvStatus('檔案未通過檢查。');
    setStudentCsvError('CSV 檔案不可超過 512 KiB。');
    studentCsvFile.value = '';
    return;
  }

  setStudentCsvStatus('正在安全檢查 CSV 格式...');
  try {
    const text = await file.text();
    if (!studentCsvFile.files || studentCsvFile.files[0] !== file) {
      return;
    }
    const parsed = studentCsvTools.parseStudentCsv(text);
    selectedStudentCsv = {
      fileName: file.name,
      rowCount: parsed.rowCount,
      teacherCount: parsed.students.filter((account) => account.role === 'teacher').length,
      text
    };
    importStudentsButton.disabled = false;
    setStudentCsvStatus(
      `已檢查 ${file.name}：${parsed.rowCount} 個帳戶，其中 ${selectedStudentCsv.teacherCount} 名教師（具有管理員權限）。可以匯入。`
    );
  } catch (error) {
    selectedStudentCsv = null;
    importStudentsButton.disabled = true;
    setStudentCsvStatus('檔案未通過檢查。');
    setStudentCsvError(
      studentCsvTools && error instanceof studentCsvTools.StudentCsvError
        ? error.message
        : 'CSV 格式無效，請依照範本修正。'
    );
    studentCsvFile.value = '';
  }
}

function downloadStudentCsvTemplate() {
  if (accountSaveInProgress || studentImportInProgress) {
    return;
  }
  if (!studentCsvTools) {
    setStudentCsvError('CSV 功能未能載入，請重新整理頁面。');
    return;
  }
  const blob = new Blob([`\ufeff${studentCsvTools.createTemplate()}\r\n`], {
    type: 'text/csv;charset=utf-8'
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = 'account-import-template.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

const studentImportStorageKey = 'silent-booth-import-2.4.1';
function rememberStudentImport(jobId) {
  try {
    if (jobId) window.sessionStorage.setItem(studentImportStorageKey, jobId);
    else window.sessionStorage.removeItem(studentImportStorageKey);
  } catch { /* Progress still works if session storage is disabled. */ }
}

async function waitForStudentImport(jobId) {
  if (!/^[a-f0-9-]{36}$/.test(jobId || '')) throw new ApiError('匯入工作編號無效。');
  for (;;) {
    const result = await apiRequest(`api/admin/users/import/${encodeURIComponent(jobId)}`, {}, {
      fallbackError: '無法取得匯入進度。請重新整理頁面並核對帳戶名單。'
    });
    if (!result || !['queued', 'hashing', 'saving', 'completed', 'failed', 'unknown'].includes(result.status)) {
      throw new ApiError('伺服器傳回的匯入進度格式不正確。');
    }
    if (['completed', 'failed', 'unknown'].includes(result.status)) {
      rememberStudentImport('');
      if (result.status !== 'completed') throw new ApiError(result.error || '匯入未完成。');
      return result;
    }
    setStudentCsvStatus(result.status === 'saving'
      ? `已處理 ${result.total} 個帳戶，正在一次提交至資料庫，請稍候…`
      : `正在背景處理密碼：${result.processed} / ${result.total}。大量名單可能需要數分鐘。`);
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
  }
}

async function runStudentImportFlow(existingJobId = '') {
  studentImportInProgress = true;
  setAccountEditorBusy(true);
  setStudentCsvControlsBusy(true);
  setStudentCsvError('');
  setStudentCsvStatus(existingJobId ? '正在恢復匯入進度…' : '正在提交 CSV，請稍候…');
  try {
    let jobId = existingJobId;
    if (!jobId) {
      const accepted = await apiRequest('api/admin/users/import', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv; charset=utf-8' },
        body: selectedStudentCsv.text
      }, { fallbackError: '未能確認匯入是否已開始；請先核對帳戶名單。' });
      jobId = accepted && accepted.jobId;
      if (!/^[a-f0-9-]{36}$/.test(jobId || '')) throw new ApiError('伺服器未傳回有效的匯入工作編號。');
      rememberStudentImport(jobId);
      clearSelectedStudentCsv();
    }
    const result = await waitForStudentImport(jobId);
    const createdCount = Number(result.createdCount);
    if (!Number.isInteger(createdCount) || createdCount < 1) throw new ApiError('匯入結果格式不正確。');
    setStudentCsvStatus(`匯入完成：已建立 ${createdCount} 個帳戶；現有帳戶沒有被修改。請安全處理原始密碼 CSV。`);
    await loadAdminData();
  } catch (error) {
    setStudentCsvStatus('請核對匯入結果。');
    if (!(error instanceof ApiError && error.status === 401)) {
      setStudentCsvError(errorMessage(error, '無法確認匯入結果。') +
        ' 如連線中斷，背景工作可能仍在執行；請重新整理以恢復進度，並核對帳戶名單後再決定是否重試。');
    }
    if (error instanceof ApiError && error.status === 404) rememberStudentImport('');
    await loadAdminData();
  } finally {
    clearSelectedStudentCsv();
    studentImportInProgress = false;
    setStudentCsvControlsBusy(false);
    setAccountEditorBusy(false);
    studentCsvStatus.focus();
  }
}

async function importStudentsFromCsv() {
  if (!selectedStudentCsv || studentImportInProgress || accountSaveInProgress) return;
  if (!confirm(
    `確定從 ${selectedStudentCsv.fileName} 建立 ${selectedStudentCsv.rowCount} 個帳戶嗎？其中 ${selectedStudentCsv.teacherCount} 名教師將具有管理員權限。\n\n` +
    '整批完成後一次儲存；如有電郵已存在，整次取消。大量名單可能需要數分鐘。'
  )) return;
  await runStudentImportFlow();
}

async function resumeStudentImport() {
  let jobId;
  try { jobId = window.sessionStorage.getItem(studentImportStorageKey); } catch { return; }
  if (jobId) await runStudentImportFlow(jobId);
}

function createField(labelText, inputType, value, onChange, options = {}) {
  const wrapper = document.createElement('div');
  const label = createElement(
    'label',
    'block text-[10px] text-slate-400 font-bold uppercase',
    labelText
  );
  const input = document.createElement('input');
  input.type = inputType;
  input.value = value;
  input.className = 'w-full border border-slate-300 rounded p-1';
  if (options.placeholder) {
    input.placeholder = options.placeholder;
  }
  if (options.autocomplete) {
    input.autocomplete = options.autocomplete;
  }
  if (options.required) {
    input.required = true;
  }
  if (options.minLength) {
    input.minLength = options.minLength;
  }
  if (options.readOnly) {
    input.readOnly = true;
    input.className += ' bg-slate-100 text-slate-500 cursor-not-allowed';
  } else {
    input.addEventListener('change', () => onChange(input.value));
  }
  wrapper.append(label, input);
  return wrapper;
}

function renderUsersList() {
  if (cachedUsers.length === 0) {
    usersListContainer.replaceChildren(
      createElement('p', 'p-3 text-xs text-slate-400', '目前沒有使用者帳戶。')
    );
    return;
  }

  const cards = cachedUsers.map((user, index) => {
    const card = createElement(
      'div',
      'p-3 bg-white border border-slate-200 rounded shadow-sm space-y-2 relative'
    );
    const removeButton = createElement(
      'button',
      'absolute top-2 right-2 text-red-500 hover:text-red-700 text-xs font-bold',
      '刪除'
    );
    removeButton.type = 'button';
    removeButton.addEventListener('click', () => removeUser(index));

    const grid = createElement('div', 'grid grid-cols-2 gap-2 text-xs');
    grid.append(
      createField(
        user.isNew ? '電子郵件' : '電子郵件（不可更改）',
        'email',
        user.email,
        (value) => updateUserField(index, 'email', value),
        { readOnly: !user.isNew, autocomplete: 'email' }
      ),
      createField(
        user.isNew
          ? '密碼（新帳戶必填，最少 10 個字元）'
          : '新密碼（留空代表不更改）',
        'password',
        '',
        (value) => updateUserField(index, 'password', value),
        {
          placeholder: '最少 10 個字元',
          autocomplete: 'new-password',
          required: user.isNew,
          minLength: 10
        }
      ),
      createField('顯示姓名', 'text', user.name, (value) => updateUserField(index, 'name', value)),
      createField('班別 (Staff / 學號)', 'text', user.class, (value) => updateUserField(index, 'class', value))
    );

    const roleWrapper = document.createElement('div');
    const roleLabel = createElement(
      'label',
      'block text-[10px] text-slate-400 font-bold uppercase',
      '身分角色權限'
    );
    const roleSelect = createElement('select', 'w-full border border-slate-300 rounded p-1 text-xs');
    const studentOption = createElement('option', '', '學生 (Student)');
    studentOption.value = 'student';
    const teacherOption = createElement('option', '', '教職員 (Teacher)');
    teacherOption.value = 'teacher';
    roleSelect.append(studentOption, teacherOption);
    roleSelect.value = user.role;
    roleSelect.addEventListener('change', () => updateUserField(index, 'role', roleSelect.value));
    roleWrapper.append(roleLabel, roleSelect);

    card.append(removeButton, grid, roleWrapper);
    return card;
  });
  usersListContainer.replaceChildren(...cards);
}

function updateUserField(index, field, value) {
  if (studentImportInProgress || accountSaveInProgress || !cachedUsers[index]) {
    return;
  }
  cachedUsers[index][field] = value;
}

function addNewUserField() {
  if (studentImportInProgress || accountSaveInProgress) {
    return;
  }
  cachedUsers.push({
    email: '',
    password: '',
    name: '新使用者',
    class: '1E 01',
    role: 'student',
    isNew: true
  });
  renderUsersList();
  usersListContainer.scrollTop = usersListContainer.scrollHeight;
}

function removeUser(index) {
  if (studentImportInProgress || accountSaveInProgress) {
    return;
  }
  const user = cachedUsers[index];
  if (!user) {
    return;
  }
  if (confirm(`確定刪除此帳戶(${user.email || '空白帳戶'})嗎？`)) {
    cachedUsers.splice(index, 1);
    renderUsersList();
  }
}

async function saveUsers() {
  if (studentImportInProgress || accountSaveInProgress) {
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(cachedUsersRevision)) {
    alert('帳戶名單版本無效，正在重新載入。');
    await loadAdminData();
    return;
  }

  const invalidNewUser = cachedUsers.find(
    (user) => user.isNew && user.password.length < 10
  );
  if (invalidNewUser) {
    alert(`新使用者必須設定最少 10 個字元的密碼：${invalidNewUser.email || '(沒有電郵地址)'}`);
    return;
  }

  accountSaveInProgress = true;
  setAccountEditorBusy(true);
  setStudentCsvControlsBusy(true, true);
  try {
    const submittedUsers = cachedUsers.map((user) => ({
      email: user.email,
      password: user.password,
      name: user.name,
      class: user.class,
      role: user.role
    }));
    await apiRequest('api/admin/config/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        users: submittedUsers,
        usersRevision: cachedUsersRevision
      })
    }, {
      fallbackError: '儲存帳戶設定失敗，請確認資料格式。'
    });
    alert('使用者帳戶變更已成功同步至資料庫！');
    await loadAdminData();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      if (error instanceof ApiError && error.status === 0) {
        alert('連線中斷，未能確認帳戶變更是否已儲存。系統會重新載入帳戶名單；請先核對結果，切勿立即重試。');
        await loadAdminData();
      } else {
        alert(errorMessage(error, '儲存帳戶設定失敗，請確認資料格式。'));
        if (error instanceof ApiError && error.status === 409) {
          await loadAdminData();
        }
      }
    }
  } finally {
    accountSaveInProgress = false;
    setStudentCsvControlsBusy(false, true);
    setAccountEditorBusy(false);
  }
}

function setTimetableError(message = '') {
  timetableError.textContent = message;
  timetableError.classList.toggle('hidden', !message);
}

function updateTimetableControls() {
  const reviewOpen = timetablePreview !== null;
  timetableControls.disabled = timetableBusy || reviewOpen || !timetableState;
  timetableControls.setAttribute('aria-busy', timetableBusy ? 'true' : 'false');
  reloadTimetableButton.disabled = timetableBusy || reviewOpen;
  confirmTimetableImpact.disabled = timetableBusy || !reviewOpen;
  discardTimetablePreviewButton.disabled = timetableBusy;
  applyTimetableButton.disabled = timetableBusy || !reviewOpen || !confirmTimetableImpact.checked;
}

function clearTimetablePreview() {
  timetablePreview = null;
  confirmTimetableImpact.checked = false;
  timetablePreviewPanel.classList.add('hidden');
  timetableAffectedBookings.replaceChildren();
  updateTimetableControls();
}

function normalizeTimetable(data) {
  if (
    !data || typeof data !== 'object' ||
    typeof data.revision !== 'string' || !TIMETABLE_REVISION_PATTERN.test(data.revision) ||
    !data.modes || typeof data.modes !== 'object' || Array.isArray(data.modes) ||
    !data.calendar || typeof data.calendar !== 'object' || Array.isArray(data.calendar) ||
    !data.bookingWindow || !isValidDateString(data.bookingWindow.schoolDate)
  ) {
    throw new ApiError('伺服器傳回的時間表格式不正確，請重新載入。');
  }
  for (const code of MODE_CODES) {
    const mode = data.modes[code];
    if (
      !mode || typeof mode.name !== 'string' || !Array.isArray(mode.slots) ||
      mode.slots.some((slot) => typeof slot !== 'string' || !SLOT_PATTERN.test(slot))
    ) {
      throw new ApiError('伺服器傳回的模式時段格式不正確。');
    }
  }
  for (const [date, code] of Object.entries(data.calendar)) {
    if (!isValidDateString(date) || !MODE_CODES.includes(code)) {
      throw new ApiError('伺服器傳回的特殊日期格式不正確。');
    }
  }
  return data;
}

function markTimetableDraftDirty() {
  timetableDraftDirty = true;
}

function createSlotTimeField(labelText, value) {
  const wrapper = createElement('div', 'flex-1 min-w-0');
  const id = `slot-time-${++slotFieldSequence}`;
  const label = createElement('label', 'block text-xs font-semibold text-slate-600 mb-1', labelText);
  label.htmlFor = id;
  const input = document.createElement('input');
  input.id = id;
  input.type = 'time';
  input.step = '60';
  input.required = true;
  input.value = value;
  input.className = 'w-full border border-slate-300 rounded p-2 text-sm';
  wrapper.append(label, input);
  return wrapper;
}

function appendModeSlotRow(container, slot = '') {
  const [start = '', end = ''] = slot.split('-');
  const row = createElement('div', 'flex items-end gap-2');
  row.dataset.slotRow = 'true';
  const removeButton = createElement('button', 'rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 hover:bg-red-100', '移除');
  removeButton.type = 'button';
  removeButton.setAttribute('aria-label', '移除此時段');
  removeButton.addEventListener('click', () => {
    if (timetableBusy || timetablePreview) {
      return;
    }
    row.remove();
    markTimetableDraftDirty();
    const remaining = container.querySelector('input');
    if (remaining) {
      remaining.focus();
    } else {
      container.parentElement.querySelector('[data-add-slot]').focus();
    }
  });
  row.append(createSlotTimeField('開始時間', start), createSlotTimeField('結束時間', end), removeButton);
  container.appendChild(row);
  return row;
}

function modeSlotsFromForm(form) {
  const rows = Array.from(form.querySelectorAll('[data-slot-row]'));
  if (rows.length === 0) {
    throw new ApiError('每個模式最少需要一個開放時段。');
  }
  if (rows.length > 24) {
    throw new ApiError('每個模式最多可設定 24 個時段。');
  }
  const slots = rows.map((row) => {
    const inputs = row.querySelectorAll('input[type="time"]');
    const start = inputs[0].value;
    const end = inputs[1].value;
    if (!SLOT_PATTERN.test(`${start}-${end}`) || start >= end) {
      inputs[1].focus();
      throw new ApiError('每個時段的結束時間必須晚於開始時間，且不可跨越午夜。');
    }
    return `${start}-${end}`;
  }).sort();
  for (let index = 1; index < slots.length; index += 1) {
    if (slots[index].slice(0, 5) < slots[index - 1].slice(6)) {
      throw new ApiError('開放時段不可重疊，請修正後再預覽。');
    }
  }
  return slots;
}

function renderModeSlotEditors() {
  const editors = MODE_CODES.map((code) => {
    const mode = timetableState.modes[code];
    const form = createElement('form', 'rounded border border-slate-200 bg-slate-50 p-4 space-y-3');
    form.dataset.modeCode = code;
    const heading = createElement('h4', 'text-sm font-bold text-blue-900', mode.name);
    heading.id = `mode-editor-title-${code}`;
    form.setAttribute('aria-labelledby', heading.id);
    const rows = createElement('div', 'space-y-2');
    mode.slots.forEach((slot) => appendModeSlotRow(rows, slot));
    const buttons = createElement('div', 'flex flex-col sm:flex-row gap-2');
    const addButton = createElement('button', 'rounded border border-blue-300 bg-white px-3 py-2 text-xs font-semibold text-blue-800 hover:bg-blue-50', '+ 新增時段');
    addButton.type = 'button';
    addButton.dataset.addSlot = 'true';
    addButton.addEventListener('click', () => {
      if (timetableBusy || timetablePreview) {
        return;
      }
      if (rows.querySelectorAll('[data-slot-row]').length >= 24) {
        setTimetableError('每個模式最多可設定 24 個時段。');
        return;
      }
      appendModeSlotRow(rows).querySelector('input').focus();
      markTimetableDraftDirty();
    });
    const previewButton = createElement('button', 'rounded bg-blue-700 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-800', '預覽時段變更影響');
    previewButton.type = 'submit';
    buttons.append(addButton, previewButton);
    form.append(heading, rows, buttons);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form.reportValidity()) {
        return;
      }
      try {
        const slots = modeSlotsFromForm(form);
        void requestTimetablePreview({ type: 'replace_mode_slots', modeCode: code, slots });
      } catch (error) {
        setTimetableError(errorMessage(error, '請檢查開放時段。'));
      }
    });
    return form;
  });
  modeSlotEditors.replaceChildren(...editors);
}

function renderCalendarOverrides() {
  const targetMode = document.getElementById('targetMode');
  targetMode.replaceChildren(...MODE_CODES.map((code) => {
    const label = code === 'default'
      ? `恢復正常時間表（清除特殊日期設定）— ${timetableState.modes[code].name}`
      : timetableState.modes[code].name;
    const option = createElement('option', '', label);
    option.value = code;
    return option;
  }));
  const overrides = Object.entries(timetableState.calendar)
    .filter(([, code]) => code !== 'default')
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB));
  if (overrides.length === 0) {
    addTableMessage(calendarOverridesTable, 2, '沒有特殊日期；所有日期使用正常時間表。', 'p-3 text-slate-500');
    return;
  }
  calendarOverridesTable.replaceChildren(...overrides.map(([date, code]) => {
    const row = document.createElement('tr');
    row.append(createCell('p-2 border-t border-slate-100', date), createCell('p-2 border-t border-slate-100', timetableState.modes[code].name));
    return row;
  }));
}

async function loadTimetable() {
  try {
    const data = await apiRequest('api/admin/timetable', {}, { fallbackError: '無法載入時間表。' });
    timetableState = normalizeTimetable(data);
    clearTimetablePreview();
    renderModeSlotEditors();
    renderCalendarOverrides();
    timetableDraftDirty = false;
    if (!queryDate.value) {
      queryDate.value = timetableState.bookingWindow.schoolDate;
    }
    if (!document.getElementById('startDate').value) {
      document.getElementById('startDate').value = timetableState.bookingWindow.schoolDate;
    }
    timetableStatus.textContent = `時間表版本 ${timetableState.revision} 已載入。變更必須先預覽再確認；預覽本身不會修改預約。`;
    return true;
  } catch (error) {
    timetableState = null;
    clearTimetablePreview();
    if (!(error instanceof ApiError && error.status === 401)) {
      setTimetableError(errorMessage(error, '無法載入時間表。'));
    }
    timetableStatus.textContent = '無法核對時間表，編輯已暫停。請按「重新載入時間表」。';
    return false;
  } finally {
    updateTimetableControls();
  }
}

async function reloadTimetable() {
  if (timetableBusy || timetablePreview) {
    return;
  }
  if (timetableDraftDirty && !confirm('重新載入會清除尚未套用的時間表編輯。繼續嗎？')) {
    return;
  }
  timetableBusy = true;
  setTimetableError('');
  updateTimetableControls();
  try {
    await loadTimetable();
  } finally {
    timetableBusy = false;
    updateTimetableControls();
  }
}

function describeTimetableChange(change) {
  const modeName = timetableState.modes[change.modeCode].name;
  if (change.type === 'replace_mode_slots') {
    return `更新「${modeName}」：${change.slots.join('、')}。`;
  }
  const dates = change.startDate === change.endDate
    ? change.startDate : `${change.startDate} 至 ${change.endDate}`;
  return change.modeCode === 'default'
    ? `${dates}：清除特殊日期設定，恢復「${modeName}」。`
    : `${dates}：使用「${modeName}」。`;
}

function validateTimetablePreview(data) {
  if (
    !data || typeof data !== 'object' || typeof data.previewId !== 'string' || !data.previewId ||
    data.revision !== timetableState.revision ||
    !Number.isInteger(data.affectedCount) || data.affectedCount < 0 ||
    !Number.isInteger(data.affectedStudentCount) || data.affectedStudentCount < 0 ||
    !Array.isArray(data.affectedBookings) || data.affectedBookings.length !== data.affectedCount ||
    typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))
  ) {
    throw new ApiError('預覽結果格式不正確，未有套用任何變更。請重新預覽。');
  }
  for (const booking of data.affectedBookings) {
    if (!booking || !isValidDateString(booking.date) || typeof booking.slot !== 'string' ||
        typeof booking.studentEmail !== 'string' || typeof booking.studentName !== 'string') {
      throw new ApiError('受影響名單格式不正確，請重新預覽。');
    }
  }
  return data;
}

function renderTimetablePreview(change, preview) {
  timetablePreview = preview;
  timetablePreviewSummary.textContent = describeTimetableChange(change);
  timetablePreviewImpact.textContent = preview.affectedCount === 0
    ? '沒有現有預約需要取消。確認後只會更新時間表設定。'
    : `套用後將取消 ${preview.affectedCount} 個預約，涉及 ${preview.affectedStudentCount} 名學生。學生不會被計算取消次數或受到處罰。`;
  const expiry = new Date(preview.expiresAt).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false });
  timetablePreviewExpiry.textContent = `預覽有效至 ${expiry}（香港時間）；如時間表或受影響預約有變，需重新預覽。`;
  timetablePreviewWarning.textContent = '本次不會寄出電郵。受影響學生需在預約頁面查看取消通知；如有需要，請老師另外通知學生。套用後將重新載入全部時間表，其他尚未套用的編輯不會儲存。';
  if (preview.affectedCount === 0) {
    addTableMessage(timetableAffectedBookings, 4, '沒有需要取消的預約。', 'p-3 text-slate-600');
  } else {
    timetableAffectedBookings.replaceChildren(...preview.affectedBookings.map((booking) => {
      const row = document.createElement('tr');
      row.append(createCell('p-2 border-t border-slate-100', booking.date), createCell('p-2 border-t border-slate-100', booking.slot), createCell('p-2 border-t border-slate-100', booking.studentName), createCell('p-2 border-t border-slate-100 break-all', booking.studentEmail));
      return row;
    }));
  }
  confirmTimetableImpact.checked = false;
  timetablePreviewPanel.classList.remove('hidden');
  document.getElementById('timetablePreviewTitle').focus();
  updateTimetableControls();
}

async function requestTimetablePreview(change) {
  if (timetableBusy || timetablePreview || !timetableState) {
    return;
  }
  timetableBusy = true;
  setTimetableError('');
  timetableStatus.textContent = '正在核對變更及受影響預約；尚未套用任何變更。';
  updateTimetableControls();
  try {
    const data = await apiRequest('api/admin/timetable/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: timetableState.revision, change })
    }, { fallbackError: '無法預覽時間表變更。' });
    renderTimetablePreview(change, validateTimetablePreview(data));
    timetableStatus.textContent = '預覽已完成，尚未修改資料庫。請核對下方內容並明確確認，或返回編輯。';
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      const stale = error instanceof ApiError && error.payload && ['TIMETABLE_STALE', 'PREVIEW_STALE', 'PREVIEW_EXPIRED'].includes(error.payload.code);
      if (stale) {
        const reloaded = await loadTimetable();
        setTimetableError(reloaded
          ? '時間表已被更新，已重新載入。請核對最新內容，重新編輯並預覽。'
          : '時間表已被更新，但未能重新載入。編輯已暫停；請重新載入後再編輯及預覽。');
      } else {
        timetableStatus.textContent = '未能取得可套用的預覽；尚未提出套用要求。';
        setTimetableError(errorMessage(error, '無法預覽時間表變更。'));
      }
    }
  } finally {
    timetableBusy = false;
    updateTimetableControls();
  }
}

function updateCalendarMode(event) {
  event.preventDefault();
  if (!calendarModeForm.reportValidity()) {
    return;
  }
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value || startDate;
  const modeCode = document.getElementById('targetMode').value;
  if (!isValidDateString(startDate) || !isValidDateString(endDate) || startDate > endDate) {
    setTimetableError('請輸入有效日期，結束日期不可早於開始日期。');
    return;
  }
  void requestTimetablePreview({ type: 'set_calendar_range', startDate, endDate, modeCode });
}

async function applyTimetablePreview() {
  if (timetableBusy || !timetablePreview || !confirmTimetableImpact.checked) {
    return;
  }
  const previewId = timetablePreview.previewId;
  timetableBusy = true;
  setTimetableError('');
  timetableStatus.textContent = '正在套用時間表及處理受影響預約。請勿重複提交或關閉頁面。';
  updateTimetableControls();
  try {
    const result = await apiRequest('api/admin/timetable/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewId, confirmAffectedBookings: true })
    }, { fallbackError: '未能確認時間表套用結果。' });
    if (!result || result.success !== true || !Number.isInteger(result.cancelledCount) || result.cancelledCount < 0) {
      throw new ApiError('未能確認伺服器傳回的套用結果。');
    }
    clearTimetablePreview();
    const loaded = await loadTimetable();
    timetableStatus.textContent = `時間表已同步至資料庫；${result.cancelledCount} 個預約已因時間表變更而取消，學生沒有任何處罰。未寄出電郵，學生可在預約頁面查看通知。${loaded ? '' : ' 最新時間表未能重新載入，請先重新載入再操作。'}`;
    await loadAdminBookings();
  } catch (error) {
    clearTimetablePreview();
    if (!(error instanceof ApiError && error.status === 401)) {
      const code = error instanceof ApiError && error.payload ? error.payload.code : '';
      const stale = ['TIMETABLE_STALE', 'PREVIEW_STALE', 'PREVIEW_EXPIRED'].includes(code);
      const unknown = !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
      await loadTimetable();
      await loadAdminBookings();
      if (unknown) {
        setTimetableError('連線或伺服器回覆有問題，未能確認變更是否已完成。請勿立即重試；時間表與預約名單已嘗試重新載入，請先核對資料，必要時聯絡管理員。');
        timetableStatus.textContent = '套用結果未能確認；不能假設沒有預約被取消。請先核對最新時間表及預約名單。';
      } else if (stale) {
        setTimetableError('預覽已過期，或時間表／受影響預約已改變。請重新核對最新資料並再次預覽；不可使用舊預覽套用。');
      } else {
        setTimetableError(errorMessage(error, '時間表變更未獲接納，請核對資料後重新預覽。'));
      }
    }
  } finally {
    timetableBusy = false;
    updateTimetableControls();
    timetableStatus.focus();
  }
}

function discardTimetablePreview() {
  if (timetableBusy) {
    return;
  }
  clearTimetablePreview();
  setTimetableError('');
  timetableStatus.textContent = '已返回編輯；沒有提出套用要求。編輯後請重新預覽。';
  timetableStatus.focus();
}

function renderAdminBooking(booking) {
  const source = booking && typeof booking === 'object' ? booking : {};
  const row = createElement('tr', 'hover:bg-slate-50');
  const actions = createElement('td', 'p-3 text-right');
  const cancelButton = createElement(
    'button',
    'bg-red-50 hover:bg-red-100 text-red-600 text-xs px-2.5 py-1.5 rounded border border-red-200 transition',
    '強制取消 / 釋放'
  );
  cancelButton.type = 'button';
  cancelButton.addEventListener('click', () => cancelBooking(String(source.id ?? '')));
  actions.appendChild(cancelButton);
  row.append(
    createCell('p-3 font-semibold text-slate-700', source.slot),
    createCell('p-3', source.studentClass),
    createCell('p-3', source.studentName),
    createCell('p-3 text-xs text-slate-500 font-mono', source.studentEmail),
    actions
  );
  return row;
}

async function loadAdminBookings() {
  const dateVal = queryDate.value;
  if (!dateVal) {
    return;
  }
  addTableMessage(adminBookingsTable, 5, '載入預約時程中...');

  try {
    const bookings = await apiRequest(`api/bookings?date=${encodeURIComponent(dateVal)}`, {}, {
      fallbackError: '無法載入當日預約。'
    });
    if (!Array.isArray(bookings)) {
      throw new ApiError('伺服器傳回的預約資料格式不正確。');
    }
    if (queryDate.value !== dateVal) {
      return;
    }

    if (bookings.length === 0) {
      addTableMessage(adminBookingsTable, 5, '當日目前沒有任何預約時段', 'p-6 text-center text-slate-400');
      return;
    }
    adminBookingsTable.replaceChildren(...bookings.map(renderAdminBooking));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return;
    }
    addTableMessage(
      adminBookingsTable,
      5,
      errorMessage(error, '無法載入當日預約。'),
      'p-6 text-center text-red-600'
    );
  }
}

async function cancelBooking(id) {
  if (!id) {
    alert('無法識別該預約紀錄。');
    return;
  }
  if (!confirm('確定要強制取消此時段預約嗎？這將直接釋放時段，不累算至學生的取消禁令次數。')) {
    return;
  }

  try {
    await apiRequest('api/bookings/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId: id })
    }, {
      fallbackError: '取消操作失敗。'
    });
    alert('時段已被強制取消與釋放！');
    await loadAdminBookings();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      alert(errorMessage(error, '取消操作失敗。'));
    }
  }
}

async function initialize() {
  addUserButton.addEventListener('click', addNewUserField);
  saveUsersButton.addEventListener('click', saveUsers);
  studentCsvFile.addEventListener('change', handleStudentCsvSelection);
  importStudentsButton.addEventListener('click', importStudentsFromCsv);
  downloadStudentCsvTemplateButton.addEventListener('click', downloadStudentCsvTemplate);
  calendarModeForm.addEventListener('submit', updateCalendarMode);
  timetableControls.addEventListener('input', markTimetableDraftDirty);
  timetableControls.addEventListener('change', markTimetableDraftDirty);
  reloadTimetableButton.addEventListener('click', reloadTimetable);
  confirmTimetableImpact.addEventListener('change', updateTimetableControls);
  applyTimetableButton.addEventListener('click', applyTimetablePreview);
  discardTimetablePreviewButton.addEventListener('click', discardTimetablePreview);
  queryDate.addEventListener('change', loadAdminBookings);

  const authorized = await verifyTeacherRole();
  if (!authorized) {
    return;
  }
  if (!studentCsvTools) {
    studentCsvFile.disabled = true;
    importStudentsButton.disabled = true;
    downloadStudentCsvTemplateButton.disabled = true;
    setStudentCsvError('CSV 匯入功能未能載入，請重新整理頁面或聯絡管理員。');
  }
  await Promise.allSettled([
    loadAdminData(),
    loadTimetable().then((loaded) => loaded ? loadAdminBookings() : undefined)
  ]);
  await resumeStudentImport();
}

void initialize();
