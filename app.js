'use strict';

// 各項目專屬的淡色系（用 name 的 hash 決定，穩定不變）
const BAR_PALETTE = [
  '#bfdbfe', // sky-200
  '#ddd6fe', // violet-200
  '#fde68a', // amber-200
  '#bbf7d0', // green-200
  '#fbcfe8', // pink-200
  '#a5f3fc', // cyan-200
  '#fed7aa', // orange-200
  '#e9d5ff', // purple-200
  '#fecaca', // rose-200
  '#c7d2fe', // indigo-200
  '#d9f99d', // lime-200
  '#99f6e4', // teal-200
];
function colorForName(name) {
  if (!name) return BAR_PALETTE[0];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return BAR_PALETTE[Math.abs(h) % BAR_PALETTE.length];
}

/* =====================================================================
 * Bill Tracker — main app
 * Storage: GitHub Gist (token + gistId in localStorage; bills.json in Gist)
 * ===================================================================== */

const LS_TOKEN = 'bt_token';
const LS_GIST_ID = 'bt_gist_id';
const GIST_FILE = 'bills.json';
const SCHEMA_VERSION = 1;
const DEBOUNCE_MS = 500;

let state = {
  bills: [],
  selection: new Set(),
  filter: { unpaid: false, search: '' },
  selectionMode: false,
  syncing: false,
  lastError: null,
  ganttRangeStart: null,
  ganttRangeEnd: null,
  ganttZoom: 'week',
  ganttPxScale: 1,
  editingId: null,
  showOld: false, // 是否顯示已收合的舊帳單（預設收合）
};

const OLD_THRESHOLD_DAYS = 60;
function isOldBill(b) {
  const e = parseDate(b.endDate);
  if (!e) return false;
  return daysBetween(e, todayDate()) > OLD_THRESHOLD_DAYS;
}
function visibleBills() {
  return state.bills.filter(b => state.showOld || !isOldBill(b));
}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);

// ---------- Helpers ----------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function nowIso() { return new Date().toISOString(); }
function parseDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function fmtDate(d) {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayDate() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}
const CURRENCY = '$';
function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return '';
  const sign = n < 0 ? '-' : '';
  return sign + Math.abs(n).toLocaleString('zh-Hant', { maximumFractionDigits: 2 });
}
function fmtCurrency(n) {
  if (n === null || n === undefined || isNaN(n)) return '';
  return CURRENCY + fmtMoney(n);
}
function parseMoney(s) {
  if (s === '' || s === null || s === undefined) return null;
  const n = parseFloat(String(s).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ---------- Bill status ----------
function billStatus(b) {
  if (b.paid) return 'paid';
  if (!b.dueDate) return 'unpaid';
  const due = parseDate(b.dueDate);
  if (!due) return 'unpaid';
  const t = todayDate();
  if (due < t) return 'overdue';
  const diff = daysBetween(t, due);
  if (diff <= 3) return 'due-soon';
  return 'unpaid';
}
function billTotal(b) {
  return (b.amount || 0) + (b.fee || 0);
}
function billDays(b) {
  const s = parseDate(b.startDate);
  const e = parseDate(b.endDate);
  if (!s || !e) return 0;
  return daysBetween(s, e) + 1;
}

// ---------- Toast ----------
function toast(msg, type = 'default', opts = {}) {
  const container = $('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const content = document.createElement('span');
  content.textContent = msg;
  t.appendChild(content);
  if (opts.action) {
    const btn = document.createElement('button');
    btn.textContent = opts.action.label;
    btn.onclick = () => {
      opts.action.fn();
      removeToast(t);
    };
    t.appendChild(btn);
  }
  container.appendChild(t);
  const timer = setTimeout(() => removeToast(t), opts.duration ?? 3000);
  t._timer = timer;
  return t;
}
function removeToast(t) {
  clearTimeout(t._timer);
  t.classList.add('out');
  setTimeout(() => t.remove(), 220);
}

// ---------- Gist API ----------
const API = 'https://api.github.com';

async function ghFetch(path, init = {}) {
  const token = localStorage.getItem(LS_TOKEN);
  if (!token) throw makeError('NO_TOKEN', '尚未連接 GitHub');
  const res = await fetch(API + path, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch {}
    const code =
      res.status === 401 ? 'INVALID_TOKEN' :
      res.status === 403 ? 'FORBIDDEN' :
      res.status === 404 ? 'NOT_FOUND' :
      'HTTP_ERROR';
    const msg =
      code === 'INVALID_TOKEN' ? 'token 無效或已撤銷' :
      code === 'FORBIDDEN' ? 'token 缺少 gist 權限或被拒絕' :
      code === 'NOT_FOUND' ? '找不到該 Gist' :
      (body?.message || `HTTP ${res.status}`);
    throw makeError(code, msg, res.status);
  }
  return res.json();
}
function makeError(code, msg, status) {
  const e = new Error(msg);
  e.code = code;
  e.status = status;
  return e;
}

async function createGist(initialBills = []) {
  const data = await ghFetch('/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: 'Bill Tracker data',
      public: false,
      files: {
        [GIST_FILE]: { content: JSON.stringify(makeGistContent(initialBills), null, 2) },
      },
    }),
  });
  return data.id;
}
async function loadGist(gistId) {
  const data = await ghFetch(`/gists/${gistId}`);
  const file = data.files?.[GIST_FILE];
  if (!file) throw makeError('NO_FILE', 'Gist 內找不到 bills.json，請確認 Gist 是否正確');
  let content = file.content;
  if (file.truncated && file.raw_url) {
    const r = await fetch(file.raw_url);
    content = await r.text();
  }
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) return parsed;
    if (parsed?.bills && Array.isArray(parsed.bills)) return parsed.bills;
    return [];
  } catch {
    return [];
  }
}
async function saveGist(gistId, bills) {
  await ghFetch(`/gists/${gistId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      files: {
        [GIST_FILE]: { content: JSON.stringify(makeGistContent(bills), null, 2) },
      },
    }),
  });
}
function makeGistContent(bills) {
  return { version: SCHEMA_VERSION, updatedAt: nowIso(), bills };
}

// ---------- Sync ----------
let saveTimer = null;
let pendingSave = false;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  pendingSave = true;
  saveTimer = setTimeout(() => { saveTimer = null; doSave(); }, DEBOUNCE_MS);
  setSyncStatus('syncing');
}
// Flush pending save before page hides / unloads (防資料遺失)
function flushPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    doSave();
  }
}
async function doSave() {
  const gistId = localStorage.getItem(LS_GIST_ID);
  if (!gistId) return;
  state.syncing = true;
  setSyncStatus('syncing');
  try {
    await saveGist(gistId, state.bills);
    state.syncing = false;
    state.lastError = null;
    pendingSave = false;
    setSyncStatus('ok');
  } catch (err) {
    state.syncing = false;
    state.lastError = err;
    setSyncStatus('error');
    toast(`同步失敗：${err.message}`, 'error', {
      duration: 5000,
      action: { label: '重試', fn: doSave },
    });
  }
}

function setSyncStatus(s) {
  const el = $('sync-indicator');
  el.classList.remove('syncing', 'error', 'offline');
  const txt = el.querySelector('.sync-text');
  if (s === 'syncing') { el.classList.add('syncing'); txt.textContent = '同步中…'; }
  else if (s === 'error') { el.classList.add('error'); txt.textContent = '同步失敗'; }
  else if (s === 'offline') { el.classList.add('offline'); txt.textContent = '離線'; }
  else if (s === 'no-token') { el.classList.add('offline'); txt.textContent = '未連線'; }
  else { txt.textContent = '已同步'; }
}

// ---------- Setup flow ----------
function openSetup(forceReason) {
  $('setup-overlay').classList.add('open');
  $('setup-panel-input').hidden = false;
  $('setup-panel-success').hidden = true;
  $('setup-cancel').hidden = !localStorage.getItem(LS_TOKEN);
  if (forceReason) $('setup-err').textContent = forceReason;
  $('setup-token').value = '';
  $('setup-gist-id').value = '';
}
function closeSetup() {
  $('setup-overlay').classList.remove('open');
  $('setup-err').textContent = '';
}
function showSetupSuccess(gistId, mode, billCount) {
  $('setup-panel-input').hidden = true;
  $('setup-panel-success').hidden = false;
  $('setup-success-id').value = gistId;
  $('setup-success-msg').textContent = mode === 'new'
    ? '已建立新的 private Gist。'
    : `已連接，載入 ${billCount} 筆帳單。`;
}
function bindSetup() {
  document.querySelectorAll('.setup-mode-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.setup-mode-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const mode = t.dataset.mode;
      $('setup-new').hidden = mode !== 'new';
      $('setup-existing').hidden = mode !== 'existing';
      $('setup-gist-id-row').hidden = mode !== 'existing';
    });
  });
  $('setup-go').addEventListener('click', onSetupGo);
  $('setup-cancel').addEventListener('click', closeSetup);
  $('setup-token').addEventListener('keydown', e => {
    if (e.key === 'Enter') onSetupGo();
  });
  $('setup-gist-id').addEventListener('keydown', e => {
    if (e.key === 'Enter') onSetupGo();
  });
  $('setup-done').addEventListener('click', closeSetup);
  $('setup-copy-id').addEventListener('click', async () => {
    const id = $('setup-success-id').value;
    try {
      await navigator.clipboard.writeText(id);
      toast('Gist ID 已複製', 'success');
    } catch {
      // fallback
      $('setup-success-id').select();
      document.execCommand('copy');
      toast('已選取，請手動複製', 'default');
    }
  });
}
async function onSetupGo() {
  const token = $('setup-token').value.trim();
  if (!token) { $('setup-err').textContent = '請貼入 token'; return; }
  const mode = document.querySelector('.setup-mode-tab.active').dataset.mode;
  $('setup-err').textContent = '';
  $('setup-go').disabled = true;
  $('setup-go').textContent = '連接中…';

  localStorage.setItem(LS_TOKEN, token);
  try {
    let gistId;
    if (mode === 'existing') {
      gistId = $('setup-gist-id').value.trim();
      if (!gistId) throw makeError('NO_ID', '請貼入 Gist ID');
      const bills = await loadGist(gistId);
      state.bills = bills;
    } else {
      gistId = await createGist([]);
      state.bills = [];
    }
    localStorage.setItem(LS_GIST_ID, gistId);
    setSyncStatus('ok');
    render();
    // Show success step (so user can copy Gist ID); they click 完成 to dismiss
    showSetupSuccess(gistId, mode, state.bills.length);
    toast('連線成功', 'success');
  } catch (err) {
    localStorage.removeItem(LS_TOKEN);
    $('setup-err').textContent = err.message;
  } finally {
    $('setup-go').disabled = false;
    $('setup-go').textContent = '連接';
  }
}

// ---------- Settings ----------
function openSettings() {
  $('settings-overlay').classList.add('open');
  $('settings-modal').classList.add('open');
  const status =
    state.lastError ? `❌ ${state.lastError.message}` :
    state.syncing ? '🟡 同步中…' :
    localStorage.getItem(LS_TOKEN) ? '🟢 已連線' : '⚪ 未連線';
  $('settings-status').textContent = status;
  $('settings-gist-id').value = localStorage.getItem(LS_GIST_ID) || '';
  $('settings-token').value = localStorage.getItem(LS_TOKEN) || '';
  $('settings-token').type = 'password';
}
function closeSettings() {
  $('settings-overlay').classList.remove('open');
  $('settings-modal').classList.remove('open');
}
function bindSettings() {
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-overlay').addEventListener('click', closeSettings);
  $('settings-token-toggle').addEventListener('click', () => {
    const i = $('settings-token');
    i.type = i.type === 'password' ? 'text' : 'password';
  });
  $('settings-resync').addEventListener('click', async () => {
    const gistId = localStorage.getItem(LS_GIST_ID);
    if (!gistId) return;
    try {
      setSyncStatus('syncing');
      const bills = await loadGist(gistId);
      state.bills = bills;
      setSyncStatus('ok');
      render();
      toast('已重新載入', 'success');
      closeSettings();
    } catch (err) {
      setSyncStatus('error');
      toast(`載入失敗：${err.message}`, 'error');
    }
  });
  $('settings-logout').addEventListener('click', () => {
    if (!confirm('清除 token 與 Gist ID？（Gist 本身不會被刪除）')) return;
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_GIST_ID);
    state.bills = [];
    closeSettings();
    setSyncStatus('no-token');
    render();
    openSetup();
  });
}

// ---------- Form ----------
function openForm(billOrPartial = null) {
  const isEdit = billOrPartial && billOrPartial.id && state.bills.find(b => b.id === billOrPartial.id);
  state.editingId = isEdit ? billOrPartial.id : null;
  $('form-title').textContent = isEdit ? '編輯帳單' : '新增帳單';
  $('form-delete').hidden = !isEdit;
  $('form-duplicate').hidden = !isEdit;

  const b = billOrPartial || {};
  $('f-id').value = b.id || '';
  $('f-name').value = b.name || '';
  $('f-start').value = b.startDate || '';
  $('f-end').value = b.endDate || '';
  $('f-amount').value = b.amount != null ? fmtMoney(b.amount) : '';
  updateFmt('f-amount', 'f-amount-fmt');
  $('f-overseas').checked = !!b.overseas;
  $('f-fee').value = b.fee != null ? fmtMoney(b.fee) : '';
  $('f-fee-row').hidden = !$('f-overseas').checked;
  updateFmt('f-fee', 'f-fee-fmt');
  $('f-paid').checked = !!b.paid;
  $('f-paid-row').hidden = !$('f-paid').checked;
  $('f-paid-date').value = b.paidDate || (b.paid ? fmtDate(todayDate()) : '');
  $('f-due').value = b.dueDate || '';
  $('f-note').value = b.note || '';
  $('err-end').textContent = '';
  $('err-name').textContent = '';
  $('form-overlay').classList.add('open');
  $('form-modal').classList.add('open');
  setTimeout(() => { if (!isEdit) $('f-name').focus(); }, 200);
  rebuildNameSuggestions();
}
function closeForm() {
  $('form-overlay').classList.remove('open');
  $('form-modal').classList.remove('open');
  state.editingId = null;
}
function updateFmt(inputId, fmtId) {
  const v = parseMoney($(inputId).value);
  $(fmtId).textContent = ''; // formatted value already shown in input via user input
  // Format on blur for inputs to avoid disrupting typing
}
function attachAmountInput(inputId) {
  const el = $(inputId);
  el.addEventListener('blur', () => {
    const n = parseMoney(el.value);
    el.value = n == null ? '' : fmtMoney(n);
  });
  el.addEventListener('focus', () => {
    const n = parseMoney(el.value);
    el.value = n == null ? '' : String(n);
  });
}
function bindForm() {
  attachAmountInput('f-amount');
  attachAmountInput('f-fee');
  $('f-overseas').addEventListener('change', () => {
    $('f-fee-row').hidden = !$('f-overseas').checked;
    if (!$('f-overseas').checked) $('f-fee').value = '';
  });
  $('f-paid').addEventListener('change', () => {
    $('f-paid-row').hidden = !$('f-paid').checked;
    if ($('f-paid').checked && !$('f-paid-date').value) {
      $('f-paid-date').value = fmtDate(todayDate());
    }
  });
  $('f-end').addEventListener('change', validateEndDate);
  $('f-start').addEventListener('change', validateEndDate);

  // date chips
  document.querySelectorAll('.chip[data-set]').forEach(c => {
    c.addEventListener('click', () => {
      const target = c.dataset.set;
      const d = computeChipDate(c.dataset.d, $(target).value);
      if (d) $(target).value = fmtDate(d);
      validateEndDate();
    });
  });

  $('form-close').addEventListener('click', closeForm);
  $('form-cancel').addEventListener('click', closeForm);
  $('form-overlay').addEventListener('click', closeForm);
  $('form-save').addEventListener('click', onSave);
  $('form-delete').addEventListener('click', onDelete);
  $('form-duplicate').addEventListener('click', onDuplicate);

  $('bill-form').addEventListener('submit', e => { e.preventDefault(); onSave(); });
  $('bill-form').addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSave(); }
  });
}
function computeChipDate(kind, currentValue) {
  const t = todayDate();
  switch (kind) {
    case 'today': return t;
    case 'month-start': return new Date(t.getFullYear(), t.getMonth(), 1);
    case 'month-end': return new Date(t.getFullYear(), t.getMonth() + 1, 0);
    case 'last-month-start': return new Date(t.getFullYear(), t.getMonth() - 1, 1);
    case 'plus-30': {
      const base = currentValue ? parseDate(currentValue) : t;
      return addDays(base, 30);
    }
  }
  return null;
}
function validateEndDate() {
  const s = parseDate($('f-start').value);
  const e = parseDate($('f-end').value);
  const err = $('err-end');
  if (s && e && e < s) {
    err.textContent = '結束日不可早於開始日';
    $('f-end').classList.add('error');
    return false;
  }
  err.textContent = '';
  $('f-end').classList.remove('error');
  return true;
}
function onSave() {
  const name = $('f-name').value.trim();
  if (!name) { $('err-name').textContent = '請輸入名稱'; $('f-name').focus(); return; }
  $('err-name').textContent = '';
  if (!validateEndDate()) return;
  if (!$('f-start').value || !$('f-end').value) return;
  const amount = parseMoney($('f-amount').value);
  if (amount == null) { toast('金額必填', 'warn'); $('f-amount').focus(); return; }
  const overseas = $('f-overseas').checked;
  const feeRaw = $('f-fee').value.trim();
  const fee = overseas ? (feeRaw === '' ? null : parseMoney(feeRaw)) : null;
  const paid = $('f-paid').checked;
  const paidDate = paid ? ($('f-paid-date').value || fmtDate(todayDate())) : null;

  const id = $('f-id').value || uid();
  const existing = state.bills.find(b => b.id === id);
  const bill = {
    id,
    name,
    startDate: $('f-start').value,
    endDate: $('f-end').value,
    amount,
    overseas,
    fee,
    paid,
    paidDate,
    dueDate: $('f-due').value || null,
    note: $('f-note').value.trim(),
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  if (existing) {
    Object.assign(existing, bill);
  } else {
    state.bills.push(bill);
  }
  scheduleSave();
  closeForm();
  render();
  toast(existing ? '已更新' : '已新增', 'success');
}
function onDelete() {
  const id = state.editingId;
  if (!id) return;
  const bill = state.bills.find(b => b.id === id);
  if (!bill) return;
  if (!confirm(`刪除「${bill.name}」？`)) return;
  const removed = { ...bill };
  state.bills = state.bills.filter(b => b.id !== id);
  scheduleSave();
  closeForm();
  render();
  toast('已刪除', 'default', {
    duration: 5000,
    action: {
      label: '↩ 復原',
      fn: () => {
        state.bills.push(removed);
        scheduleSave();
        render();
        toast('已復原', 'success');
      },
    },
  });
}
function onDuplicate() {
  const id = state.editingId;
  if (!id) return;
  const b = state.bills.find(x => x.id === id);
  if (!b) return;
  const s = parseDate(b.startDate);
  const e = parseDate(b.endDate);
  if (!s || !e) return;
  const days = daysBetween(s, e) + 1;
  const newStart = addDays(e, 1);
  const newEnd = addDays(newStart, days - 1);
  // shift dueDate same offset from end
  let newDue = null;
  if (b.dueDate) {
    const due = parseDate(b.dueDate);
    if (due) {
      const offset = daysBetween(e, due);
      newDue = fmtDate(addDays(newEnd, offset));
    }
  }
  const copy = {
    ...b,
    id: uid(),
    startDate: fmtDate(newStart),
    endDate: fmtDate(newEnd),
    paid: false,
    paidDate: null,
    // 海外消費新一期手續費通常還沒入帳 → 重設為 null（待補）
    // 非海外消費維持原 fee（一般是 null）
    fee: b.overseas ? null : b.fee,
    dueDate: newDue,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.bills.push(copy);
  scheduleSave();
  closeForm();
  render();
  toast(`已建立下一期：${copy.startDate} → ${copy.endDate}`, 'success', {
    duration: 4500,
    action: { label: '編輯', fn: () => openForm(copy) },
  });
}

function rebuildNameSuggestions() {
  // 收集已輸入過的項目名稱，依使用次數 → 最近更新時間排序
  const counts = new Map();
  const latest = new Map();
  for (const b of state.bills) {
    if (!b.name) continue;
    counts.set(b.name, (counts.get(b.name) || 0) + 1);
    const t = b.updatedAt || b.createdAt || '';
    if (!latest.has(b.name) || t > latest.get(b.name)) latest.set(b.name, t);
  }
  const names = [...counts.keys()].sort((a, b) => {
    const c = (counts.get(b) || 0) - (counts.get(a) || 0);
    if (c !== 0) return c;
    return (latest.get(b) || '') > (latest.get(a) || '') ? 1 : -1;
  });

  // visible chips (top 12) — tap to fill
  const chipsEl = $('name-chips');
  if (chipsEl) {
    chipsEl.innerHTML = names.slice(0, 12).map(n =>
      `<button type="button" class="chip name-chip" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`
    ).join('');
    chipsEl.querySelectorAll('.name-chip').forEach(c => {
      c.addEventListener('click', () => {
        $('f-name').value = c.dataset.name;
        $('err-name').textContent = '';
        $('f-name').dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
  }
}

// ---------- Bills List ----------
function bindList() {
  $('btn-add').addEventListener('click', () => openForm());
  $('fab-add').addEventListener('click', () => openForm());
  $('btn-export').addEventListener('click', exportJson);
  $('btn-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', importJson);

  $('search').addEventListener('input', () => {
    state.filter.search = $('search').value.toLowerCase().trim();
    renderList();
  });
  $('filter-unpaid').addEventListener('change', () => {
    state.filter.unpaid = $('filter-unpaid').checked;
    renderList();
  });
  $('selection-toggle').addEventListener('change', () => {
    state.selectionMode = $('selection-toggle').checked;
    document.body.classList.toggle('selection-mode', state.selectionMode);
    if (!state.selectionMode) state.selection.clear();
    renderList();
    renderSelectionBar();
  });

  $('sel-exit').addEventListener('click', () => {
    $('selection-toggle').checked = false;
    state.selectionMode = false;
    state.selection.clear();
    document.body.classList.remove('selection-mode');
    renderList();
    renderSelectionBar();
  });
  $('sel-share').addEventListener('click', () => {
    // sync selection to share calc selection
    const ids = [...state.selection];
    if (ids.length === 0) {
      toast('請先勾選帳單', 'warn');
      return;
    }
    document.querySelectorAll('#share-bills input[type="checkbox"]').forEach(cb => {
      cb.checked = ids.includes(cb.dataset.id);
    });
    updateShareCount();
    $('share-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function filteredBills() {
  return visibleBills().filter(b => {
    if (state.filter.unpaid && b.paid) return false;
    if (state.filter.search && !b.name.toLowerCase().includes(state.filter.search)) return false;
    return true;
  }).sort((a, b) => {
    if (a.startDate !== b.startDate) return a.startDate > b.startDate ? -1 : 1;
    return (a.createdAt || '') > (b.createdAt || '') ? -1 : 1;
  });
}

function renderList() {
  const list = $('bills-list');
  const bills = filteredBills();
  const oldCount = state.bills.filter(isOldBill).length;
  const countEl = $('bills-count');
  if (countEl) {
    countEl.textContent = state.bills.length > 0
      ? `(${bills.length}${oldCount > 0 && !state.showOld ? ` / 隱藏 ${oldCount}` : ''})`
      : '';
  }
  if (bills.length === 0) {
    list.innerHTML = `<div class="empty">
      <div class="big" aria-hidden="true">📭</div>
      <div>${state.bills.length === 0 ? '尚無帳單，' : '沒有符合條件的帳單。'}</div>
      ${state.bills.length === 0 ? '<button id="empty-add" style="margin-top:10px;">新增第一筆</button>' : ''}
    </div>`;
    const ea = $('empty-add');
    if (ea) ea.addEventListener('click', () => openForm());
  } else {
    list.innerHTML = '';
    for (const b of bills) {
      const card = renderBillCard(b);
      list.appendChild(card);
    }
  }
  // 舊帳單收合 banner
  if (oldCount > 0) {
    const banner = document.createElement('div');
    banner.className = 'old-banner';
    banner.innerHTML = state.showOld
      ? `<span>顯示 ${oldCount} 筆結束日早於 ${OLD_THRESHOLD_DAYS} 天前的帳單</span>
         <button class="ghost small" id="old-toggle">收合</button>`
      : `<span>📦 ${oldCount} 筆結束日早於 ${OLD_THRESHOLD_DAYS} 天前的帳單已收合</span>
         <button class="ghost small" id="old-toggle">展開</button>`;
    list.appendChild(banner);
    $('old-toggle').addEventListener('click', () => {
      state.showOld = !state.showOld;
      // 重置 gantt 範圍快取，讓視窗依新可見集合重算
      state.ganttRangeStart = null;
      state.ganttRangeEnd = null;
      // 收合時把已選但變隱藏的清出 selection（避免合計虛報）
      if (!state.showOld) {
        for (const id of [...state.selection]) {
          const b = state.bills.find(x => x.id === id);
          if (b && isOldBill(b)) state.selection.delete(id);
        }
      }
      render();
    });
  }
}

function renderBillCard(b) {
  const status = billStatus(b);
  const total = billTotal(b);
  const days = billDays(b);
  const selected = state.selection.has(b.id);
  const card = document.createElement('div');
  card.className = `bill ${status}${b.paid ? ' paid' : ''}${selected ? ' selected' : ''}`;
  card.dataset.id = b.id;

  const feePending = b.overseas && b.fee == null;
  const statusBadge = {
    paid: '<span class="badge paid">已繳</span>',
    overdue: '<span class="badge overdue">逾期</span>',
    'due-soon': '<span class="badge due-soon">將到期</span>',
    unpaid: '<span class="badge unpaid">未繳</span>',
  }[status];

  card.innerHTML = `
    <div class="bill-row">
      <span class="bill-select-check ${selected ? 'checked' : ''}" data-act="toggle-select" aria-label="選取">
        ${selected ? '✓' : ''}
      </span>
      <div class="bill-info">
        <div class="bill-name">
          ${escapeHtml(b.name)}
          ${statusBadge}
          ${b.overseas ? '<span class="badge overseas">🌏</span>' : ''}
          ${feePending ? '<span class="badge pending-fee">⏳</span>' : ''}
        </div>
        <div class="bill-meta">
          ${b.startDate} → ${b.endDate} <span style="color:var(--text-dim);">(${days}天)</span>${b.dueDate ? ` ・ 截止 ${b.dueDate}` : ''}${b.paidDate ? ` ・ 繳於 ${b.paidDate}` : ''}${b.note ? ` ・ ${escapeHtml(b.note)}` : ''}
        </div>
      </div>
      <div class="bill-amount-block">
        <div class="bill-amount">${fmtCurrency(total)}</div>
        ${b.overseas && (b.fee || feePending)
          ? `<div class="bill-fee-line${feePending ? ' pending' : ''}">${
              feePending ? '⏳ 手續費' : `+${fmtCurrency(b.fee)}`
            }</div>`
          : ''}
      </div>
      <div class="bill-actions-mini">
        <button class="bill-paid-quick ${b.paid ? 'checked' : ''}" data-act="toggle-paid" title="${b.paid ? '標未繳' : '標已繳'}">${b.paid ? '✓' : ''}</button>
        <button class="bill-more" data-act="more" title="更多">⋯</button>
      </div>
    </div>
  `;

  card.addEventListener('click', e => {
    const actBtn = e.target.closest('[data-act]');
    if (!actBtn) {
      // click anywhere on card body (not action button) → if selection mode, toggle; otherwise edit
      if (state.selectionMode) toggleSelect(b.id);
      else openForm(b);
      return;
    }
    e.stopPropagation();
    const act = actBtn.dataset.act;
    if (act === 'toggle-paid') return togglePaid(b.id);
    if (act === 'toggle-select') return toggleSelect(b.id);
    if (act === 'more') {
      const r = actBtn.getBoundingClientRect();
      return showQuickMenu(r.left, r.bottom + 4, b);
    }
  });

  return card;
}

function togglePaid(id) {
  const b = state.bills.find(x => x.id === id);
  if (!b) return;
  b.paid = !b.paid;
  if (b.paid && !b.paidDate) b.paidDate = fmtDate(todayDate());
  if (!b.paid) b.paidDate = null;
  b.updatedAt = nowIso();
  scheduleSave();
  render();
}

function toggleSelect(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  // enable selection mode if user starts selecting
  if (state.selection.size > 0 && !state.selectionMode) {
    state.selectionMode = true;
    document.body.classList.add('selection-mode');
    $('selection-toggle').checked = true;
  }
  renderList();
  renderSelectionBar();
}

function renderSelectionBar() {
  const bar = $('selection-bar');
  const ids = [...state.selection];
  bar.classList.toggle('has-selection', ids.length > 0);
  if (ids.length === 0) {
    $('sel-count').textContent = '0';
    $('sel-total').textContent = '0';
    $('sel-pending-fee').textContent = '';
    return;
  }
  let total = 0;
  let pendingFeeCount = 0;
  for (const id of ids) {
    const b = state.bills.find(x => x.id === id);
    if (!b) continue;
    total += billTotal(b);
    if (b.overseas && b.fee == null) pendingFeeCount++;
  }
  $('sel-count').textContent = String(ids.length);
  $('sel-total').textContent = fmtCurrency(total);
  $('sel-pending-fee').textContent = pendingFeeCount > 0
    ? `（含 ${pendingFeeCount} 筆 ⏳ 手續費）`
    : '';
}

// ---------- Export/Import ----------
function exportJson() {
  const data = makeGistContent(state.bills);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bills-${fmtDate(todayDate())}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
function importJson(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const incoming = Array.isArray(parsed) ? parsed : parsed?.bills;
      if (!Array.isArray(incoming)) throw new Error('格式錯誤：找不到 bills 陣列');
      if (!confirm(`匯入 ${incoming.length} 筆？將覆蓋目前資料。`)) return;
      state.bills = incoming;
      scheduleSave();
      render();
      toast(`已匯入 ${incoming.length} 筆`, 'success');
    } catch (err) {
      toast(`匯入失敗：${err.message}`, 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ---------- Gantt ----------
function bindGantt() {
  $('gantt-zoom').addEventListener('click', () => {
    state.ganttZoom = state.ganttZoom === 'week' ? 'month' : 'week';
    syncGanttZoomLabels();
    renderGantt();
  });
  $('gantt-prev').addEventListener('click', () => {
    if (state.ganttRangeStart) {
      state.ganttRangeStart = addDays(state.ganttRangeStart, -180);
    }
    renderGantt();
  });
  $('gantt-next').addEventListener('click', () => {
    if (state.ganttRangeEnd) {
      state.ganttRangeEnd = addDays(state.ganttRangeEnd, 180);
    }
    renderGantt();
  });
  $('gantt-today').addEventListener('click', () => {
    const wrap = $('gantt-wrap');
    const todayBar = wrap.querySelector('.gantt-today');
    if (todayBar) {
      const left = parseFloat(todayBar.style.left);
      wrap.scrollTo({ left: left - wrap.clientWidth / 2 + 70, behavior: 'smooth' });
    }
  });
  $('gantt-reset').addEventListener('click', () => {
    state.ganttRangeStart = null;
    state.ganttRangeEnd = null;
    state.ganttPxScale = 1;
    const wrap = $('gantt-wrap');
    if (wrap) wrap._scrolled = false; // 重新置中到今日
    renderGantt();
    toast('已重置範圍', 'success', { duration: 1500 });
  });

  const fsBtn = $('gantt-fullscreen');
  if (fsBtn) {
    fsBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleGanttFullscreen();
    });
  }
  // 點甘特圖空白區域進入全螢幕（手機觸控才觸發）
  const wrap = $('gantt-wrap');
  if (wrap) {
    wrap.addEventListener('click', async (e) => {
      if (matchMedia('(pointer: fine)').matches) return;
      if (document.fullscreenElement) return;
      if (document.querySelector('.gantt-section.gantt-fs-fallback')) return;
      if (e.target.closest('.gantt-bar, .gantt-due, button, select, a')) return;
      await enterGanttFullscreen();
    });
  }
  document.addEventListener('fullscreenchange', onGanttFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onGanttFullscreenChange);

  bindGanttPinch(wrap);

  syncGanttZoomLabels();
  matchMedia('(max-width: 600px)').addEventListener('change', syncGanttZoomLabels);
}

function isGanttFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement ||
    document.querySelector('.gantt-section.gantt-fs-fallback'));
}

function syncGanttZoomLabels() {
  const btn = $('gantt-zoom');
  if (btn) {
    const compact = isGanttFullscreen() || matchMedia('(max-width: 600px)').matches;
    const isMonth = state.ganttZoom === 'month';
    btn.dataset.value = state.ganttZoom;
    btn.textContent = compact
      ? (isMonth ? '月' : '週')
      : (isMonth ? '月檢視' : '週檢視');
  }
  const fs = $('gantt-fullscreen');
  if (fs) fs.textContent = isGanttFullscreen() ? '✕' : '⛶';
}

function applyPinchVisual(wrap, ratio) {
  const tickRow = wrap.querySelector('.gantt-tick-row');
  const tracks = wrap.querySelectorAll('.gantt-track');
  const setT = (el, s) => {
    if (!el) return;
    if (s === 1) {
      el.style.transform = '';
      el.style.transformOrigin = '';
    } else {
      el.style.transformOrigin = '0 0';
      el.style.transform = `scaleX(${s})`;
    }
  };
  // 父層水平放大 → 子元素位置跟著放大
  setT(tickRow, ratio);
  tracks.forEach(t => setT(t, ratio));
  // 對絕對定位的子元素反向抵消寬度與文字拉伸（位置不變）
  const inv = ratio === 0 ? 1 : 1 / ratio;
  wrap.querySelectorAll(
    '.gantt-bar, .gantt-due, .gantt-due-link, .gantt-today, .gantt-today-label, .gantt-tick .t-label'
  ).forEach(el => setT(el, inv));
}

function bindGanttPinch(wrap) {
  if (!wrap) return;
  let startDist = 0;
  let startScale = 1;
  let lastRatio = 1;
  let pinching = false;
  let anchorRatio = 0; // (scrollLeft + focalX) / contentWidth — 維持焦點

  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  wrap.addEventListener('touchstart', (e) => {
    if (!isGanttFullscreen()) return;
    if (e.touches.length !== 2) return;
    pinching = true;
    startDist = dist(e.touches[0], e.touches[1]);
    startScale = state.ganttPxScale || 1;
    lastRatio = 1;
    const rect = wrap.getBoundingClientRect();
    const focalX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
    const inner = wrap.querySelector('.gantt');
    const contentWidth = inner ? inner.offsetWidth : wrap.scrollWidth;
    anchorRatio = (wrap.scrollLeft + focalX) / Math.max(1, contentWidth);
    e.preventDefault();
  }, { passive: false });

  wrap.addEventListener('touchmove', (e) => {
    if (!pinching || e.touches.length !== 2) return;
    e.preventDefault();
    const d = dist(e.touches[0], e.touches[1]);
    const ratio = d / Math.max(1, startDist);
    lastRatio = ratio;
    const targetScale = clamp(startScale * ratio, 0.3, 5);
    const visualRatio = targetScale / startScale;
    applyPinchVisual(wrap, visualRatio);
  }, { passive: false });

  const finish = () => {
    if (!pinching) return;
    pinching = false;
    const newScale = clamp(startScale * lastRatio, 0.3, 5);
    applyPinchVisual(wrap, 1);
    state.ganttPxScale = newScale;
    renderGantt();
    // 重新對齊焦點
    requestAnimationFrame(() => {
      const inner = wrap.querySelector('.gantt');
      const newWidth = inner ? inner.offsetWidth : wrap.scrollWidth;
      const rect = wrap.getBoundingClientRect();
      wrap.scrollLeft = anchorRatio * newWidth - rect.width / 2;
    });
  };

  wrap.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) finish();
  });
  wrap.addEventListener('touchcancel', finish);

  // iOS Safari gesture events（更直接的 scale）
  wrap.addEventListener('gesturestart', (e) => {
    if (!isGanttFullscreen()) return;
    e.preventDefault();
  });
  wrap.addEventListener('gesturechange', (e) => {
    if (!isGanttFullscreen()) return;
    e.preventDefault();
  });
  wrap.addEventListener('gestureend', (e) => {
    if (!isGanttFullscreen()) return;
    e.preventDefault();
  });
}

async function enterGanttFullscreen() {
  const section = document.querySelector('.gantt-section');
  if (!section) return;
  const req = section.requestFullscreen || section.webkitRequestFullscreen;
  if (req) {
    try {
      await req.call(section);
      if (screen.orientation && screen.orientation.lock) {
        try { await screen.orientation.lock('landscape'); } catch (err) { /* iOS 不支援，改用旋轉 fallback */ }
      }
      // 若 orientation 仍是 portrait 且為 iOS，補上 CSS 旋轉
      if (isIOS() && !isLandscape()) {
        enterGanttCssFallback();
      }
      return;
    } catch (err) {
      // 標準 API 拒絕，落到 fallback
    }
  }
  enterGanttCssFallback();
}

function enterGanttCssFallback() {
  const section = document.querySelector('.gantt-section');
  if (!section) return;
  document.body.classList.add('gantt-fs-fallback-active');
  section.classList.add('gantt-fs-fallback');
  syncGanttZoomLabels();
  const wrap = $('gantt-wrap');
  if (wrap) wrap._scrolled = false;
  renderGantt();
}

function exitGanttCssFallback() {
  const section = document.querySelector('.gantt-section');
  if (!section) return;
  document.body.classList.remove('gantt-fs-fallback-active');
  section.classList.remove('gantt-fs-fallback');
  syncGanttZoomLabels();
  const wrap = $('gantt-wrap');
  if (wrap) wrap._scrolled = false;
  renderGantt();
}

async function exitGanttFullscreen() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) {
      try { await exit.call(document); } catch (err) {}
    }
  }
  if (document.querySelector('.gantt-section.gantt-fs-fallback')) {
    exitGanttCssFallback();
  }
}

async function toggleGanttFullscreen() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  const inFallback = !!document.querySelector('.gantt-section.gantt-fs-fallback');
  if (fsEl || inFallback) await exitGanttFullscreen();
  else await enterGanttFullscreen();
}

function onGanttFullscreenChange() {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fsEl && screen.orientation && screen.orientation.unlock) {
    try { screen.orientation.unlock(); } catch (err) {}
  }
  syncGanttZoomLabels();
  const wrap = $('gantt-wrap');
  if (wrap) wrap._scrolled = false;
  renderGantt();
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isLandscape() {
  return window.innerWidth > window.innerHeight;
}
function computeGanttRange() {
  const today = todayDate();
  let min = addDays(today, -180);
  let max = addDays(today, 180);
  // Gantt 不受清單收合影響，永遠顯示全部
  for (const b of state.bills) {
    const s = parseDate(b.startDate);
    const e = parseDate(b.endDate);
    if (s && s < min) min = addDays(s, -30);
    if (e && e > max) max = addDays(e, 30);
    if (b.dueDate) {
      const d = parseDate(b.dueDate);
      if (d && d > max) max = addDays(d, 30);
    }
  }
  if (state.ganttRangeStart && state.ganttRangeStart < min) min = state.ganttRangeStart;
  if (state.ganttRangeEnd && state.ganttRangeEnd > max) max = state.ganttRangeEnd;
  state.ganttRangeStart = min;
  state.ganttRangeEnd = max;
  return { min, max };
}
function pxPerDay() {
  const base = state.ganttZoom === 'month' ? 3 : 9;
  const scale = state.ganttPxScale || 1;
  return base * scale;
}
function renderGantt() {
  const wrap = $('gantt-wrap');
  // Gantt 永遠顯示所有帳單（清單收合不影響）
  if (state.bills.length === 0) {
    wrap.innerHTML = '<div class="empty">尚無資料</div>';
    return;
  }
  const { min, max } = computeGanttRange();
  const px = pxPerDay();
  const totalDays = daysBetween(min, max) + 1;
  const width = totalDays * px;

  // Group bills by name
  const groups = new Map();
  for (const b of state.bills) {
    if (!groups.has(b.name)) groups.set(b.name, []);
    groups.get(b.name).push(b);
  }
  // 排序固定：按項目名稱字母順序（中文用 locale 比較）
  const collator = new Intl.Collator('zh-Hant', { sensitivity: 'base', numeric: true });
  const sortedGroups = [...groups.entries()].sort((a, b) => collator.compare(a[0], b[0]));

  // Build header ticks
  const ticks = [];
  if (state.ganttZoom === 'month') {
    let cur = new Date(min.getFullYear(), min.getMonth(), 1);
    while (cur <= max) {
      const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      const tickEnd = next < max ? next : addDays(max, 1);
      ticks.push({ date: new Date(cur), label: `${cur.getFullYear()}/${cur.getMonth() + 1}`, width: daysBetween(cur, tickEnd) * px });
      cur = next;
    }
  } else {
    // week — start at the most recent Monday on/before min
    let cur = new Date(min);
    const dow = (cur.getDay() + 6) % 7; // Monday=0
    cur.setDate(cur.getDate() - dow);
    while (cur <= max) {
      const next = addDays(cur, 7);
      const tickEnd = next < max ? next : addDays(max, 1);
      const w = Math.max(0, daysBetween(cur < min ? min : cur, tickEnd) * px);
      ticks.push({
        date: new Date(cur),
        label: `${cur.getMonth() + 1}/${cur.getDate()}`,
        width: w,
      });
      cur = next;
    }
  }

  const today = todayDate();
  const todayLeft = (daysBetween(min, today)) * px;

  // Build HTML
  let html = `<div class="gantt" style="width:${width + 140}px; --day-width:${px}px;">`;
  // Header
  html += `<div class="gantt-header">
    <div class="gantt-corner">項目</div>
    <div class="gantt-tick-row" style="width:${width}px;">`;
  for (const t of ticks) {
    html += `<div class="gantt-tick" style="width:${t.width}px;"><span class="t-label">${t.label}</span></div>`;
  }
  html += `</div></div>`;

  // 重疊偵測：同一行內 (同名項目) 把日期重疊的 bar 分到不同 lane
  // BAR_H + GAP 與 CSS 相應
  const BAR_H = 32;
  const BAR_GAP = 4;
  const TOP_PAD = 6;
  const BOTTOM_PAD = 6;

  function assignLanes(bills) {
    // 取得有效日期、按開始日排序（同日按結束日）
    const valid = bills
      .map(b => ({ b, s: parseDate(b.startDate), e: parseDate(b.endDate) }))
      .filter(x => x.s && x.e)
      .sort((a, b) => a.s - b.s || a.e - b.e);
    const lanes = []; // 每 lane 紀錄最後一條 bar 的結束日
    const idLane = new Map();
    for (const { b, s, e } of valid) {
      let assigned = -1;
      for (let i = 0; i < lanes.length; i++) {
        // 閉區間：若新的開始日 > lane 內最後結束日 → 不重疊
        if (s > lanes[i]) { assigned = i; break; }
      }
      if (assigned === -1) {
        assigned = lanes.length;
        lanes.push(e);
      } else {
        lanes[assigned] = e;
      }
      idLane.set(b.id, assigned);
    }
    return { laneCount: lanes.length || 1, idLane };
  }

  // Rows
  for (const [name, billList] of sortedGroups) {
    const { laneCount, idLane } = assignLanes(billList);
    const rowHeight = TOP_PAD + laneCount * BAR_H + (laneCount - 1) * BAR_GAP + BOTTOM_PAD;
    html += `<div class="gantt-row" data-name="${escapeHtml(name)}" style="min-height:${rowHeight}px;">`;
    html += `<div class="gantt-row-label" style="min-height:${rowHeight}px;">
      <div class="nm">${escapeHtml(name)}</div>
      <div class="sub">${billList.length} 筆${laneCount > 1 ? ` ・ ${laneCount} 層` : ''}</div>
    </div>`;
    html += `<div class="gantt-track" data-name="${escapeHtml(name)}" style="width:${width}px; min-height:${rowHeight}px;">`;
    // 渲染 bars
    for (const b of billList) {
      const s = parseDate(b.startDate);
      const e = parseDate(b.endDate);
      if (!s || !e) continue;
      const lane = idLane.get(b.id) || 0;
      const left = daysBetween(min, s) * px;
      const w = Math.max(px * 0.6, (daysBetween(s, e) + 1) * px - 1);
      const top = TOP_PAD + lane * (BAR_H + BAR_GAP);
      const status = billStatus(b);
      const cls = b.paid ? 'paid' : (status === 'overdue' ? 'overdue' : status === 'due-soon' ? 'due-soon' : '');
      const hasFee = b.overseas && b.fee != null && b.fee !== 0;
      const main = `${escapeHtml(b.name)} ${escapeHtml(fmtCurrency(billTotal(b)))}`;
      const dateLabel = `${s.getMonth() + 1}/${s.getDate()}–${e.getMonth() + 1}/${e.getDate()}`;
      const titleParts = [
        `${b.name} ${b.startDate}→${b.endDate}`,
        fmtCurrency(billTotal(b)),
      ];
      if (hasFee) titleParts.push(`含手續費 ${fmtCurrency(b.fee)}`);
      else if (b.overseas && b.fee == null) titleParts.push('海外消費，手續費未入帳');
      const feeBadge = hasFee
        ? `<span class="b-fee">手續費 ${escapeHtml(fmtCurrency(b.fee))}</span>`
        : '';
      const barColor = colorForName(b.name);
      html += `<div class="gantt-bar ${cls}" data-id="${b.id}"
                style="left:${left}px; width:${w}px; top:${top}px; background:${barColor};"
                title="${escapeHtml(titleParts.join('  '))}">
        <div class="b-main">${main}</div>
        ${feeBadge}
        <div class="b-dates">${dateLabel}</div>
      </div>`;
      // 未繳 + 有最後繳費日 → 在 track 上標出截止日
      // dueDate 早於 startDate 視為資料錯誤，跳過
      if (!b.paid && b.dueDate) {
        const due = parseDate(b.dueDate);
        if (due && due >= s) {
          const dueLeft = daysBetween(min, due) * px;
          const dueOverdue = due < todayDate();
          const barEnd = left + w;
          const dueDateLabel = `截止 ${due.getMonth() + 1}/${due.getDate()}`;
          // 連接線：從 bar 尾端到截止點（限定 dueDate 在 bar 結束日之後）
          if (dueLeft > barEnd) {
            const linkTop = top + BAR_H / 2 - 1;
            html += `<div class="gantt-due-link" style="left:${barEnd}px; top:${linkTop}px; width:${Math.max(0, dueLeft - barEnd)}px;"></div>`;
          }
          // 截止標記
          html += `<div class="gantt-due ${dueOverdue ? 'overdue-flag' : ''}"
                    style="left:${dueLeft}px; top:${top}px; height:${BAR_H}px;">
            <div class="due-label">${dueDateLabel}</div>
          </div>`;
        }
      }
    }
    html += `</div></div>`;
  }

  // Today line (full height absolute element appended after rows by tracking)
  html += `</div>`;
  wrap.innerHTML = html;

  // Append today line to each track (so it appears across all rows)
  if (todayLeft >= 0 && todayLeft <= width) {
    const tracks = wrap.querySelectorAll('.gantt-track');
    tracks.forEach((tr, idx) => {
      const line = document.createElement('div');
      line.className = 'gantt-today';
      line.style.left = `${todayLeft}px`;
      tr.appendChild(line);
    });
    // Add a today label on the header
    const header = wrap.querySelector('.gantt-tick-row');
    if (header) {
      const lbl = document.createElement('div');
      lbl.className = 'gantt-today-label';
      lbl.textContent = '今日';
      lbl.style.left = `${todayLeft}px`;
      header.appendChild(lbl);
    }
  }

  // Wire interactions
  wireGanttInteractions(wrap, min, max, px);

  // Auto-scroll to today on first render
  if (!wrap._scrolled) {
    wrap.scrollLeft = Math.max(0, todayLeft - wrap.clientWidth / 2 + 70);
    wrap._scrolled = true;
  }
}

function wireGanttInteractions(wrap, min, max, px) {
  // Click bar → quick menu
  wrap.querySelectorAll('.gantt-bar').forEach(bar => {
    bar.addEventListener('click', e => {
      e.stopPropagation();
      const id = bar.dataset.id;
      const b = state.bills.find(x => x.id === id);
      if (!b) return;
      showQuickMenu(e.clientX, e.clientY, b);
    });
  });

  // Drag on track to create — desktop only
  const isFine = matchMedia('(pointer: fine)').matches;
  if (!isFine) return;
  wrap.querySelectorAll('.gantt-track').forEach(track => {
    const name = track.dataset.name;
    track.addEventListener('mousedown', e => {
      if (e.target.closest('.gantt-bar')) return;
      if (e.button !== 0) return;
      const rect0 = track.getBoundingClientRect();
      const startX = e.clientX - rect0.left;
      const ghost = document.createElement('div');
      ghost.className = 'gantt-ghost';
      ghost.style.left = `${startX}px`;
      ghost.style.width = '1px';
      track.appendChild(ghost);
      e.preventDefault();

      const onMove = (ev) => {
        const rect = track.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const left = Math.min(startX, x);
        const w = Math.abs(x - startX);
        ghost.style.left = `${left}px`;
        ghost.style.width = `${w}px`;
      };
      const onUp = (ev) => {
        window.removeEventListener('mousemove', onMove);
        const rect = track.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const dayA = Math.round(Math.min(startX, x) / px);
        const dayB = Math.round(Math.max(startX, x) / px);
        ghost.remove();
        if (Math.abs(dayB - dayA) < 1) return;
        const sd = addDays(min, dayA);
        const ed = addDays(min, dayB - 1);
        openForm({
          name,
          startDate: fmtDate(sd),
          endDate: fmtDate(ed),
        });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp, { once: true });
    });
  });
}

function showQuickMenu(x, y, bill) {
  const menu = $('qmenu');
  menu.hidden = false;
  const status = billStatus(bill);
  const statusBadge = {
    paid: '<span class="badge paid">已繳</span>',
    overdue: '<span class="badge overdue">逾期</span>',
    'due-soon': '<span class="badge due-soon">將到期</span>',
    unpaid: '<span class="badge unpaid">未繳</span>',
  }[status];
  const feePending = bill.overseas && bill.fee == null;
  const days = billDays(bill);
  const total = billTotal(bill);
  menu.innerHTML = `
    <div class="qmenu-info">
      <div class="qmenu-info-row">
        <strong class="qmenu-info-name">${escapeHtml(bill.name)}</strong>
        ${statusBadge}
      </div>
      <div class="qmenu-info-row qmenu-info-amt">
        ${fmtCurrency(total)}
        ${bill.overseas ? `<span class="badge overseas">🌏</span>` : ''}
        ${feePending ? `<span class="badge pending-fee">⏳ 手續費</span>` : ''}
      </div>
      <div class="qmenu-info-meta">
        ${bill.startDate} → ${bill.endDate} <span style="opacity:0.6;">(${days} 天)</span>
        ${bill.dueDate ? `<br>截止 ${bill.dueDate}` : ''}
        ${bill.paidDate ? `<br>繳於 ${bill.paidDate}` : ''}
        ${bill.note ? `<br>${escapeHtml(bill.note)}` : ''}
      </div>
    </div>
    <hr>
    <label class="toggle qmenu-toggle" data-q="toggle-paid">
      <input type="checkbox" ${bill.paid ? 'checked' : ''}>
      <span class="track"><span class="thumb"></span></span>
      <span class="label-text">已繳</span>
    </label>
    <hr>
    <button data-q="edit">編輯…</button>
    <button data-q="duplicate">複製到下期</button>
    <hr>
    <button data-q="delete" class="danger">刪除</button>
  `;
  // position (info section makes menu taller)
  menu.style.position = 'fixed';
  menu.style.left = '0px';
  menu.style.top = '0px';
  // measure after layout
  const rect = menu.getBoundingClientRect();
  const w = rect.width || 240, h = rect.height || 280;
  let left = x;
  let top = y;
  if (left + w > innerWidth) left = innerWidth - w - 8;
  if (top + h > innerHeight) top = Math.max(8, innerHeight - h - 8);
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  // Toggle paid (does NOT close menu — let user see state)
  const tgl = menu.querySelector('.qmenu-toggle input');
  if (tgl) {
    tgl.addEventListener('change', e => {
      e.stopPropagation();
      togglePaid(bill.id);
    });
  }
  menu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const q = btn.dataset.q;
      menu.hidden = true;
      if (q === 'edit') openForm(bill);
      else if (q === 'duplicate') { state.editingId = bill.id; onDuplicate(); }
      else if (q === 'delete') {
        state.editingId = bill.id;
        onDelete();
      }
    });
  });
  // dismiss on outside click
  const dismiss = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.hidden = true;
      document.removeEventListener('click', dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss, true), 0);
}

// ---------- Share Calculator ----------
function bindShare() {
  $('share-calc').addEventListener('click', calcShare);
  $('share-all').addEventListener('click', () => {
    document.querySelectorAll('#share-bills input[type="checkbox"]').forEach(cb => cb.checked = true);
    updateShareCount();
  });
  $('share-none').addEventListener('click', () => {
    document.querySelectorAll('#share-bills input[type="checkbox"]').forEach(cb => cb.checked = false);
    updateShareCount();
  });
  document.querySelectorAll('#share-cutoff-chips .chip').forEach(c => {
    c.addEventListener('click', () => {
      const d = computeChipDate(c.dataset.cutoff);
      if (d) {
        $('share-cutoff').value = fmtDate(d);
      }
    });
  });
}

function renderShareBills() {
  const wrap = $('share-bills');
  const bills = visibleBills();
  if (bills.length === 0) {
    wrap.innerHTML = '<div class="empty">尚無帳單</div>';
    return;
  }
  const sorted = [...bills].sort((a, b) => a.startDate > b.startDate ? -1 : 1);
  wrap.innerHTML = sorted.map(b => `
    <label class="share-bill-row" data-id="${b.id}">
      <input type="checkbox" data-id="${b.id}" checked>
      <span class="nm">${escapeHtml(b.name)} <span style="color:var(--text-dim);font-size:0.78rem;">${fmtCurrency(billTotal(b))}</span></span>
      <span class="dt">${b.startDate} → ${b.endDate}</span>
    </label>
  `).join('');
  wrap.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', updateShareCount);
  });
  updateShareCount();
}
function updateShareCount() {
  const n = document.querySelectorAll('#share-bills input[type="checkbox"]:checked').length;
  $('share-selected-count').textContent = `已選 ${n} 筆`;
}

function calcShare() {
  const cutoffStr = $('share-cutoff').value;
  const cutoff = parseDate(cutoffStr);
  const peopleN = parseInt($('share-people').value, 10);
  if (!cutoff) { toast('請選中斷點日期', 'warn'); return; }
  if (!peopleN || peopleN < 1) { toast('請輸入人數', 'warn'); return; }

  const selected = [...document.querySelectorAll('#share-bills input[type="checkbox"]:checked')]
    .map(cb => state.bills.find(b => b.id === cb.dataset.id))
    .filter(Boolean);
  if (selected.length === 0) { toast('請勾選至少一筆帳單', 'warn'); return; }

  const rows = [];
  let totalForPeriod = 0;
  let pendingFeeCount = 0;
  for (const b of selected) {
    const s = parseDate(b.startDate);
    const e = parseDate(b.endDate);
    if (!s || !e) { rows.push({ b, status: 'invalid' }); continue; }
    if (cutoff < s) { rows.push({ b, status: 'not-started' }); continue; }
    if (cutoff > e) { rows.push({ b, status: 'ended' }); continue; }
    const elapsed = daysBetween(s, cutoff) + 1;
    const total = daysBetween(s, e) + 1;
    const ratio = clamp(elapsed / total, 0, 1);
    const amt = ratio * billTotal(b);
    totalForPeriod += amt;
    if (b.overseas && b.fee == null) pendingFeeCount++;
    rows.push({ b, status: 'applied', elapsed, total, ratio, amt });
  }
  const perPerson = totalForPeriod / peopleN;

  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
      <div>
        <div style="font-size:0.82rem;color:var(--text-muted);">每人應付</div>
        <div class="per-person">${fmtCurrency(perPerson)}</div>
      </div>
      <div style="text-align:right;">
        <div style="font-size:0.82rem;color:var(--text-muted);">合計區間金額</div>
        <div style="font-weight:600;font-size:1.1rem;">${fmtCurrency(totalForPeriod)}</div>
        <div style="font-size:0.78rem;color:var(--text-muted);">÷ ${peopleN} 人</div>
      </div>
    </div>
    ${pendingFeeCount > 0 ? `<div style="color:var(--warn);font-size:0.82rem;margin-bottom:8px;">⏳ 含 ${pendingFeeCount} 筆手續費未入帳（未計入合計）</div>` : ''}
    <div style="font-size:0.85rem;font-weight:600;margin-bottom:6px;color:var(--text-muted);">明細</div>
    ${rows.map(r => {
      if (r.status === 'applied') {
        return `<div class="share-detail-row applied">
          <span class="nm">${escapeHtml(r.b.name)}</span>
          <span style="color:var(--text-muted);font-size:0.78rem;">${r.elapsed}/${r.total} 天 (${(r.ratio * 100).toFixed(1)}%)</span>
          <span class="amt">${fmtCurrency(r.amt)}</span>
        </div>`;
      } else if (r.status === 'not-started') {
        return `<div class="share-detail-row">
          <span class="nm">${escapeHtml(r.b.name)}</span>
          <span class="na">尚未開始 (${r.b.startDate})</span>
          <span></span>
        </div>`;
      } else if (r.status === 'ended') {
        return `<div class="share-detail-row">
          <span class="nm">${escapeHtml(r.b.name)}</span>
          <span class="na">已結束 (${r.b.endDate})</span>
          <span></span>
        </div>`;
      }
      return `<div class="share-detail-row"><span class="nm">${escapeHtml(r.b.name)}</span><span class="na">資料不全</span><span></span></div>`;
    }).join('')}
  `;
  const result = $('share-result');
  result.hidden = false;
  result.innerHTML = html;
}

// ---------- Keyboard shortcuts ----------
function bindKeys() {
  document.addEventListener('keydown', e => {
    // Don't trigger when typing in inputs
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Escape') {
      if (!$('form-modal').classList.contains('open')) {
        closeSettings();
      } else {
        closeForm();
      }
      $('qmenu').hidden = true;
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n' || e.key === 'N') { openForm(); e.preventDefault(); }
    else if (e.key === '/') { $('search').focus(); e.preventDefault(); }
    else if (e.key === 's' || e.key === 'S') {
      $('filter-unpaid').checked = !$('filter-unpaid').checked;
      $('filter-unpaid').dispatchEvent(new Event('change'));
      e.preventDefault();
    } else if (e.key === '?') {
      openSettings();
      e.preventDefault();
    }
  });
}

// ---------- Render ----------
function render() {
  renderList();
  renderGantt();
  renderShareBills();
  renderSelectionBar();
  rebuildNameSuggestions();
}

// ---------- Init ----------
async function init() {
  bindSetup();
  bindSettings();
  bindForm();
  bindList();
  bindGantt();
  bindShare();
  bindKeys();

  // Register service worker
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // 首次安裝不重整；只有「升級」時（先前已有 controller）才 reload
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { /* ok */ }
  }

  // Flush pending save when tab hides or page unloads (避免 debounce 500ms 內離開遺失)
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSave();
  });
  window.addEventListener('pagehide', flushPendingSave);
  window.addEventListener('beforeunload', (e) => {
    if (pendingSave) {
      flushPendingSave();
      // 提示使用者「等一下，正在同步」— 在還沒寫回時警告
      e.preventDefault();
      e.returnValue = '';
    }
  });

  const token = localStorage.getItem(LS_TOKEN);
  const gistId = localStorage.getItem(LS_GIST_ID);

  if (!token || !gistId) {
    setSyncStatus('no-token');
    openSetup();
    render();
    return;
  }

  setSyncStatus('syncing');
  try {
    state.bills = await loadGist(gistId);
    setSyncStatus('ok');
    render();
  } catch (err) {
    setSyncStatus('error');
    if (err.code === 'INVALID_TOKEN') {
      openSetup('token 無效，請重新連接');
    } else if (err.code === 'NOT_FOUND') {
      openSetup('找不到該 Gist，請重新連接');
    } else {
      toast(`載入失敗：${err.message}`, 'error');
      render();
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
