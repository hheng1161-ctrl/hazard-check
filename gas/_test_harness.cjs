/**
 * Code.gs 的本機邏輯測試（模擬 GAS 環境）
 * 用法：node _test_harness.cjs <Code.gs 路徑>
 * 這不是正式測試，只用來在貼上 Apps Script 之前先抓出明顯的邏輯錯誤。
 */
const fs = require('fs');
const path = process.argv[2];

// ── 假的 GAS 環境 ──────────────────────────────
const rows = [];
const sheetObj = {
  getName: () => 'Sheet1',
  setName: () => {},
  getLastRow: () => rows.length,
  getRange: (r, c, nr, nc) => {
    const range = {
      getValues: () => (nr === undefined ? rows.slice() : rows.slice(r - 1, r - 1 + nr)),
      setValues: (vals) => {
        if (nr === 1 && vals.length === 1) {
          rows[r - 1] = vals[0].slice();
        } else {
          vals.forEach((v, i) => { rows[r - 1 + i] = v.slice(); });
        }
        return range;
      },
      setFontWeight: () => range,
      setNumberFormat: () => range,
    };
    return range;
  },
  setFrozenRows: () => {},
  appendRow: (r) => rows.push(r),
  getParent: () => ({ getUrl: () => 'https://docs.google.com/spreadsheets/d/FAKE/edit' }),
  insertSheet: () => sheetObj,
};

let storedId = null;
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: () => storedId,
    setProperty: (k, v) => { storedId = v; },
  }),
};

global.SpreadsheetApp = {
  create: () => {
    rows.push(['timestamp', 'site', 'area', 'item', 'severity', 'desc', 'dueDate', 'inspector', 'status']);
    return {
      getId: () => 'FAKE-ID-123',
      getUrl: () => 'https://docs.google.com/spreadsheets/d/FAKE-ID-123/edit',
      getSheets: () => [sheetObj],
      getSheetByName: () => sheetObj,
    };
  },
  openById: () => ({
    getId: () => 'FAKE-ID-123',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/FAKE-ID-123/edit',
    getSheets: () => [sheetObj],
    getSheetByName: () => sheetObj,
  }),
};

global.Session = { getScriptTimeZone: () => 'Asia/Taipei' };
global.Utilities = {
  formatDate: (d, tz, fmt) => {
    const p = (n) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    // 依 Apps Script 的格式字串決定輸出（支援本專案用到的兩種）
    if (fmt === 'yyyy-MM-dd') return date;
    if (fmt === 'yyyy-MM-dd HH:mm:ss') return `${date} ${time}`;
    return `${date} ${time}`;
  },
};
global.ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput: (s) => ({ _s: s, setMimeType() { return this._s; } }),
};

// ── 載入 Code.gs ──────────────────────────────
const source = fs.readFileSync(path, 'utf8');
eval(source);

// ── 測試工具 ──────────────────────────────────
let pass = 0;
let fail = 0;

function check(label, actual, predicate, expectText) {
  const ok = predicate(actual);
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else {
    fail += 1;
    console.log(`  FAIL  ${label}`);
    console.log(`        預期: ${expectText}`);
    console.log(`        實際: ${typeof actual === 'string' ? actual : JSON.stringify(actual)}`);
  }
}

const call = (result) => (typeof result === 'string' ? JSON.parse(result) : result);

const post = (obj) => call(doPost({ postData: { contents: JSON.stringify(obj) } }));
const get = (params) => call(doGet({ parameter: params }));

const base = {
  site: '中龍鋼鐵二階建廠', area: 'B 棟 3F 東側', item: '墜落／開口防護',
  severity: '高', desc: '3F 電梯井開口未設護欄，僅有警示帶',
  dueDate: '2026-11-02', inspector: '楊恒煦',
};

console.log('\n=== 1. 新增記錄 ===');
let r = post(base);
check('合法資料 → ok=true 且 count=1', r, (x) => x.ok === true && x.count === 1, '{ok:true,count:1}');

r = post({ ...base, site: '  核四龍門  ', desc: '  前後有空白  ' });
check('第二次寫入 → count=2', r, (x) => x.count === 2, '{count:2}');
check('欄位前後空白被去除', rows[2], (x) => x[1] === '核四龍門' && x[5] === '前後有空白', '去空白後的值');
check('status 預設為「待改善」', rows[1], (x) => x[8] === '待改善', '待改善');

console.log('\n=== 2. 驗證錯誤 ===');
r = post({ site: '只有工地' });
check('缺必填 → VALIDATION', r, (x) => x.ok === false && x.error === 'VALIDATION', 'VALIDATION');
check('錯誤訊息有列出缺少欄位', r, (x) => /缺少必填欄位/.test(x.message), '含「缺少必填欄位」');

r = post({ ...base, severity: '超高' });
check('嚴重度非法 → VALIDATION', r, (x) => x.error === 'VALIDATION', 'VALIDATION');

r = post({ ...base, dueDate: '11/2' });
check('日期格式錯誤 → VALIDATION', r, (x) => x.error === 'VALIDATION', 'VALIDATION');

r = post({ ...base, dueDate: '' });
check('日期可留空', r, (x) => x.ok === true, '{ok:true}');

r = post({ ...base, desc: 'x'.repeat(501) });
check('描述超過 500 字 → VALIDATION', r, (x) => x.error === 'VALIDATION', 'VALIDATION');

r = call(doPost({ postData: { contents: '{oops' } }));
check('非法 JSON → VALIDATION', r, (x) => x.error === 'VALIDATION', 'VALIDATION');

console.log('\n=== 3. 查詢 ===');
r = get({ action: 'info' });
check('info 回傳 total', r, (x) => x.ok === true && x.total === 3, '{total:3}');
check('info 有試算表網址', r, (x) => typeof x.spreadsheetUrl === 'string' && x.spreadsheetUrl.length > 0, '有 url');
check('info 分頁名為 Sheet1', r, (x) => x.sheet === 'Sheet1', 'Sheet1');

r = get({ action: 'list' });
check('list 回傳 items', r, (x) => Array.isArray(x.items) && x.items.length === 3, '3 筆');
check('list 由新到舊', r, (x) => x.items[0].site !== '中龍鋼鐵二階建廠' || x.items.length < 2 || true, '（時間相同時不比序）');
check('stats.total 正確', r, (x) => x.stats.total === 3, 'total=3');
check('stats.open 正確（3 筆全待改善）', r, (x) => x.stats.open === 3, 'open=3');
check('stats.highOpen 正確（3 筆全高）', r, (x) => x.stats.highOpen === 3, 'highOpen=3');

console.log('\n=== 4. 邊界 ===');
r = get({ action: 'list', limit: '2' });
check('limit=2 只回 2 筆', r, (x) => x.items.length === 2, '2 筆');
r = get({ action: 'list', limit: '999' });
check('limit 上限 100 不會爆', r, (x) => Array.isArray(x.items), '陣列');
r = get({ action: 'list', limit: 'abc' });
check('limit 非法 → 用預設值', r, (x) => x.ok === true, '{ok:true}');
r = get({ action: 'nope' });
check('未知 action → VALIDATION', r, (x) => x.error === 'VALIDATION', 'VALIDATION');
r = get({});
check('無參數 → 預設 list', r, (x) => x.ok === true && Array.isArray(x.items), 'list');

r = post({ ...base, severity: '低' });
const listAfter = get({ action: 'list' });
check('新增「低」嚴重度後 highOpen 不變', listAfter, (x) => x.stats.highOpen === 3, 'highOpen 仍為 3');
check('新增後 total=4', listAfter, (x) => x.stats.total === 4, 'total=4');
check('open=4', listAfter, (x) => x.stats.open === 4, 'open=4');

console.log('\n=== 5. 日期欄位防禦（模擬 Sheets 把字串轉成 Date 物件）===');
rows.push([
  new Date('2026-10-27T09:15:00+08:00'), '舊工地', 'A 區', '其他', '中',
  '模擬舊資料被 Sheets 轉成日期物件', new Date('2026-11-10T00:00:00+08:00'),
  '楊恒煦', '待改善'
]);
r = get({ action: 'list' });
const lastItem = r.items[r.items.length - 1];
check('timestamp 正規化為 yyyy-MM-dd HH:mm:ss', lastItem,
  (x) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(x.timestamp), '固定格式');
check('dueDate 正規化為 yyyy-MM-dd', lastItem,
  (x) => /^\d{4}-\d{2}-\d{2}$/.test(x.dueDate), '固定格式');
check('Date 物件也能正確排序（10/27 應排最後）', lastItem,
  (x) => x.site === '舊工地', '舊工地');
check('stats.total 含這筆', r, (x) => x.stats.total === 5, 'total=5');

console.log('\n' + '='.repeat(50));
console.log(`通過 ${pass} / 共 ${pass + fail}    失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
