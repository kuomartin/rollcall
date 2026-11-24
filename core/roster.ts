// 學員名單：掃描頁名單快取的內容（docs/adr/0006-phone-numbers-stay-on-the-server.md）與識別碼查詢。

import { referencedFields } from "./template.ts";

export const CODE_FIELD = "學員代號";
export const PHONE_FIELD = "手機";
/** 票券模式：簽章涵蓋的序號。規則訊息也用 {{序號}} 代入。 */
export const SERIAL_FIELD = "序號";

/** 學員名單分頁的原始內容：第 1 列標題，其後每列一位學員。 */
export interface RosterTable {
  headers: readonly string[];
  rows: readonly (readonly unknown[])[];
}

export type CacheRow = Record<string, string>;

export interface RosterCache {
  version: string;
  /** 每列除了學員代號之外帶的欄位，即模板引用到、且名單裡有的欄位。 */
  fields: string[];
  rows: CacheRow[];
}

/** 代號模式靠學員代號比對，一定要有這欄；票券模式靠序號，學員代號可以省略。 */
export function missingRequired(headers: readonly string[], ticketMode = false): string[] {
  return ticketMode || headers.includes(CODE_FIELD) ? [] : [CODE_FIELD];
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/** 只留數字並去掉開頭的 0：試算表常把手機存成數字，吃掉開頭的 0。 */
function phoneKey(value: unknown): string {
  return text(value).replace(/\D/g, "").replace(/^0+/, "");
}

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length <= 3 ? "*".repeat(digits.length) : "*".repeat(digits.length - 3) + digits.slice(-3);
}

export function cacheRow(table: RosterTable, index: number, fields: readonly string[]): CacheRow {
  const row = table.rows[index];
  const cell = (field: string) => row[table.headers.indexOf(field)];
  const out: CacheRow = { [CODE_FIELD]: text(cell(CODE_FIELD)) };
  for (const field of fields) {
    out[field] = field === PHONE_FIELD ? maskPhone(text(cell(field))) : text(cell(field));
  }
  return out;
}

/** 快取每列除了學員代號之外要帶的欄位。 */
export function cacheFields(headers: readonly string[], template: string): string[] {
  return referencedFields(template).filter((f) => f !== CODE_FIELD && headers.includes(f));
}

export function buildRosterCache(table: RosterTable, template: string, version: string): RosterCache {
  const fields = cacheFields(table.headers, template);
  const codeIndex = table.headers.indexOf(CODE_FIELD);
  const rows: CacheRow[] = [];
  table.rows.forEach((row, i) => {
    if (text(row[codeIndex])) rows.push(cacheRow(table, i, fields));
  });
  return { version, fields, rows };
}

/**
 * 一列在報到紀錄裡的代號：學員代號，空白或沒有這欄時用序號。
 * 票券模式的學員代號可以省略，序號本身就是一張票一個值。
 */
export function rowCode(table: RosterTable, row: readonly unknown[]): string {
  const code = text(row[table.headers.indexOf(CODE_FIELD)]);
  if (code) return code;
  const serialIndex = table.headers.indexOf(SERIAL_FIELD);
  return serialIndex === -1 ? "" : text(row[serialIndex]);
}

/** 代號 → 列索引（0 起算），代號見 rowCode；重複的代號以第一列為準。報到紀錄的名單快照、報到時間欄與側邊欄跳轉都用它。 */
export function rosterIndex(table: RosterTable): Map<string, number> {
  const index = new Map<string, number>();
  table.rows.forEach((row, i) => {
    const code = rowCode(table, row);
    if (code && !index.has(code)) index.set(code, i);
  });
  return index;
}

/**
 * 票券模式的名單快取：只帶有序號的列，每列多帶序號，掃描頁用它對回學員。
 * fields 是「需在名單」規則訊息引用到的欄位（core/rules.ts 的 rosterFields）。
 */
export function buildTicketCache(table: RosterTable, fields: readonly string[], version: string): RosterCache {
  const kept = [...fields.filter((f) => f !== CODE_FIELD && f !== SERIAL_FIELD && table.headers.includes(f)), SERIAL_FIELD];
  const serialIndex = table.headers.indexOf(SERIAL_FIELD);
  const rows: CacheRow[] = [];
  if (serialIndex !== -1) {
    table.rows.forEach((row, i) => {
      if (text(row[serialIndex])) rows.push({ ...cacheRow(table, i, kept), [CODE_FIELD]: rowCode(table, row) });
    });
  }
  return { version, fields: kept, rows };
}

/** 先比對學員代號，找不到再比對手機。回傳列索引，找不到為 -1。 */
export function findRow(table: RosterTable, query: string): number {
  const q = query.trim();
  if (!q) return -1;
  const codeIndex = table.headers.indexOf(CODE_FIELD);
  const byCode = table.rows.findIndex((row) => text(row[codeIndex]) === q);
  if (byCode !== -1) return byCode;

  const phoneIndex = table.headers.indexOf(PHONE_FIELD);
  const key = phoneKey(q);
  if (phoneIndex === -1 || !key) return -1;
  return table.rows.findIndex((row) => phoneKey(row[phoneIndex]) === key);
}

/** 學員名單上記錄某場次最近報到時間的欄位名稱，由程式維護。 */
export function markColumnHeader(session: string): string {
  return `${session} 報到時間`;
}

/** 各場次已報到學員的最近報到時間（epoch ms），讀自學員名單的「{場次} 報到時間」欄。 */
export function checkInTimes(table: RosterTable, sessions: readonly string[]): Record<string, Record<string, number>> {
  const codeIndex = table.headers.indexOf(CODE_FIELD);
  const out: Record<string, Record<string, number>> = {};
  for (const session of sessions) {
    const col = table.headers.indexOf(markColumnHeader(session));
    const times: Record<string, number> = {};
    if (col !== -1) {
      for (const row of table.rows) {
        const code = text(row[codeIndex]);
        const at = row[col] instanceof Date ? row[col].getTime() : NaN;
        if (code && Number.isFinite(at)) times[code] = at;
      }
    }
    out[session] = times;
  }
  return out;
}
