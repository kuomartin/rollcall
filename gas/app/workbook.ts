// 第一次開啟時建立分頁結構：範本和主辦方的副本都不需要手動建分頁。

import { CODE_FIELD, PHONE_FIELD } from "../../core/roster.ts";
import { DEFAULT_ROSTER_SHEET, getSettings, rosterSheetConfigured } from "./settings.ts";
import { ensureLogSheet } from "./sheets.ts";
import { ensureMarkColumns } from "./store.ts";

export function ensureWorkbook(): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // 儲存過設定，或預設的名單分頁已經在，就不是第一次開啟；名單分頁被改名時不要另建一張空的。
  if (rosterSheetConfigured() || ss.getSheetByName(DEFAULT_ROSTER_SHEET)) return;
  const { sessions } = getSettings();

  const roster = ss.insertSheet(DEFAULT_ROSTER_SHEET, 0);
  roster.getRange(1, 1, 1, 3).setValues([[CODE_FIELD, "姓名", PHONE_FIELD]]);
  // 純文字格式：學員代號的開頭 0、手機的開頭 0 才不會被吃掉。
  roster.getRange("A:A").setNumberFormat("@");
  roster.getRange("C:C").setNumberFormat("@");
  roster.setFrozenRows(1);

  sessions.forEach(ensureLogSheet);
  ensureMarkColumns(sessions);

  // 新建試算表自帶的空白分頁。
  for (const sheet of ss.getSheets()) {
    const name = sheet.getName();
    if (name !== DEFAULT_ROSTER_SHEET && !sessions.includes(name) && sheet.getLastRow() === 0) ss.deleteSheet(sheet);
  }
  roster.activate();
}
