# rollcall

以 Google 試算表為名單與紀錄的活動報到系統：掃描在本機即時判定，Apps Script 批次寫入並同步各入口。

設計與決策見 [PLAN.md](PLAN.md)。

## 給主辦方

1. 複製範本試算表。「學員名單」分頁第 1 列是標題，必須有「學員代號」；有「手機」欄就能用手機報到。
2. 「擴充功能 → Apps Script → 部署 → 新增部署作業」，類型選網頁應用程式，執行身分「我」，存取權「所有人」。
3. 用瀏覽器開一次部署出來的網址，依指示授權，看到「已完成初始化」。
4. 回到試算表，選單「報到 → 設定」填報到成功訊息與場次，「報到 → 工作人員連結」把連結或 QR code 交給入口工作人員。

報到分頁的前 5 欄由程式寫入；之後的標題列填學員名單的欄位名稱，報到時會從名單查出填入。學員名單的「{場次} 報到時間」欄由程式維護。

## 結構

| 目錄 | 內容 |
|---|---|
| `core/` | 純 TypeScript 領域邏輯：模板、名單快取、同步、請求驗證。不依賴 Apps Script 或 DOM，用 `node --test` 測 |
| `gas/app/` | 綁定範本試算表的 Apps Script：Web App API、選單、側邊欄 |
| `web/` | 掃描頁，GitHub Pages 提供（`main` 推送後由 `.github/workflows/pages.yml` 部署） |
| `scripts/build.ts` | esbuild 打包，輸出到 `dist/` |

Apps Script 只認得頂層函式，所以建置時會替 `gas/app/main.ts` export 的每個函式，在檔尾補一個同名的頂層函式。

## 指令

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run build
```

`npm run build -- --dev` 多出端到端測試用的 `devSeed`／`devDump` 動作，只推到測試試算表，不要推到正式範本。推送用 `npx clasp push`，`.clasp.json` 的 `rootDir` 指向 `dist/gas/app`。
