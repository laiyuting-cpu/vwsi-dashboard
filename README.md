# 職掘工作台

職掘／島輝國際教育的內部工作管理儀表板：部門專案（WBS）、Daily Mission、我的任務、團隊工時、夥伴說明書。

## 架構

| 部分 | 服務 |
|---|---|
| 網頁 | GitHub Pages（本儲存庫，`index.html`） |
| 資料庫、登入 | Supabase（Postgres + Google 登入 + 資料列權限） |
| 備份 | GitHub Actions 每天備份到 Google 共用雲端硬碟（`.github/workflows/backup.yml`） |

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 整個工作台介面 |
| `js/config.js` | Supabase 網址與**公開**金鑰 |
| `js/db.js` | 把 Supabase 包成工作台使用的資料介面，含即時同步 |
| `supabase/schema.sql` | 資料表、權限規則、頭貼儲存空間。可重複執行 |
| `fonts/` | 源泉圓體（SIL Open Font License）子集 |

## 權限

| 身分 | 可以 |
|---|---|
| 主管 | 看全部、修改名單／部門／範本、建立與刪除專案 |
| 部門主管 | 建立、修改、刪除自己部門的專案與任務 |
| 正職、實習 | 看全部；更新任務；編輯自己的待辦、三件事、說明書 |
| 委外 | 只看得到自己參與的專案；只能更新自己負責或協作的任務 |
| 名單外的 Google 帳號 | 什麼都看不到 |

登入後系統用 Google 帳號的 Email 對應「設定 → 成員」裡的 Email。

## 安全提醒

- `service_role`／secret 金鑰、資料庫密碼**絕對不要**放進這個儲存庫，只放在 GitHub Secrets 或 Supabase 設定。
- 這是公開儲存庫：資料匯出檔已列在 `.gitignore`，不要手動加進來。

## 還原備份

```bash
pg_restore --clean --if-exists --no-owner -d "<Supabase 連線字串>" vwsi-YYYY-MM-DD_HHMM.dump
```
