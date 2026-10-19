// 試算表的分頁結構：學員名單與各場次的報到分頁。

import { CODE_FIELD, type RosterTable } from "../../core/roster.ts";

export const ROSTER_SHEET = "學員名單";
export const LOG_HEADERS = ["seq", "scanId", "時間", CODE_FIELD, "deviceId"];
const FIXED = LOG_HEADERS.length;
export const DATETIME_FORMAT = "yyyy/mm/dd hh:mm:ss";

type Sheet = GoogleAppsScript.Spreadsheet.Sheet;

function spreadsheet(): GoogleAppsScript.Spreadsheet.Spreadsheet {
  return SpreadsheetApp.getActiveSpreadsheet();
}

export function rosterSheet(): Sheet {
  const sheet = spreadsheet().getSheetByName(ROSTER_SHEET);
  if (!sheet) throw new Error(`找不到「${ROSTER_SHEET}」分頁`);
  return sheet;
}

export function readRoster(): RosterTable {
  const [headers = [], ...rows] = rosterSheet().getDataRange().getValues();
  return { headers: headers.map((h) => String(h).trim()), rows };
}

export function rosterIndex(roster: RosterTable): Map<string, number> {
  const col = roster.headers.indexOf(CODE_FIELD);
  const index = new Map<string, number>();
  roster.rows.forEach((row, i) => {
    const code = String(row[col] ?? "").trim();
    if (code && !index.has(code)) index.set(code, i);
  });
  return index;
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
