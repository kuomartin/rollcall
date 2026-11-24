// doPost 的動作：bootstrap、lookup、sync。

import type { ApiRequest, BootstrapResult, LookupResult, SyncResult } from "../../core/api.ts";
import { buildRosterCache, buildTicketCache, cacheFields, cacheRow, checkInTimes, CODE_FIELD, findRow } from "../../core/roster.ts";
import { rosterFields } from "../../core/rules.ts";
import { applySync, type SyncRequest, type SyncResponse } from "../../core/sync.ts";
import { gates, getSettings, rosterVersion, signingKeys, syncGate } from "./settings.ts";
import { logCheckIns, readRoster } from "./sheets.ts";
import { DeferredRosterStore, LockedLogStore, writeMarks, writeReservations } from "./store.ts";
import { readRules } from "./tickets.ts";

const LOCK_WAIT_MS = 20_000;

function bootstrap(): BootstrapResult {
  const { sessions, template, mode } = getSettings();
  const roster = readRoster();
  if (mode === "ticket") {
    // 規則有錯時不送出任何規則：少了一條「拒絕」就可能錯放，掃描頁改為沿用先前的規則。
    const { rules, errors } = readRules();
    const log = logCheckIns(sessions);
    return {
      sessions,
      template,
      mode,
      roster: buildTicketCache(roster, rosterFields(rules), rosterVersion()),
      checkedIn: log.times,
      checkedInBy: log.by,
      publicKey: signingKeys()?.publicKey ?? null,
      rules: errors.length ? [] : rules,
      ruleErrors: errors,
      gates: gates(),
    };
  }
  return {
    sessions,
    template,
    mode,
    roster: buildRosterCache(roster, template, rosterVersion()),
    checkedIn: checkInTimes(roster, sessions),
    gates: gates(),
  };
}

function lookup(query: string): LookupResult {
  // 票券模式只認簽章：用代號或手機查詢等於繞過簽章。
  if (getSettings().mode === "ticket") throw new Error("票券模式不支援查詢");
  const roster = readRoster();
  const index = findRow(roster, query);
  if (index === -1) return { row: null, checkedIn: {} };
  const { template, sessions } = getSettings();
  const row = cacheRow(roster, index, cacheFields(roster.headers, template));
  const times = checkInTimes({ headers: roster.headers, rows: [roster.rows[index]] }, sessions);
  const checkedIn = Object.fromEntries(
    Object.entries(times).flatMap(([session, codes]) => (row[CODE_FIELD] in codes ? [[session, codes[row[CODE_FIELD]]]] : [])),
  );
  return { row, checkedIn };
}

/** 只在 --dev 建置記錄各段耗時，隨回應帶回。 */
function timer(): { mark(label: string): void; result(): Record<string, number> | undefined } {
  const marks: Record<string, number> = {};
  let last = Date.now();
  return {
    mark(label) {
      if (!__DEV__) return;
      const now = Date.now();
      marks[label] = now - last;
      last = now;
    },
    result: () => (__DEV__ ? marks : undefined),
  };
}

function sync(req: SyncRequest & { gate?: string }): SyncResult {
  const t = timer();
  const { sessions } = getSettings();
  t.mark("settings");
  const unknown = [...new Set(req.scans.map((s) => s.session))].filter((s) => !sessions.includes(s));
  if (unknown.length) throw new Error(`未知場次：${unknown.join("、")}`);

  const roster = readRoster();
  t.mark("readRoster");
  const marks = new DeferredRosterStore();
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  t.mark("lockWait");
  let store: LockedLogStore;
  let res: SyncResponse;
  try {
    store = new LockedLogStore(sessions, req.scans.map((s) => s.scanId));
    res = applySync(store, marks, req);
  } finally {
    lock.releaseLock();
  }
  t.mark("locked");
  writeReservations(store.reservations, roster);
  writeMarks(marks.marks, roster);
  t.mark("write");
  const gateNames = syncGate(req.deviceId, req.gate);
  t.mark("gates");
  return { ...res, rosterVersion: rosterVersion(), gates: gateNames, ...(__DEV__ ? { timings: t.result() } : {}) };
}

export function handle(req: ApiRequest): unknown {
  switch (req.action) {
    case "bootstrap":
      return bootstrap();
    case "lookup":
      return lookup(req.query);
    case "sync":
      return sync(req);
  }
}
