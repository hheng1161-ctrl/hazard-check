/**
 * 工地危害巡檢記錄系統 — Google Apps Script 後端
 *
 * 對應文件：
 *   spec/01-spec.md（規格）
 *   spec/02-api.md（API 契約）
 *
 * 使用方式：
 *   1. 貼進 script.google.com 新專案的「程式碼.gs」
 *   2. 部署 → 新增部署作業 → 網頁應用程式
 *   3. 執行身分：我　　存取權：任何人
 *   4. 第一次被呼叫時會自動建立 Google 試算表與表頭
 *
 * 端點：
 *   GET  ?action=info            健康檢查（含版本號）
 *   GET  ?action=list&limit=20   讀取最近記錄 + 統計
 *   GET  ?action=reset&confirm=RESET   一次性維護：清空資料列並寫入虛構示範資料
 *   POST <body 為 JSON>           新增一筆巡檢記錄
 */

// ─────────────────────────── 設定 ───────────────────────────

const SHEET_NAME = 'Sheet1';
const SHEET_TITLE = '工地危害巡檢記錄';
const PROP_KEY = 'SPREADSHEET_ID';

const HEADERS = [
  'timestamp', 'site', 'area', 'item', 'severity',
  'desc', 'dueDate', 'inspector', 'status'
];

const MAX_LEN = {
  site: 50,
  area: 50,
  item: 50,
  desc: 500,
  inspector: 30
};

const SEVERITIES = ['高', '中', '低'];
const DEFAULT_STATUS = '待改善';
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

// 版本號（改版時遞增，用來確認線上部署的是哪一版）
const CODE_VERSION = '2（含一次性資料重建）';

// 一次性維護指令：清空資料列並寫入虛構示範資料
const RESET_CONFIRM = 'RESET';
const RESET_FLAG = 'RESET_DONE_AT';

// 示範資料（全部虛構，工地名稱一律用代稱，不對應任何真實公司或專案）
const DEMO_ROWS = [
  { hoursAgo: 2,  site: '示範工地 A', area: 'A 棟 3F 東側', item: '墜落／開口防護',
    severity: '高', desc: '電梯井開口未設護欄，僅有警示帶', dueInDays: 3,  inspector: '示範人員' },
  { hoursAgo: 26, site: '示範工地 A', area: 'B 棟 1F 配電區', item: '感電與臨時用電',
    severity: '中', desc: '臨時電箱未上鎖，電纜拖地', dueInDays: 5,  inspector: '示範人員' },
  { hoursAgo: 50, site: '示範工地 B', area: '北側圍籬', item: '警示標示與圍籬',
    severity: '低', desc: '部分警示帶脫落', dueInDays: null, inspector: '示範人員' },
  { hoursAgo: 76, site: '示範工地 C', area: '材料堆置區', item: '物體飛落／堆置',
    severity: '中', desc: '鋼材堆置超過 1.8 公尺且未固定', dueInDays: 7, inspector: '示範人員' }
];

// ─────────────────────────── 進入點 ───────────────────────────

function doGet(e) {
  return guard_(function () {
    const p = (e && e.parameter) || {};
    const action = p.action || 'list';

    if (action === 'info') return info_();
    if (action === 'list') return list_(clampLimit_(p.limit));
    if (action === 'reset') return reset_(p);

    throw new Error('VALIDATION: 未知的 action：' + action);
  });
}

function doPost(e) {
  return guard_(function () {
    const body = parseBody_(e);
    const checked = validate_(body);
    if (checked.error) throw new Error('VALIDATION: ' + checked.error);

    const sheet = sheet_();
    const total = append_(sheet, checked.value);
    return { ok: true, count: total };
  });
}

// ─────────────────────────── 錯誤處理 ───────────────────────────

function guard_(fn) {
  try {
    return json_(fn());
  } catch (err) {
    const message = String((err && err.message) || err);
    const error = message.indexOf('VALIDATION:') === 0 ? 'VALIDATION'
      : message.indexOf('SHEET_NOT_READY:') === 0 ? 'SHEET_NOT_READY'
        : 'INTERNAL';
    return json_({
      ok: false,
      error: error,
      message: message.replace(/^(VALIDATION|SHEET_NOT_READY):\s*/, '')
    });
  }
}

function json_(obj) {
  const payload = obj && obj.ok === undefined ? { ok: true, data: obj } : obj;
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────── 解析與驗證 ───────────────────────────

function parseBody_(e) {
  const raw = (e && e.postData && e.postData.contents) || '';
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error('VALIDATION: 請求內容不是合法 JSON');
    }
  }
  // 退回表單編碼
  if (e && e.parameter) return e.parameter;
  throw new Error('VALIDATION: 沒有收到任何內容');
}

function validate_(body) {
  const v = {};
  const missing = [];
  const tooLong = [];

  ['site', 'area', 'item', 'inspector'].forEach(function (key) {
    const value = body[key] === undefined || body[key] === null ? '' : String(body[key]).trim();
    if (!value) missing.push(key);
    else if (value.length > MAX_LEN[key]) tooLong.push(key + '（上限 ' + MAX_LEN[key] + ' 字）');
    v[key] = value;
  });

  const desc = body.desc === undefined || body.desc === null ? '' : String(body.desc).trim();
  if (!desc) missing.push('desc');
  else if (desc.length > MAX_LEN.desc) tooLong.push('desc（上限 ' + MAX_LEN.desc + ' 字）');
  v.desc = desc;

  const severity = body.severity === undefined ? '' : String(body.severity).trim();
  if (!severity) missing.push('severity');
  else if (SEVERITIES.indexOf(severity) === -1) {
    throw new Error('VALIDATION: severity 只能是 高 / 中 / 低');
  }
  v.severity = severity;

  let dueDate = body.dueDate === undefined || body.dueDate === null ? '' : String(body.dueDate).trim();
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new Error('VALIDATION: dueDate 格式須為 YYYY-MM-DD');
  }
  v.dueDate = dueDate;

  if (missing.length) {
    throw new Error('VALIDATION: 缺少必填欄位：' + missing.join('、'));
  }
  if (tooLong.length) {
    throw new Error('VALIDATION: 欄位過長：' + tooLong.join('、'));
  }

  return { value: v };
}

// ─────────────────────────── 試算表存取 ───────────────────────────

function spreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(PROP_KEY);

  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (err) {
      throw new Error('SHEET_NOT_READY: 無法開啟試算表（ID: ' + id + '）');
    }
  }

  // 第一次執行：自動建立試算表與表頭
  const ss = SpreadsheetApp.create(SHEET_TITLE);
  const first = ss.getSheets()[0];
  first.setName(SHEET_NAME);
  first.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  first.setFrozenRows(1);
  props.setProperty(PROP_KEY, ss.getId());
  return ss;
}

function sheet_() {
  const ss = spreadsheet_();
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function append_(sheet, v) {
  const now = Utilities.formatDate(
    new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'
  );

  const nextRow = sheet.getLastRow() + 1;
  const range = sheet.getRange(nextRow, 1, 1, HEADERS.length);

  // 先把整列的數字格式設為「純文字」再寫入。
  // 否則 Google Sheets 會把 '2026-10-28 21:43:44' 與 '2026-11-02' 自動轉成日期物件，
  // 讀回來變成 "Wed Oct 28 2026 ..." 這種字串，導致「由新到舊」的排序用星期字首比較而排錯。
  range.setNumberFormat('@');
  range.setValues([[
    now, v.site, v.area, v.item, v.severity,
    v.desc, v.dueDate, v.inspector, DEFAULT_STATUS
  ]]);

  return Math.max(0, sheet.getLastRow() - 1);
}

// ─────────────────────────── 查詢 ───────────────────────────

function clampLimit_(raw) {
  const n = parseInt(raw, 10);
  if (isNaN(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function cellText_(value, columnIndex) {
  // 防禦性處理：即使資料已被 Sheets 轉成日期物件，讀取時也一律轉回固定格式字串。
  if (value instanceof Date) {
    const pattern = columnIndex === 0 ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd';
    return Utilities.formatDate(value, Session.getScriptTimeZone(), pattern);
  }
  return String(value === null || value === undefined ? '' : value);
}

function readRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, HEADERS.length).getValues()
    .map(function (row) {
      const obj = {};
      HEADERS.forEach(function (key, i) { obj[key] = cellText_(row[i], i); });
      return obj;
    })
    .filter(function (row) { return row.timestamp.trim() !== ''; });
}

function stats_(rows) {
  let open = 0;
  let highOpen = 0;
  rows.forEach(function (r) {
    if (r.status === DEFAULT_STATUS) {
      open += 1;
      if (r.severity === '高') highOpen += 1;
    }
  });
  return { total: rows.length, open: open, highOpen: highOpen };
}

function list_(limit) {
  const rows = readRows_(sheet_());
  const sorted = rows.slice().sort(function (a, b) {
    return a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0;
  });
  return { ok: true, items: sorted.slice(0, limit), stats: stats_(rows) };
}

// ─────────────────────────── 一次性資料重建（維護用） ───────────────────────────

/**
 * 清空所有資料列並寫入虛構示範資料。
 * 僅允許執行一次（用 Script Property 記錄），避免公開端點被誤用成「清空資料」。
 */
function reset_(params) {
  if (String((params && params.confirm) || '') !== RESET_CONFIRM) {
    throw new Error('VALIDATION: 需要 confirm=RESET 才能執行');
  }

  const props = PropertiesService.getScriptProperties();
  const doneAt = props.getProperty(RESET_FLAG);
  if (doneAt) {
    throw new Error('VALIDATION: 已於 ' + doneAt + ' 執行過，為避免誤刪僅允許一次。'
      + '若確需重跑，請至 Apps Script「專案設定 → 指令碼屬性」刪除 ' + RESET_FLAG);
  }

  const sheet = sheet_();
  const last = sheet.getLastRow();
  const removed = Math.max(0, last - 1);
  if (removed > 0) sheet.deleteRows(2, removed);

  const seeded = seedDemo_(sheet);
  const at = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  props.setProperty(RESET_FLAG, at);

  return { ok: true, removed: removed, seeded: seeded, at: at };
}

function seedDemo_(sheet) {
  const tz = Session.getScriptTimeZone();
  const nowMs = Date.now();

  const values = DEMO_ROWS.map(function (d) {
    const ts = Utilities.formatDate(
      new Date(nowMs - d.hoursAgo * 3600 * 1000), tz, 'yyyy-MM-dd HH:mm:ss'
    );
    const due = d.dueInDays === null || d.dueInDays === undefined ? ''
      : Utilities.formatDate(new Date(nowMs + d.dueInDays * 24 * 3600 * 1000), tz, 'yyyy-MM-dd');
    return [ts, d.site, d.area, d.item, d.severity, d.desc, due, d.inspector, DEFAULT_STATUS];
  });

  const range = sheet.getRange(2, 1, values.length, HEADERS.length);
  range.setNumberFormat('@');
  range.setValues(values);
  return values.length;
}

function info_() {
  const sheet = sheet_();
  const ss = sheet.getParent();
  const total = Math.max(0, sheet.getLastRow() - 1);
  return {
    ok: true,
    version: CODE_VERSION,
    name: SHEET_TITLE,
    sheet: SHEET_NAME,
    total: total,
    spreadsheetUrl: ss.getUrl()
  };
}
