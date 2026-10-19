import { test } from "node:test";
import assert from "node:assert/strict";
import { applySync, type LogEntry, type LogStore, type RosterStore, type Scan } from "./sync.ts";

function fakeLog(): LogStore & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    knownScanIds: (ids) => new Set(entries.filter((e) => ids.includes(e.scanId)).map((e) => e.scanId)),
    lastSeq: () => (entries.length ? entries[entries.length - 1].seq : 0),
    append: (batch) => entries.push(...batch),
    since: (cursor) => entries.filter((e) => e.seq > cursor),
  };
}

function fakeRoster(): RosterStore & { marks: Array<[string, string, number]> } {
  const marks: Array<[string, string, number]> = [];
  return { marks, markCheckedIn: (session, code, at) => marks.push([session, code, at]) };
}

function scan(scanId: string, code: string, at = 1000, session = "5/22報到"): Scan {
  return { scanId, code, session, at };
}

test("appends new scans with increasing seq and returns the new cursor", () => {
  const log = fakeLog();
  const res = applySync(log, fakeRoster(), {
    deviceId: "gate-1",
    cursor: 0,
    scans: [scan("s1", "B001"), scan("s2", "B002")],
  });
  assert.deepEqual(log.entries.map((e) => [e.seq, e.scanId, e.deviceId]), [
    [1, "s1", "gate-1"],
    [2, "s2", "gate-1"],
  ]);
  assert.equal(res.cursor, 2);
  assert.deepEqual(res.acked, ["s1", "s2"]);
});

test("a resent scan is acked but not appended twice", () => {
  const log = fakeLog();
  const roster = fakeRoster();
  applySync(log, roster, { deviceId: "gate-1", cursor: 0, scans: [scan("s1", "B001")] });
  const res = applySync(log, roster, { deviceId: "gate-1", cursor: 0, scans: [scan("s1", "B001")] });
  assert.equal(log.entries.length, 1);
  assert.deepEqual(res.acked, ["s1"]);
});

test("duplicate scanIds within one batch are appended once", () => {
  const log = fakeLog();
  applySync(log, fakeRoster(), { deviceId: "gate-1", cursor: 0, scans: [scan("s1", "B001"), scan("s1", "B001")] });
  assert.equal(log.entries.length, 1);
});

test("returns entries after the cursor except the scans in this request", () => {
  const log = fakeLog();
  const roster = fakeRoster();
  applySync(log, roster, { deviceId: "gate-2", cursor: 0, scans: [scan("a", "B010")] });
  const res = applySync(log, roster, { deviceId: "gate-1", cursor: 0, scans: [scan("b", "B011")] });
  assert.deepEqual(res.entries.map((e) => e.scanId), ["a"]);
  const next = applySync(log, roster, { deviceId: "gate-1", cursor: res.cursor, scans: [] });
  assert.deepEqual(next.entries, []);
});

test("a device starting from cursor 0 gets its own earlier entries back", () => {
  const log = fakeLog();
  const roster = fakeRoster();
  applySync(log, roster, { deviceId: "gate-1", cursor: 0, scans: [scan("mine", "B001")] });
  const reloaded = applySync(log, roster, { deviceId: "gate-1", cursor: 0, scans: [] });
  assert.deepEqual(reloaded.entries.map((e) => e.scanId), ["mine"]);
});

test("an empty batch still returns entries and the current cursor", () => {
  const log = fakeLog();
  const roster = fakeRoster();
  applySync(log, roster, { deviceId: "gate-2", cursor: 0, scans: [scan("a", "B010")] });
  const res = applySync(log, roster, { deviceId: "gate-1", cursor: 0, scans: [] });
  assert.equal(res.cursor, 1);
  assert.deepEqual(res.entries.map((e) => e.scanId), ["a"]);
});

test("marks the roster once per attendee and session with the latest time in the batch", () => {
  const roster = fakeRoster();
  applySync(fakeLog(), roster, {
    deviceId: "gate-1",
    cursor: 0,
    scans: [scan("s1", "B001", 1000), scan("s2", "B001", 3000), scan("s3", "B001", 2000), scan("s4", "B001", 500, "5/23報到")],
  });
  assert.deepEqual(roster.marks, [
    ["5/22報到", "B001", 3000],
    ["5/23報到", "B001", 500],
  ]);
});

test("resent scans do not mark the roster again", () => {
  const log = fakeLog();
  const roster = fakeRoster();
  applySync(log, roster, { deviceId: "gate-1", cursor: 0, scans: [scan("s1", "B001")] });
  applySync(log, roster, { deviceId: "gate-1", cursor: 0, scans: [scan("s1", "B001")] });
  assert.equal(roster.marks.length, 1);
});
