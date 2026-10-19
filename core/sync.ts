// 同步中心的伺服器端邏輯（PLAN 3）：去重、寫入、回傳其他裝置的紀錄。
// 儲存透過 LogStore／RosterStore 兩個 port，Apps Script 端以 Sheet 實作，測試以記憶體實作。

/** 一次掃描。scanId 由前端產生，重送時不變，讓寫入冪等（PLAN 2.3）。 */
export interface Scan {
  scanId: string;
  code: string;
  session: string;
  /** epoch ms，以掃描當下的裝置時間為準。 */
  at: number;
  /** 報到當下的學員欄位快照，直接寫進 log（PLAN 5.2）。 */
  snapshot: Record<string, string>;
}

/** 報到 log 的一列。seq 單調遞增，作為同步 cursor（PLAN 3.5）。 */
export interface LogEntry extends Scan {
  seq: number;
  deviceId: string;
}

export interface SyncRequest {
  deviceId: string;
  /** 這台裝置已經看過的最大 seq。 */
  cursor: number;
  scans: Scan[];
}

export interface SyncResponse {
  cursor: number;
  /** 本次請求中已確定落地的 scanId，含先前已寫入的重送。前端據此移出佇列。 */
  acked: string[];
  /** cursor 之後、其他裝置寫入的紀錄。 */
  others: LogEntry[];
}

export interface LogStore {
  knownScanIds(ids: string[]): Set<string>;
  lastSeq(): number;
  append(entries: LogEntry[]): void;
  since(cursor: number): LogEntry[];
}

export interface RosterStore {
  /** 更新學員名單上的「{session} 報到時間」欄（PLAN 5.3）。 */
  markCheckedIn(session: string, code: string, at: number): void;
}

/** 呼叫端負責在呼叫期間持有寫入 lock。 */
export function applySync(log: LogStore, roster: RosterStore, req: SyncRequest): SyncResponse {
  const known = log.knownScanIds(req.scans.map((s) => s.scanId));
  const fresh: LogEntry[] = [];
  let seq = log.lastSeq();
  for (const scan of req.scans) {
    if (known.has(scan.scanId)) continue;
    known.add(scan.scanId);
    fresh.push({ ...scan, seq: ++seq, deviceId: req.deviceId });
  }
  if (fresh.length) log.append(fresh);

  const latest = new Map<string, LogEntry>();
  for (const entry of fresh) {
    const key = `${entry.session}\u0000${entry.code}`;
    const prev = latest.get(key);
    if (!prev || entry.at > prev.at) latest.set(key, entry);
  }
  for (const entry of latest.values()) roster.markCheckedIn(entry.session, entry.code, entry.at);

  return {
    cursor: seq,
    acked: [...new Set(req.scans.map((s) => s.scanId))],
    others: log.since(req.cursor).filter((e) => e.deviceId !== req.deviceId),
  };
}
