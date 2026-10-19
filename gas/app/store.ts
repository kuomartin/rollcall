// 同步的儲存實作，設計理由見 docs/adr/0004-sync-lock-only-guards-bookkeeping.md。
//
// lock 只保護記帳：seq、每個報到分頁下一個可寫的列、近期紀錄與已見過的 scanId（CacheService）。
// 寫進 Sheet 的動作在放開 lock 之後進行：每次同步在 lock 內預留不重疊的列範圍，各自寫入不會互相覆蓋。
// 實測 lock 內若讀寫 Sheet，一次要持有約 1.3 秒，8 台裝置同時同步就會等到逾時。
//
// scanId 存在 CacheService：快取被清掉後重送的掃描可能多寫一列。報到本來就允許重複，所以接受。

import { markColumnHeader, type RosterTable } from "../../core/roster.ts";
import type { LogEntry, LogStore, RosterStore } from "../../core/sync.ts";
import { DATETIME_FORMAT, ensureLogSheet, LOG_HEADERS, rosterIndex, rosterSheet } from "./sheets.ts";

const FIXED = LOG_HEADERS.length;
const CACHE_TTL_S = 21_600;
const RECENT_LIMIT = 300;
const RECENT_KEY = "recent";
const SEQ_KEY = "seq";
const rowKey = (session: string) => `row:${session}`;
const scanKey = (scanId: string) => `scan:${scanId}`;

export interface Reservation {
  session: string;
  row: number;
  entries: LogEntry[];
}

function readLogTail(sessions: string[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const session of sessions) {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(session);
    if (!sheet || sheet.getLastRow() < 2) continue;
    const first = Math.max(2, sheet.getLastRow() - RECENT_LIMIT + 1);
    for (const r of sheet.getRange(first, 1, sheet.getLastRow() - first + 1, FIXED).getValues()) {
      const seq = Number(r[0]);
      if (!Number.isFinite(seq) || seq <= 0) continue;
      const at = r[2] instanceof Date ? r[2].getTime() : Number(r[2]);
      entries.push({ seq, scanId: String(r[1]), at, code: String(r[3]), deviceId: String(r[4]), session });
    }
  }
  return entries.sort((a, b) => a.seq - b.seq).slice(-RECENT_LIMIT);
}

/** 必須在 script lock 內建立與使用；寫 Sheet 交給 writeReservations。 */
export class LockedLogStore implements LogStore {
  readonly reservations: Reservation[] = [];
  #props = PropertiesService.getScriptProperties();
  #cache = CacheService.getScriptCache();
  #recent: LogEntry[];
  #seq: number;

  #stored: Record<string, string>;
  #cached: Record<string, string>;

  /** lock 內每次 Properties／Cache 呼叫約 50 ms，所以一次讀齊：近期紀錄、已見過的 scanId、計數器。 */
  constructor(sessions: string[], scanIds: string[]) {
    this.#stored = this.#props.getProperties();
    this.#cached = this.#cache.getAll([RECENT_KEY, ...scanIds.map(scanKey)]);
    const recent = this.#cached[RECENT_KEY];
    // 快取被清掉時，從各報到分頁的最後幾列重建。
    this.#recent = recent ? (JSON.parse(recent) as LogEntry[]) : readLogTail(sessions);
    const stored = Number(this.#stored[SEQ_KEY] ?? 0);
    this.#seq = this.#recent.reduce((max, e) => Math.max(max, e.seq), stored);
  }

  knownScanIds(ids: string[]): Set<string> {
    const recent = new Set(this.#recent.map((e) => e.scanId));
    return new Set(ids.filter((id) => this.#cached[scanKey(id)] || recent.has(id)));
  }

  lastSeq(): number {
    return this.#seq;
  }

  append(entries: LogEntry[]): void {
    const bySession = new Map<string, LogEntry[]>();
    for (const e of entries) bySession.set(e.session, [...(bySession.get(e.session) ?? []), e]);

    const updates: Record<string, string> = {};
    for (const [session, group] of bySession) {
      const stored = Number(this.#stored[rowKey(session)] ?? 0);
      const row = stored || ensureLogSheet(session).getLastRow() + 1;
      this.reservations.push({ session, row, entries: group });
      updates[rowKey(session)] = String(row + group.length);
    }
    this.#seq = entries.reduce((max, e) => Math.max(max, e.seq), this.#seq);
    updates[SEQ_KEY] = String(this.#seq);
    this.#props.setProperties(updates);

    this.#recent = [...this.#recent, ...entries].slice(-RECENT_LIMIT);
    this.#cache.putAll(
      { [RECENT_KEY]: JSON.stringify(this.#recent), ...Object.fromEntries(entries.map((e) => [scanKey(e.scanId), "1"])) },
      CACHE_TTL_S,
    );
  }

  /** 只涵蓋最近 300 筆；更早的 cursor（例如剛開頁的裝置）拿到的就是這 300 筆，前端只顯示最近幾十筆。 */
  since(cursor: number): LogEntry[] {
    return this.#recent.filter((e) => e.seq > cursor);
  }
}

/** 收集報到時間，放開 lock 後由 writeMarks 寫入。 */
export class DeferredRosterStore implements RosterStore {
  readonly marks: Array<{ session: string; code: string; at: number }> = [];

  markCheckedIn(session: string, code: string, at: number): void {
    this.marks.push({ session, code, at });
  }
}

function withLock<T>(fn: () => T): T {
  const lock = LockService.getScriptLock();
  lock.waitLock(20_000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function logRows(sheet: GoogleAppsScript.Spreadsheet.Sheet, entries: LogEntry[], roster: RosterTable): unknown[][] {
  const width = Math.max(FIXED, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, width).getValues()[0].map((h) => String(h).trim());
  const snapshotCols = headers.slice(FIXED).map((h) => roster.headers.indexOf(h));
  const index = rosterIndex(roster);
  return entries.map((e) => {
    const rosterRow = roster.rows[index.get(e.code) ?? -1];
    const snapshot = snapshotCols.map((col) => (rosterRow && col >= 0 ? rosterRow[col] : ""));
    // 前置 ' 讓 001 這類代號保持文字，不被轉成數字。
    return [e.seq, e.scanId, new Date(e.at), `'${e.code}`, e.deviceId, ...snapshot];
  });
}

/**
 * 寫入預留的列。預留範圍不是空的（有人手動插入或刪除了列，計數器跟實際不符），
 * 就改在 lock 內接在最後一列之後寫，並校正計數器。
 */
export function writeReservations(reservations: Reservation[], roster: RosterTable): void {
  for (const { session, row, entries } of reservations) {
    const sheet = ensureLogSheet(session);
    const rows = logRows(sheet, entries, roster);
    const target = sheet.getRange(row, 1, rows.length, FIXED);
    if (target.getValues().every((r) => r.every((v) => v === ""))) {
      sheet.getRange(row, 1, rows.length, rows[0].length).setValues(rows);
      continue;
    }
    withLock(() => {
      const at = sheet.getLastRow() + 1;
      sheet.getRange(at, 1, rows.length, rows[0].length).setValues(rows);
      SpreadsheetApp.flush();
      const props = PropertiesService.getScriptProperties();
      props.setProperty(rowKey(session), String(Math.max(at + rows.length, Number(props.getProperty(rowKey(session)) ?? 0))));
    });
  }
}

/** 新場次的報到時間欄在儲存設定時建立；這裡遇到缺欄位才在 lock 內補建。 */
export function writeMarks(marks: DeferredRosterStore["marks"], roster: RosterTable): void {
  if (!marks.length) return;
  const sheet = rosterSheet();
  const index = rosterIndex(roster);
  let headers = roster.headers;
  const missing = [...new Set(marks.map((m) => markColumnHeader(m.session)))].filter((h) => !headers.includes(h));
  if (missing.length) {
    headers = withLock(() => ensureMarkColumns(missing.map((h) => h.replace(/ 報到時間$/, ""))));
  }
  for (const { session, code, at } of marks) {
    const row = index.get(code);
    const col = headers.indexOf(markColumnHeader(session));
    if (row !== undefined && col !== -1) {
      sheet.getRange(row + 2, col + 1).setValue(new Date(at)).setNumberFormat(DATETIME_FORMAT);
    }
  }
}

/** 確保學員名單有各場次的「{場次} 報到時間」欄，回傳最新的標題列。 */
export function ensureMarkColumns(sessions: string[]): string[] {
  const sheet = rosterSheet();
  const headers = sheet
    .getRange(1, 1, 1, Math.max(1, sheet.getLastColumn()))
    .getValues()[0]
    .map((h) => String(h).trim());
  const missing = sessions.map(markColumnHeader).filter((h) => !headers.includes(h));
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers.push(...missing);
  }
  return headers;
}
