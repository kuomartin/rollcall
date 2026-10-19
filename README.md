# rollcall

以 Google 試算表為名單與紀錄的活動報到系統：掃描在本機即時判定，Apps Script 批次寫入並同步各入口。

用語見 [CONTEXT.md](CONTEXT.md)，設計決策見 [docs/adr/](docs/adr/)。

## 給主辦方

1. 複製[範本試算表](https://docs.google.com/spreadsheets/d/1a5Gwgj0JRs5ndHNk8BjRN9rrhOAJBrciu6u_tmrd-pw/edit)（「檔案 → 建立副本」）。「學員名單」分頁第 1 列是標題，必須有「學員代號」；有「手機」欄就能用手機報到。
2. 「擴充功能 → Apps Script → 部署 → 新增部署作業」，類型選網頁應用程式，執行身分「我」，存取權「所有人」。
3. 用瀏覽器開一次部署出來的網址，依指示授權，看到「已完成初始化」。
4. 回到試算表，選單「報到 → 設定」填報到成功訊息與場次，「報到 → 工作人員連結」把連結或 QR code 交給入口工作人員。

掃描頁可以用相機掃 QR code、Code 128、Code 39（學員證上的條碼內容就是學員代號），也可以接 USB 條碼槍或直接輸入學員代號或手機。

報到分頁的前 5 欄由程式寫入；之後的標題列填學員名單的欄位名稱，報到時會從名單查出填入。學員名單的「{場次} 報到時間」欄由程式維護。

### 試算表裡的其他公式

每次同步都會先讀學員名單；前一次寫入引發的重算還沒算完，這次讀取就要等，所以重的公式會拉長同步時間。報到結果在掃描頁就判定好，不受影響；變慢的是其他入口看到這筆報到的時間，以及「未送出 N 筆」清掉的時間。同步超過 10 秒只會顯示「同步延遲，照常報到」，不會禁止報到。

會拖慢同步的公式有兩種：

- 引用報到分頁或學員名單「報到時間」欄的公式，例如 `COUNTIF(報到!D:D, …)`、`QUERY(學員名單!…)`：每次同步寫入後重算，範圍越大、函式越重越慢，每一列各查一次整張表的寫法最慢。
- volatile 函式 `NOW`、`TODAY`、`RAND`、`INDIRECT`、`OFFSET`：試算表任何地方被編輯就重算，不管引用什麼。

統計、儀表板放在另一份試算表，用 `IMPORTRANGE` 讀資料，重算就發生在那一份。一定要放在同一份的話，不用 volatile 函式，範圍寫成有界的（`D2:D2000`，不寫 `D:D`），也不要每一列各查一次整張表。

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

推送 Apps Script 用 `npx clasp -P <專案檔> push`，專案檔的 `rootDir` 指向 `dist/gas/app`：

| 專案檔 | 對象 | 建置 |
|---|---|---|
| `.clasp.template.json` | 範本試算表 | `npm run build` |
| `.clasp.test.json` | 測試試算表 `rollcall-test` | `npm run build -- --dev`，多出端到端測試用的 `devSeed`／`devDump` |

兩個專案檔都不進版控。
