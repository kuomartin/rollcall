// doPost 的動作（PLAN 3、4.1、4.1c）。

import type { ApiRequest, BootstrapResult, LookupResult, SyncResult } from "../../core/api.ts";
import { buildRosterCache, cacheFields, cacheRow, findRow } from "../../core/roster.ts";
import { applySync, type SyncRequest } from "../../core/sync.ts";
import { getSettings, rosterVersion } from "./settings.ts";
import { readRoster, SheetLogStore, SheetRosterStore } from "./sheets.ts";

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

function sync(req: SyncRequest): SyncResult {
  const { sessions } = getSettings();
  const unknown = [...new Set(req.scans.map((s) => s.session))].filter((s) => !sessions.includes(s));
  if (unknown.length) throw new Error(`未知場次：${unknown.join("、")}`);

  const roster = readRoster();
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    const res = applySync(new SheetLogStore(sessions, roster), new SheetRosterStore(roster), req);
    SpreadsheetApp.flush();
    return { ...res, rosterVersion: rosterVersion() };
  } finally {
    lock.releaseLock();
  }
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
