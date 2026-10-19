// 第一次開啟時建立分頁結構：範本和主辦方的副本都不需要手動建分頁。

import { CODE_FIELD, PHONE_FIELD } from "../../core/roster.ts";
import { getSettings } from "./settings.ts";
import { ensureLogSheet, ROSTER_SHEET } from "./sheets.ts";
import { ensureMarkColumns } from "./store.ts";

export function ensureWorkbook(): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(ROSTER_SHEET)) return;

  const roster = ss.insertSheet(ROSTER_SHEET, 0);
  roster.getRange(1, 1, 1, 3).setValues([[CODE_FIELD, "姓名", PHONE_FIELD]]);
  // 純文字格式：學員代號的開頭 0、手機的開頭 0 才不會被吃掉。
  roster.getRange("A:A").setNumberFormat("@");
  roster.getRange("C:C").setNumberFormat("@");
  roster.setFrozenRows(1);

  const { sessions } = getSettings();
  sessions.forEach(ensureLogSheet);
  ensureMarkColumns(sessions);

  // 新建試算表自帶的空白分頁。
  for (const sheet of ss.getSheets()) {
    const name = sheet.getName();
    if (name !== ROSTER_SHEET && !sessions.includes(name) && sheet.getLastRow() === 0) ss.deleteSheet(sheet);
  }
  roster.activate();
}
