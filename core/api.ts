// 掃描頁與 Apps Script 之間的請求／回應格式。請求來自匿名呼叫者，進 handler 前一律經過 parseRequest。

import type { CacheRow, RosterCache } from "./roster.ts";
import type { Rule } from "./rules.ts";
import type { Scan, SyncRequest, SyncResponse } from "./sync.ts";

export type ApiRequest =
  | { action: "bootstrap" }
  | { action: "lookup"; query: string }
  | ({ action: "sync"; gate?: string } & SyncRequest);

export type Mode = "code" | "ticket";

export interface BootstrapResult {
  sessions: string[];
  template: string;
  roster: RosterCache;
  /** 場次 → 學員代號 → 最近報到時間，用來提醒重複報到。 */
  checkedIn: Record<string, Record<string, number>>;
  // 以下欄位舊版 Apps Script 沒有：沒有 mode 就是代號模式。
  /** 票券模式：場次 → 代號 → 最近一次報到的 deviceId。 */
  checkedInBy?: Record<string, Record<string, string>>;
  mode?: Mode;
  /** 票券模式：Ed25519 公鑰（base64url）；尚未產生金鑰對時為 null。 */
  publicKey?: string | null;
  /** 票券模式：票種規則。ruleErrors 非空時 rules 為空陣列，掃描頁沿用先前的規則。 */
  rules?: Rule[];
  ruleErrors?: string[];
  /** deviceId → 入口名稱。 */
  gates?: Record<string, string>;
}

export interface LookupResult {
  row: CacheRow | null;
  /** 這位學員在各場次的最近報到時間。 */
  checkedIn: Record<string, number>;
}

export interface SyncResult extends SyncResponse {
  rosterVersion: string;
  gates?: Record<string, string>;
}

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/** 一次同步最多帶的掃描筆數；正常情況一批只有幾筆。 */
export const MAX_BATCH = 500;
const MAX_TEXT = 200;

function fail(message: string): never {
  throw new Error(`無效的請求：${message}`);
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT) fail(name);
  return value;
}

function nonNegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(name);
  return value;
}

function scan(value: unknown): Scan {
  if (typeof value !== "object" || value === null) fail("scan");
  const v = value as Record<string, unknown>;
  return {
    scanId: str(v.scanId, "scanId"),
    code: str(v.code, "code"),
    session: str(v.session, "session"),
    at: nonNegative(v.at, "at"),
  };
}

export function parseRequest(body: unknown): ApiRequest {
  if (typeof body !== "object" || body === null) fail("body");
  const b = body as Record<string, unknown>;
  switch (b.action) {
    case "bootstrap":
      return { action: "bootstrap" };
    case "lookup":
      return { action: "lookup", query: str(b.query, "query") };
    case "sync": {
      if (!Array.isArray(b.scans) || b.scans.length > MAX_BATCH) fail("scans");
      return {
        action: "sync",
        deviceId: str(b.deviceId, "deviceId"),
        cursor: nonNegative(b.cursor, "cursor"),
        scans: b.scans.map(scan),
        ...(b.gate === undefined ? {} : { gate: str(b.gate, "gate") }),
      };
    }
    default:
      fail("action");
  }
}
