# rollcall

以 Google 試算表為名單與紀錄的活動報到系統：掃描在本機即時判定，Apps Script 批次寫入並同步各入口。

設計與進度見 [PLAN.md](PLAN.md)。

## 結構

| 目錄 | 內容 |
|---|---|
| `core/` | 純 TypeScript 領域邏輯，不依賴 Apps Script 或 DOM，用 `node --test` 測 |
| `gas/central/` | 集中 Web App（`doGet`／`doPost`），只部署一次 |
| `gas/shim/` | 範本試算表綁定的薄殼：選單、側邊欄、自動跳轉，不部署 |
| `web/` | 掃描頁，GitHub Pages 提供 |
| `scripts/build.ts` | esbuild 打包，輸出到 `dist/` |

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

Apps Script 只認得頂層函式，所以建置時會替 `gas/*/main.ts` export 的每個函式，在檔尾補一個同名的頂層函式。
