// LogStore／RosterStore 的 Sheet 實作（PLAN 3.2、3.3、5.1、5.3）。每個請求建立一次，請求內快取讀到的內容。

import { CODE_FIELD, type RosterTable } from "../../core/roster.ts";
import type { LogEntry, LogStore, RosterStore } from "../../core/sync.ts";
import { storedSeq, storeSeq } from "./settings.ts";

export const ROSTER_SHEET = "學員名單";
export const LOG_HEADERS = ["seq", "scanId", "時間", CODE_FIELD, "deviceId"];
const FIXED = LOG_HEADERS.length;

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

function rosterIndex(roster: RosterTable): Map<string, number> {
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
  sheet.setFrozenRows(1);
  return sheet;
}

export class SheetLogStore implements LogStore {
  #sessions: string[];
  #roster: RosterTable;
  #rosterIndex: Map<string, number>;
  #entries: LogEntry[] | null = null;

  constructor(sessions: string[], roster: RosterTable) {
    this.#sessions = sessions;
    this.#roster = roster;
    this.#rosterIndex = rosterIndex(roster);
  }

  #all(): LogEntry[] {
    if (this.#entries) return this.#entries;
    const entries: LogEntry[] = [];
    for (const session of this.#sessions) {
      const sheet = spreadsheet().getSheetByName(session);
      if (!sheet || sheet.getLastRow() < 2) continue;
      for (const r of sheet.getRange(2, 1, sheet.getLastRow() - 1, FIXED).getValues()) {
        const seq = Number(r[0]);
        if (!Number.isFinite(seq) || seq <= 0) continue;
        const at = r[2] instanceof Date ? r[2].getTime() : Number(r[2]);
        entries.push({ seq, scanId: String(r[1]), at, code: String(r[3]), deviceId: String(r[4]), session });
      }
    }
    return (this.#entries = entries);
  }

  knownScanIds(ids: string[]): Set<string> {
    const wanted = new Set(ids);
    return new Set(this.#all().filter((e) => wanted.has(e.scanId)).map((e) => e.scanId));
  }

  /** Script Property 被清掉時，以 log 裡最大的 seq 為準，cursor 不會倒退。 */
  lastSeq(): number {
    return this.#all().reduce((max, e) => Math.max(max, e.seq), storedSeq());
  }

  append(entries: LogEntry[]): void {
    const bySession = new Map<string, LogEntry[]>();
    for (const e of entries) bySession.set(e.session, [...(bySession.get(e.session) ?? []), e]);

    for (const [session, group] of bySession) {
      const sheet = ensureLogSheet(session);
      const width = Math.max(FIXED, sheet.getLastColumn());
      const headers = sheet.getRange(1, 1, 1, width).getValues()[0].map((h) => String(h).trim());
      const snapshotCols = headers.slice(FIXED).map((h) => this.#roster.headers.indexOf(h));
      const rows = group.map((e) => {
        const rosterRow = this.#roster.rows[this.#rosterIndex.get(e.code) ?? -1];
        const snapshot = snapshotCols.map((col) => (rosterRow && col >= 0 ? rosterRow[col] : ""));
        // 前置 ' 讓 001 這類代號保持文字，不被轉成數字。
        return [e.seq, e.scanId, new Date(e.at), `'${e.code}`, e.deviceId, ...snapshot];
      });
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, width).setValues(rows);
    }
    this.#all().push(...entries);
    storeSeq(entries.reduce((max, e) => Math.max(max, e.seq), 0));
  }

  since(cursor: number): LogEntry[] {
    return this.#all()
      .filter((e) => e.seq > cursor)
      .sort((a, b) => a.seq - b.seq);
  }
}

/** 更新學員名單的「{場次} 報到時間」欄，欄位不存在就加在最後（PLAN 5.3）。 */
export class SheetRosterStore implements RosterStore {
  #headers: string[];
  #index: Map<string, number>;

  constructor(roster: RosterTable) {
    this.#headers = [...roster.headers];
    this.#index = rosterIndex(roster);
  }

  markCheckedIn(session: string, code: string, at: number): void {
    const row = this.#index.get(code);
    if (row === undefined) return;
    const sheet = rosterSheet();
    const header = `${session} 報到時間`;
    let col = this.#headers.indexOf(header);
    if (col === -1) {
      col = this.#headers.length;
      this.#headers.push(header);
      sheet.getRange(1, col + 1).setValue(header);
    }
    sheet.getRange(row + 2, col + 1).setValue(new Date(at));
  }
}
