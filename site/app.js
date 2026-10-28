/**
 * 工地危害巡檢記錄 — 前端
 *
 * 對應規格：spec/01-spec.md、spec/02-api.md
 *
 * 後端是 Google Apps Script。它的 POST 會 302 轉址，轉址後的回應不一定帶 CORS 標頭，
 * 瀏覽器可能讀不到。因此送出流程採「三段式」：
 *   1. POST（Content-Type: text/plain，避免觸發 CORS 預檢）
 *   2. 不論讀不讀得到回應，立刻 GET ?action=info 取 total
 *   3. total 比送出前 +1 → 視為成功（客觀數字佐證）
 */

// ─────────────────────── 設定 ───────────────────────

const CONFIG = {
  // Google Apps Script Web App 網址（部署 → 管理部署作業 裡取得）
  endpoint: 'https://script.google.com/macros/s/AKfycbxUjwhCX2BO9jqZ_26XyQp2zisKmCA8fIsnUfv0-CenSpMjrvFI6X7bRTvEP9CBiB7y/exec',

  listLimit: 20,

  // 檢查項目（要增刪改，改這裡就好）
  checkItems: [
    '墜落／開口防護',
    '施工架與支撐',
    '感電與臨時用電',
    '物體飛落／堆置',
    '機械設備與防護罩',
    '火災爆炸（易燃物、動火作業）',
    '缺氧／中毒（局限空間）',
    '個人防護具（PPE）',
    '警示標示與圍籬',
    '交通與動線',
    '環境衛生',
    '其他',
  ],

  // 工地名稱建議（可留空；使用者實際填過的名稱也會自動加入）
  siteSuggestions: [],

  maxLen: { site: 50, area: 50, desc: 500, inspector: 30 },
};

// ─────────────────────── DOM ───────────────────────

const $ = (sel) => document.querySelector(sel);

const el = {
  form: $('#inspection-form'),
  item: $('#f-item'),
  siteList: $('#site-list'),
  submitBtn: $('#submit-btn'),
  formMsg: $('#form-message'),
  desc: $('#f-desc'),
  descCount: $('#desc-count'),
  status: $('#backend-status'),
  records: $('#record-list'),
  listEmpty: $('#list-empty'),
  listError: $('#list-error'),
  refreshBtn: $('#refresh-btn'),
  template: $('#record-template'),
  stats: {
    total: $('#stat-total'),
    open: $('#stat-open'),
    high: $('#stat-high'),
  },
};

let lastKnownTotal = null;

// ─────────────────────── API ───────────────────────

async function apiGet(params = {}) {
  const url = new URL(CONFIG.endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('t', Date.now()); // 避免快取

  const res = await fetch(url.toString(), {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPost(payload) {
  // text/plain：讓請求成為「簡單請求」，不觸發 GAS 不支援的 CORS 預檢
  const res = await fetch(CONFIG.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });

  // 可能讀不到（CORS），交由呼叫端用 GET 佐證
  try {
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ─────────────────────── 初始化 ───────────────────────

function populateOptions() {
  CONFIG.checkItems.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    el.item.appendChild(opt);
  });
  refreshSiteSuggestions(CONFIG.siteSuggestions);
}

function refreshSiteSuggestions(extra = []) {
  const names = new Set(CONFIG.siteSuggestions);
  extra.forEach((n) => { if (n) names.add(n); });

  el.siteList.textContent = '';
  names.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    el.siteList.appendChild(opt);
  });
}

function setStatus(state, text) {
  el.status.className = `status status--${state}`;
  el.status.querySelector('.status-text').textContent = text;
}

// ─────────────────────── 後端檢查 ───────────────────────

async function checkBackend() {
  setStatus('idle', '檢查後端…');
  try {
    const info = await apiGet({ action: 'info' });
    if (!info.ok) throw new Error(info.message || info.error || '後端回應異常');
    lastKnownTotal = typeof info.total === 'number' ? info.total : null;
    setStatus('ok', '後端正常');
    return true;
  } catch (err) {
    setStatus('bad', '後端未就緒');
    showListError(`無法連線到後端（${err.message}）。請確認 Apps Script 已部署，且存取權設為「任何人」。`);
    return false;
  }
}

// ─────────────────────── 列表 ───────────────────────

function showListError(text) {
  el.listError.textContent = text;
  el.listError.hidden = false;
}

function clearListError() {
  el.listError.textContent = '';
  el.listError.hidden = true;
}

function severityClass(sev) {
  return sev === '高' ? 'record--high' : sev === '中' ? 'record--mid' : 'record--low';
}

function renderRecords(items) {
  el.records.textContent = '';
  el.listEmpty.hidden = items.length > 0;

  items.forEach((row) => {
    const node = el.template.content.cloneNode(true);
    const li = node.querySelector('.record');

    li.classList.add(severityClass(row.severity));
    node.querySelector('.record-sev').textContent = row.severity || '—';
    node.querySelector('.record-site').textContent = row.site || '—';
    node.querySelector('.record-time').textContent = row.timestamp || '';
    node.querySelector('.record-area').textContent = row.area ? `位置：${row.area}` : '';
    node.querySelector('.record-item').textContent = row.item || '';
    node.querySelector('.record-desc').textContent = row.desc || '';
    node.querySelector('.record-foot').textContent = [
      `巡檢人：${row.inspector || '—'}`,
      `狀態：${row.status || '—'}`,
      row.dueDate ? `改善期限：${row.dueDate}` : '改善期限：未填',
    ].join('　·　');

    el.records.appendChild(node);
  });
}

function renderStats(stats) {
  if (!stats) return;
  el.stats.total.textContent = stats.total ?? '—';
  el.stats.open.textContent = stats.open ?? '—';
  el.stats.high.textContent = stats.highOpen ?? '—';
  lastKnownTotal = typeof stats.total === 'number' ? stats.total : lastKnownTotal;
}

async function loadRecords() {
  clearListError();
  try {
    const data = await apiGet({ action: 'list', limit: String(CONFIG.listLimit) });
    if (!data.ok) throw new Error(data.message || data.error || '讀取失敗');

    renderStats(data.stats);
    renderRecords(Array.isArray(data.items) ? data.items : []);
    refreshSiteSuggestions((data.items || []).map((r) => r.site));
    setStatus('ok', '後端正常');
  } catch (err) {
    showListError(`讀取記錄失敗（${err.message}）。可稍後按「重新整理」再試。`);
    setStatus('bad', '讀取失敗');
  }
}

// ─────────────────────── 表單驗證 ───────────────────────

function fieldError(name, message) {
  const target = document.querySelector(`[data-error-for="${name}"]`);
  if (target) target.textContent = message || '';
  const input = el.form.elements[name];
  if (input && input.setAttribute && message) input.setAttribute('aria-invalid', 'true');
  else if (input && input.removeAttribute) input.removeAttribute('aria-invalid');
}

function clearAllErrors() {
  el.form.querySelectorAll('[data-error-for]').forEach((p) => { p.textContent = ''; });
  el.form.querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
}

function readForm() {
  const data = new FormData(el.form);
  return {
    site: (data.get('site') || '').trim(),
    area: (data.get('area') || '').trim(),
    item: (data.get('item') || '').trim(),
    severity: (data.get('severity') || '').trim(),
    desc: (data.get('desc') || '').trim(),
    dueDate: (data.get('dueDate') || '').trim(),
    inspector: (data.get('inspector') || '').trim(),
  };
}

function validate(payload) {
  clearAllErrors();
  let ok = true;

  const required = [
    ['site', '請填寫工地／專案名稱'],
    ['area', '請填寫區域或位置'],
    ['item', '請選擇檢查項目'],
    ['severity', '請選擇嚴重度'],
    ['desc', '請描述缺失內容'],
    ['inspector', '請填寫巡檢人'],
  ];

  required.forEach(([name, message]) => {
    if (!payload[name]) { fieldError(name, message); ok = false; }
  });

  Object.entries(CONFIG.maxLen).forEach(([name, max]) => {
    if (payload[name] && payload[name].length > max) {
      fieldError(name, `最多 ${max} 字（目前 ${payload[name].length} 字）`);
      ok = false;
    }
  });

  if (payload.dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(payload.dueDate)) {
    fieldError('dueDate', '日期格式須為 YYYY-MM-DD');
    ok = false;
  }

  return ok;
}

// ─────────────────────── 送出 ───────────────────────

function showFormMessage(text, type) {
  el.formMsg.textContent = text;
  el.formMsg.className = `message message--${type}`;
}

function clearFormMessage() {
  el.formMsg.textContent = '';
  el.formMsg.className = 'message';
}

function setSubmitting(busy) {
  el.submitBtn.disabled = busy;
  el.submitBtn.textContent = busy ? '送出中…' : '送出記錄';
}

async function handleSubmit(event) {
  event.preventDefault();
  clearFormMessage();

  const payload = readForm();
  if (!validate(payload)) {
    showFormMessage('還有欄位需要修正，請看紅字提示。', 'error');
    return;
  }

  const before = lastKnownTotal;
  setSubmitting(true);

  try {
    const posted = await apiPost(payload);

    // 情況一：讀得到 POST 回應
    if (posted && posted.ok === true) {
      finishSuccess(payload, posted.count);
      return;
    }
    if (posted && posted.ok === false) {
      throw new Error(posted.message || posted.error || '後端拒絕此筆資料');
    }

    // 情況二：讀不到回應（CORS）→ 用 GET 取 total 佐證
    const info = await apiGet({ action: 'info' });
    const after = typeof info.total === 'number' ? info.total : null;

    if (after !== null && before !== null && after === before + 1) {
      finishSuccess(payload, after);
    } else if (after !== null && before === null) {
      // 送出前沒有基準值，無法比對；保守回報「已送出，請確認列表」
      showFormMessage('已送出。請看下方「最近記錄」確認是否成功。', 'ok');
      await loadRecords();
    } else {
      throw new Error('後端未確認寫入成功');
    }
  } catch (err) {
    showFormMessage(`送出失敗：${err.message}。已填內容保留，可修正後重試。`, 'error');
  } finally {
    setSubmitting(false);
  }
}

function finishSuccess(payload, count) {
  showFormMessage(
    `已新增一筆記錄${typeof count === 'number' ? `（目前共 ${count} 筆）` : ''}。資料已寫入 Google Sheets。`,
    'ok'
  );

  // 只清空內容欄位，保留「巡檢人」與「工地」，方便連續填寫
  ['area', 'item', 'desc', 'dueDate'].forEach((name) => {
    const field = el.form.elements[name];
    if (!field) return;
    if (field.type === 'radio') return;
    field.value = '';
  });
  el.form.querySelectorAll('input[name="severity"]').forEach((r) => { r.checked = false; });
  el.descCount.textContent = '0';
  clearAllErrors();

  lastKnownTotal = typeof count === 'number' ? count : lastKnownTotal;
  loadRecords();
}

// ─────────────────────── 事件綁定 ───────────────────────

function bindEvents() {
  el.form.addEventListener('submit', handleSubmit);

  el.desc.addEventListener('input', () => {
    el.descCount.textContent = String(el.desc.value.length);
  });

  el.form.addEventListener('reset', () => {
    setTimeout(() => {
      clearAllErrors();
      clearFormMessage();
      el.descCount.textContent = '0';
    }, 0);
  });

  el.refreshBtn.addEventListener('click', loadRecords);

  // 失去焦點時即時檢查必填（提升體驗，不取代送出時的驗證）
  el.form.querySelectorAll('input[required], select[required], textarea[required]').forEach((field) => {
    field.addEventListener('blur', () => {
      if (field.type === 'radio') return;
      if (!field.value.trim()) return; // 空值留給送出時統一回報
      field.removeAttribute('aria-invalid');
      const hint = document.querySelector(`[data-error-for="${field.name}"]`);
      if (hint) hint.textContent = '';
    });
  });
}

async function init() {
  populateOptions();
  bindEvents();

  if (!CONFIG.endpoint || !/^https?:\/\//.test(CONFIG.endpoint)) {
    setStatus('bad', '未設定後端');
    showListError('尚未設定後端網址（app.js 最上方的 CONFIG.endpoint）。');
    return;
  }

  const ok = await checkBackend();
  if (ok) await loadRecords();
}

document.addEventListener('DOMContentLoaded', init);
