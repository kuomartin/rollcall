// 只在 `npm run build -- --dev` 的建置裡存在：讓端到端測試能建立假名單、讀回寫入結果。
// 正式建置時 __DEV__ 為 false，doPost 不會呼叫這裡，esbuild 會把整段移除。

import { saveSettings } from "./settings.ts";
import { ensureLogSheet, LOG_HEADERS, ROSTER_SHEET } from "./sheets.ts";

const DEV_HEADERS = ["學員代號", "姓名", "手機", "班級"];

function seed(count: number, sessions: string[]): unknown {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const roster = ss.getSheetByName(ROSTER_SHEET) ?? ss.insertSheet(ROSTER_SHEET, 0);
  roster.clear();
  const rows = Array.from({ length: count }, (_, i) => [
    `T${String(i + 1).padStart(4, "0")}`,
    `測試學員${i + 1}`,
    `'09${String(10_000_000 + i)}`,
    `${"甲乙丙丁"[i % 4]}班`,
  ]);
  roster.getRange(1, 1, 1, DEV_HEADERS.length).setValues([DEV_HEADERS]);
  roster.getRange(2, 1, rows.length, DEV_HEADERS.length).setValues(rows);

  for (const session of sessions) {
    const existing = ss.getSheetByName(session);
    if (existing) ss.deleteSheet(existing);
    ensureLogSheet(session).getRange(1, LOG_HEADERS.length + 1, 1, 2).setValues([["姓名", "班級"]]);
  }
  saveSettings({ template: "報到成功；姓名：{{姓名}}，班級：{{班級}}", sessions });
  PropertiesService.getScriptProperties().deleteProperty("seq");
  return { roster: count, sessions };
}

function dump(): unknown {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return Object.fromEntries(ss.getSheets().map((s) => [s.getName(), s.getDataRange().getDisplayValues().slice(0, 30)]));
}

export function devHandle(body: unknown): unknown {
  const b = body as { action?: string; count?: number; sessions?: string[] };
  if (b.action === "devSeed") return seed(b.count ?? 40, b.sessions ?? ["報到"]);
  if (b.action === "devDump") return dump();
  return undefined;
}
