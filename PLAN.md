# 報到系統重寫計畫

目標：掃描即時回應（本機判定），GAS 為唯一寫入者並批次同步，各入口約 3 秒內互相看見，斷線禁止報到。合併 reg_dev 的名單查表與 qrgate 的分層架構。

## 0. 驗證

量測環境：兩份試算表副本，學員名單 800 人、「5/22報到」600 筆；以網頁應用程式執行。工具：`bench/Bench.js`、`bench/run.sh`。

| # | 項目 | 無公式 | 有公式 1＋2 | 結論 |
|---|---|---|---|---|
| 0.1 | 單一裝置連續 10 筆，每筆總耗時 p50 / p95 | 967 / 1599 ms | 2193 / 3477 ms | 公式讓單筆耗時約 2 倍，多出來的主要在讀取時等重算（`read` 410 → 1434 ms） |
| 0.2 | 8 台裝置併發各 3 筆，走真正的 `checkInStudent`（含 lock），每筆耗時 | 0.9–3.0 s，全部跑完 9 s | 1.0–14.9 s，全部跑完 37 s | **30 秒延遲的成因：公式重算 × lock 排隊。** 拿掉公式後，併發下仍維持 1–3 s。§5 照計畫移除 |
| 0.3 | 沒有公式時的基本成本 | 約 1 s／筆 | — | 即使沒有公式，每筆仍約 1 秒，所以 §3 的批次寫入與 §4 的前端先回應仍然必要 |
| 0.4 | `fetch` → `doPost` 可行性 | 桌機 Chromium 152、Android Brave（Chromium 155）：POST `text/plain` 讀回 JSON 約 1.2 s、GET 800 列名單（33.9 KB）約 1.0–1.2 s、連續 POST 每次 0.8–1.0 s、3 次併發全部成功 | — | Chromium 系列可行，§4.4 採用；iOS Safari 尚未驗證，測試頁 `spike/fetch-dopost/` |

## 1. Repo 與建置

| # | 項目 | 現況 | 改成 | 理由 |
|---|---|---|---|---|
| 1.0 | Repo | reg_dev、qrgate 各自一個 | 新開一個 repo | 舊 repo 保留給既有活動，見 6.3 |
| 1.1 | 結構 | reg_dev 單層；qrgate 有 `src/` 但 GAS 端手抄一份 | `core/`、`gas/central/`（集中 Web App）、`gas/shim/`（每份試算表綁定的薄殼）、`web/`（掃描頁） | 分層沿用 qrgate，core 可在 Node 測 |
| 1.1a | 語言 | JS | TypeScript；esbuild 轉譯並打包 | 已經有建置步驟，加 TS 幾乎沒有額外成本 |
| 1.2 | core 進 GAS | `apps-script/Ticket.js` 手動同步 `src/ticket.js` | esbuild 把 `core/` 打包進 `gas/central` 的單一檔案，`clasp push` | 測試的程式碼就是部署的程式碼 |
| 1.3 | 平台差異 | `node:crypto` vs `Utilities` | core 只依賴 `random`/`clock` port，兩端各給 adapter | 唯一真的不同的地方 |
| 1.4 | 測試 | qrgate 有 `node --test` | core 全部用 fake store 測（`node --test` 跑 esbuild 產物或 `tsx`）；GAS adapter 手動驗 | 同 qrgate |

## 2. 領域模型（core）

| # | 概念 | 定義 | 備註 |
|---|---|---|---|
| 2.1 | Attendee | 名單一列；識別欄位 `學員代號`、`手機` | 沿用 reg_dev 工作表規範 |
| 2.2 | Session | 一個報到分頁 | 沿用「多分頁」設定 |
| 2.3 | Scan | `{scanId, code, session, deviceId, at, snapshot}` | `scanId` 由前端產生（UUID），重送冪等 |
| 2.4 | Check-in log | append-only，一筆 Scan 一列 | 允許重複報到；不做嚴格單次使用 |
| 2.5 | 回應訊息 | `{{欄位}}` 模板，前端用名單快取渲染 | 不再等 server |
| 2.5a | 模板驗證 | 儲存模板時比對學員名單標題，未知的 `{{欄位}}` 擋下並列出 | 現在未知欄位會原樣顯示，例如「序號：{{序號}}」 |
| 2.5b | 渲染時欄位缺值 | 欄位存在但該列是空的 → 代入空字串 | 不會出現 `{{…}}` 字樣 |
| 2.6 | 單次使用 | 不做；預留「本機已見過即提示」 | 嚴格單次需 consensus，已決定不需要 |

## 3. 同步協定（GAS 為同步中心）

| # | 項目 | 設計 | 理由 |
|---|---|---|---|
| 3.1 | 上傳 | 每 3 秒或佇列滿 N 筆：`POST {deviceId, cursor, scans[]}` | 5–10 台 ≈ 每秒 3 次呼叫，同時執行數約 3–4，遠低於上限 30 |
| 3.2 | 寫入 | 取 lock → 依 `scanId` 去重 → 一次 `setValues` 寫 log → 更新學員名單的「{場次} 報到時間」欄 → 放 lock | 一批一次寫入，取代逐筆 `appendRow` |
| 3.3 | 去重 | 近期 `scanId` 存 `CacheService`；cache miss 時 `TextFinder` 查 log 的 scanId 欄 | 重送冪等 |
| 3.4 | 回傳 | `{cursor', scans since cursor（其他裝置）, rosterVersion}` | 一次呼叫同時滿足「寫入」與「看見別人」 |
| 3.5 | cursor | log 的單調遞增 `seq` 欄，不用列號 | 工作人員刪列時不會錯位 |
| 3.6 | 閒置 | 佇列空時改每 10 秒同步一次 | 只為拉別人的紀錄 |
| 3.7 | 傳輸 port | `SyncTransport.sync(request) → response` | P2P 日後換 adapter，不動 core |

## 4. 前端

| # | 項目 | 設計 | 理由 |
|---|---|---|---|
| 4.1 | 名單快取 | 開頁 `GET roster` 一次；`rosterVersion` 變了重抓 | 本機比對 0ms |
| 4.1a | 快取內容 | `學員代號` ＋ 模板引用到的欄位，由 server 解析模板決定；**不含 `手機`** | 模板改了，`rosterVersion` 跟著遞增 |
| 4.1b | 模板引用 `{{手機}}` | 快取只放遮罩後的值（例如 `09xx-xxx-123`） | 手機號碼不外流 |
| 4.1c | 用手機報到 | 本機查無 → server 查詢 → 回傳該列的快取欄位 → 渲染並補進快取 | 只有這種報到要等約 1 秒 |
| 4.2 | 名單版本 | 集中 Web App 對每份已註冊的試算表建立 installable `onEdit` trigger，觸發時遞增該活動的 `rosterVersion` | 名單現場被改也會同步 |
| 4.3 | 本機查無 | 退回 server 查一次，查到補進快取 | 名單過時的保險 |
| 4.4 | 傳輸 | `fetch` → `doPost`，移除 Bridge iframe（0.4；iOS Safari 待驗證） | 少一層 handshake 與重複轉接碼 |
| 4.5 | 佇列 | 記憶體佇列；畫面顯示未送出筆數 | 斷網不報到，不需 IndexedDB |
| 4.6 | 斷線規則 | 最近一次同步「失敗」或（>10 秒無回應且 `navigator.onLine === false`）→ 禁止報到；只是慢 → 顯示「同步延遲」照常報到 | 避免偶發慢回應誤鎖入口 |
| 4.7 | 側邊欄 | shim 的選單開啟側邊欄，以 iframe 嵌入掃描頁（帶活動 token） | 側邊欄和手機用同一份掃描頁 |
| 4.8 | 側邊欄自動跳轉 | 掃描頁對 iframe 外層 `postMessage` 學員代號 → shim 用 `google.script.run` 去 `activate()` 那一列；等同步確認後才跳 | `activate()` 只能在綁定的 script 裡執行 |

## 5. 試算表結構

| # | 項目 | 現況 | 改成 | 依賴 |
|---|---|---|---|---|
| 5.1 | 報到分頁 | A 代號、B 時間，後面接公式 2 | `seq, scanId, 時間, 代號, deviceId, 快照欄位…`，無公式 | 0.2 已確認 |
| 5.2 | 公式 2（展開學員資料） | 每筆報到 `MATCH`＋`XLOOKUP`，`QUERY` 掃 `A:ZZZ` | 刪除，改寫入快照 | 0.2 已確認 |
| 5.3 | 公式 1（最近報到時間） | `INDIRECT`（volatile）＋每列 `QUERY` | 刪除，由 3.2 寫回學員名單；該欄由程式維護 | 0.2 已確認 |
| 5.4 | 設定 | 每份 script 的 Script Properties：`msgTemplate`、`checkInSheets` | 集中 Web App 的 Script Properties，以活動為 key：`{sheetId, token, msgTemplate, sessions, rosterVersion}` | — |

## 6. 遷移

| # | 項目 | 做法 |
|---|---|---|
| 6.1 | 既有活動 | 舊版不動；新活動用新版 |
| 6.2 | 部署 | 集中 Web App 只部署一次（`executeAs: USER_DEPLOYING`、`ANYONE_ANONYMOUS`）。新活動：複製範本試算表（內含 shim，shim 不需要部署）→ 選單「註冊活動」→ shim 把 sheet ID 送到集中 Web App → 回傳活動 token 和工作人員連結＋QR |
| 6.2a | 存取控制 | 活動 token 放在掃描頁網址的 hash；token 等於權限 | 沿用 qrgate ADR-0002，連結即權限 |
| 6.3 | 收尾 | 新版上線後 reg_dev、qrgate archive，qrgate 的 `CONTEXT.md`／ADR 搬入新 repo 並改寫 |

## 已決定

| # | 問題 | 決定 |
|---|---|---|
| D1 | 部署模式 | 集中一份 Web App，以 sheet ID＋token 註冊活動（6.2） |
| D2 | Repo | 新開 |
| D3 | 手機號碼 | 不進前端快取，用手機報到時走 server（4.1a–4.1c） |
| D4 | 語言 | TypeScript（1.1a） |
