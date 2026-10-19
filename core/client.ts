// 掃描端的同步狀態（PLAN 4.5、4.6）：待送佇列、cursor、伺服器回傳的紀錄、連線判定。
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
