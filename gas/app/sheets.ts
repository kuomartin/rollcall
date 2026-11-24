// 試算表的分頁結構：名單分頁（預設叫「學員名單」，可在設定改）與各場次的報到分頁。

import { CODE_FIELD, type RosterTable } from "../../core/roster.ts";
import { rosterSheetName } from "./settings.ts";

export const LOG_HEADERS = ["seq", "scanId", "時間", CODE_FIELD, "deviceId"];
const FIXED = LOG_HEADERS.length;
export const DATETIME_FORMAT = "yyyy/mm/dd hh:mm:ss";

type Sheet = GoogleAppsScript.Spreadsheet.Sheet;

function spreadsheet(): GoogleAppsScript.Spreadsheet.Spreadsheet {
  return SpreadsheetApp.getActiveSpreadsheet();
}

export function rosterSheet(name = rosterSheetName()): Sheet {
  const sheet = spreadsheet().getSheetByName(name);
  if (!sheet) throw new Error(`找不到名單分頁「${name}」，請在「報到 → 設定」選擇名單分頁`);
  return sheet;
}

export function readRoster(name?: string): RosterTable {
  const [headers = [], ...rows] = rosterSheet(name).getDataRange().getValues();
  return { headers: headers.map((h) => String(h).trim()), rows };
}

export function ensureLogSheet(session: string): Sheet {
  const existing = spreadsheet().getSheetByName(session);
  if (existing) return existing;
  const sheet = spreadsheet().insertSheet(session);
  sheet.getRange(1, 1, 1, FIXED).setValues([LOG_HEADERS]);
  sheet.getRange("C:C").setNumberFormat(DATETIME_FORMAT);
  sheet.setFrozenRows(1);
  return sheet;
}

/**
 * 各場次每個代號最近的報到時間與 deviceId，讀自報到分頁。
 * 票券模式用：放行的票不在學員名單上，名單的報到時間欄記不到；deviceId 用來顯示在哪個入口入場。
 */
export function logCheckIns(sessions: readonly string[]): {
  times: Record<string, Record<string, number>>;
  by: Record<string, Record<string, string>>;
} {
  const times: Record<string, Record<string, number>> = {};
  const by: Record<string, Record<string, string>> = {};
  for (const session of sessions) {
    const t: Record<string, number> = {};
    const d: Record<string, string> = {};
    const sheet = spreadsheet().getSheetByName(session);
    if (sheet && sheet.getLastRow() >= 2) {
      for (const [at, code, deviceId] of sheet.getRange(2, 3, sheet.getLastRow() - 1, 3).getValues()) {
        const ms = at instanceof Date ? at.getTime() : NaN;
        const c = String(code ?? "").trim();
        if (c && Number.isFinite(ms) && !(t[c] >= ms)) {
          t[c] = ms;
          d[c] = String(deviceId ?? "");
        }
      }
    }
    times[session] = t;
    by[session] = d;
  }
  return { times, by };
}
