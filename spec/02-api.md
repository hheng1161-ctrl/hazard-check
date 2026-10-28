# API 契約｜工地危害巡檢記錄系統

> 後端：Google Apps Script Web App（`/exec` 結尾的網址）
> 資料來源：Google Sheets 的 `Sheet1` 分頁
> 建立日期：2026-10-28

---

## 一、試算表結構（Sheet1）

第一列為表頭，順序固定（程式靠欄位順序寫入）：

| 欄 | 表頭 | 型別 | 說明 |
|---|---|---|---|
| A | `timestamp` | 字串 | 伺服器寫入時間（`yyyy-MM-dd HH:mm:ss`） |
| B | `site` | 字串 | 工地名稱 |
| C | `area` | 字串 | 區域／樓層 |
| D | `item` | 字串 | 檢查項目 |
| E | `severity` | 字串 | `高` / `中` / `低` |
| F | `desc` | 字串 | 缺失描述 |
| G | `dueDate` | 字串 | 改善期限 `YYYY-MM-DD`（可空） |
| H | `inspector` | 字串 | 巡檢人 |
| I | `status` | 字串 | `待改善` / `已改善`（新增時固定為 `待改善`，之後在 Sheets 手動改） |

---

## 二、端點

### 1. 新增巡檢記錄

```http
POST <GAS_URL>
Content-Type: text/plain;charset=utf-8
```

> **為什麼是 `text/plain` 而不是 `application/json`：**
> GAS 不支援 CORS 預檢（OPTIONS）。用 `text/plain` 送出可避免觸發預檢，
> 讓請求成為「簡單請求」直接送出。body 內容仍是 JSON 字串，由後端自行解析。

**請求 body**

```json
{
  "site": "示範工地 A",
  "area": "B 棟 3F 東側",
  "item": "墜落／開口防護",
  "severity": "高",
  "desc": "3F 電梯井開口未設護欄，僅有警示帶",
  "dueDate": "2026-11-02",
  "inspector": "示範人員"
}
```

**成功回應**

```json
{ "ok": true, "count": 42 }
```

**失敗回應**

```json
{ "ok": false, "error": "VALIDATION", "message": "site 為必填" }
```

**錯誤代碼**

| `error` | 意義 |
|---|---|
| `VALIDATION` | 必填缺漏、型別錯誤或超過長度 |
| `SHEET_NOT_READY` | 找不到試算表或 `Sheet1` 分頁 |
| `INTERNAL` | 後端未預期例外 |

### 2. 讀取最近記錄與統計

```http
GET <GAS_URL>?action=list&limit=20
```

**成功回應**

```json
{
  "ok": true,
  "items": [
    {
      "timestamp": "2026-10-28 21:40:03",
      "site": "示範工地 A",
      "area": "B 棟 3F 東側",
      "item": "墜落／開口防護",
      "severity": "高",
      "desc": "3F 電梯井開口未設護欄，僅有警示帶",
      "dueDate": "2026-11-02",
      "inspector": "示範人員",
      "status": "待改善"
    }
  ],
  "stats": {
    "total": 42,
    "open": 17,
    "highOpen": 6
  }
}
```

- `items` 依 `timestamp` **由新到舊**，最多回傳 `limit` 筆（預設 20，上限 100）
- `total` = 資料列數（不含表頭）
- `open` = `status` 為 `待改善` 的筆數
- `highOpen` = `severity` 為 `高` **且** `status` 為 `待改善` 的筆數

### 3. 健康檢查

```http
GET <GAS_URL>?action=info
```

```json
{ "ok": true, "name": "工地危害巡檢記錄", "sheet": "Sheet1", "total": 42 }
```

用於前端載入時確認後端可用；失敗時顯示明確訊息而非白畫面（對應驗收條件 A10）。

---

## 三、前端呼叫策略（重要）

GAS 的 POST 會有 302 轉址，轉址後的回應**不一定帶 CORS 標頭**，瀏覽器可能讀不到。

因此前端採用三段式：

1. `POST` 送出（`text/plain`，避免預檢）
2. 不論是否讀得到 POST 回應，**立刻 `GET ?action=info`** 重新取得 `total`
3. 若 `total` 比送出前 +1 → 視為成功；否則顯示失敗並保留表單內容

這樣即使瀏覽器擋掉 POST 的回應，也能用客觀數字判斷結果，
且符合驗收條件 A8（失敗時不遺失已填內容）。

---

## 四、安全與限制（需在頁面明示）

| 項目 | 說明 |
|---|---|
| 無身分驗證 | 知道網址者皆可寫入；建議僅供課堂展示，勿放真實工地敏感資訊 |
| 資料公開 | 若 Sheets 為「知道連結可檢視」則讀得到；本作業僅要求 GAS 以擁有者權限存取 |
| 不存個資 | 巡檢人欄位僅填姓名或代號，不填手機、身分證等 |

---

## 變更紀錄

| 日期 | 內容 |
|---|---|
| 2026-10-28 | 建立 API 契約（對應 `01-spec.md`） |
