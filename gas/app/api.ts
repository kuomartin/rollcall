// doPost 的動作（PLAN 3、4.1、4.1c）。

import type { ApiRequest, BootstrapResult, LookupResult, SyncResult } from "../../core/api.ts";
import { buildRosterCache, cacheFields, cacheRow, findRow } from "../../core/roster.ts";
import { applySync, type SyncRequest, type SyncResponse } from "../../core/sync.ts";
import { getSettings, rosterVersion } from "./settings.ts";
import { readRoster } from "./sheets.ts";
import { DeferredRosterStore, LockedLogStore, writeMarks, writeReservations } from "./store.ts";

const LOCK_WAIT_MS = 20_000;

function bootstrap(): BootstrapResult {
  const { sessions, template } = getSettings();
  return { sessions, template, roster: buildRosterCache(readRoster(), template, rosterVersion()) };
}

function lookup(query: string): LookupResult {
  const roster = readRoster();
  const index = findRow(roster, query);
  if (index === -1) return { row: null };
  return { row: cacheRow(roster, index, cacheFields(roster.headers, getSettings().template)) };
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

function sync(req: SyncRequest): SyncResult {
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
  return { ...res, rosterVersion: rosterVersion(), ...(__DEV__ ? { timings: t.result() } : {}) };
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
