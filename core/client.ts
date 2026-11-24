// 掃描端的同步狀態（docs/adr/0003-local-first-check-in-with-one-writer.md）：待送佇列、cursor、伺服器回傳的紀錄、連線判定。
// 不碰網路與計時器；由 web 層決定何時 request()、把回應交給 receive()。

import type { LogEntry, Scan, SyncRequest, SyncResponse } from "./sync.ts";

export class SyncClient {
  readonly deviceId: string;
  #queue: Scan[] = [];
  #cursor = 0;
  #entries = new Map<string, LogEntry>();

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  enqueue(scan: Scan): void {
    this.#queue.push(scan);
  }

  pending(): readonly Scan[] {
    return this.#queue;
  }

  /** 伺服器回傳的紀錄，依 seq 排序。 */
  entries(): LogEntry[] {
    return [...this.#entries.values()].sort((a, b) => a.seq - b.seq);
  }

  /** 送出整個佇列；回應前新進的掃描留到下一次。 */
  request(): SyncRequest {
    return { deviceId: this.deviceId, cursor: this.#cursor, scans: [...this.#queue] };
  }

  receive(res: SyncResponse): void {
    const acked = new Set(res.acked);
    this.#queue = this.#queue.filter((s) => !acked.has(s.scanId));
    for (const entry of res.entries) this.#entries.set(entry.scanId, entry);
    this.#cursor = Math.max(this.#cursor, res.cursor);
  }
}

/** 每個場次裡每位學員最近的報到時間與入口：判斷是不是重複報到、在哪個入口報到。 */
export class CheckInIndex {
  #latest = new Map<string, { at: number; deviceId?: string }>();

  /** by：場次 → 代號 → deviceId；舊版 Apps Script 沒有。 */
  load(times: Record<string, Record<string, number>>, by: Record<string, Record<string, string>> = {}): void {
    this.#latest.clear();
    for (const [session, codes] of Object.entries(times)) {
      for (const [code, at] of Object.entries(codes)) this.add(session, code, at, by[session]?.[code]);
    }
  }

  add(session: string, code: string, at: number, deviceId?: string): void {
    const key = `${session}\u0000${code}`;
    const prev = this.#latest.get(key);
    if (!prev || at > prev.at) this.#latest.set(key, { at, deviceId });
    else if (at === prev.at && deviceId && !prev.deviceId) prev.deviceId = deviceId;
  }

  last(session: string, code: string): number | undefined {
    return this.#latest.get(`${session}\u0000${code}`)?.at;
  }

  lastDevice(session: string, code: string): string | undefined {
    return this.#latest.get(`${session}\u0000${code}`)?.deviceId;
  }
}

/** 「3 分鐘前」；不到 1 分鐘是「剛剛」。 */
export function ago(now: number, at: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小時 ${minutes % 60} 分鐘前` : `${hours} 小時前`;
}

export type Connectivity = "ok" | "delayed" | "offline";

export interface ConnectivityInput {
  now: number;
  /** navigator.onLine */
  online: boolean;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  inFlightSince: number | null;
}

/** 超過這個時間仍未回應的請求，才納入判定。 */
export const STALL_MS = 10_000;

/**
 * offline 時禁止報到；delayed 只提示。
 * 只是慢不算斷線：實測 Apps Script 偶有十幾秒的回應，不能因此鎖住入口。
 */
export function connectivity(s: ConnectivityInput): Connectivity {
  if (s.lastSuccessAt === null) return "offline";
  if (s.lastFailureAt !== null && s.lastFailureAt > s.lastSuccessAt) return "offline";
  if (s.inFlightSince !== null && s.now - s.inFlightSince > STALL_MS) {
    return s.online ? "delayed" : "offline";
  }
  return "ok";
}
