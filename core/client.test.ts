import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckInIndex, SyncClient, connectivity } from "./client.ts";
import type { LogEntry, Scan } from "./sync.ts";

function scan(scanId: string): Scan {
  return { scanId, code: "B001", session: "5/22報到", at: 1000 };
}

function entry(seq: number, scanId: string, deviceId = "gate-2"): LogEntry {
  return { ...scan(scanId), seq, deviceId };
}

test("request carries every pending scan and the current cursor", () => {
  const c = new SyncClient("gate-1");
  c.enqueue(scan("s1"));
  c.enqueue(scan("s2"));
  assert.deepEqual(c.request(), { deviceId: "gate-1", cursor: 0, scans: [scan("s1"), scan("s2")] });
});

test("acked scans leave the queue; unacked ones stay for the next request", () => {
  const c = new SyncClient("gate-1");
  c.enqueue(scan("s1"));
  c.enqueue(scan("s2"));
  c.receive({ cursor: 1, acked: ["s1"], entries: [] });
  assert.deepEqual(c.pending().map((s) => s.scanId), ["s2"]);
});

test("a scan enqueued while a request is in flight is kept after the response", () => {
  const c = new SyncClient("gate-1");
  c.enqueue(scan("s1"));
  c.request();
  c.enqueue(scan("s2"));
  c.receive({ cursor: 1, acked: ["s1"], entries: [] });
  assert.deepEqual(c.pending().map((s) => s.scanId), ["s2"]);
});

test("receive advances the cursor and collects each entry once", () => {
  const c = new SyncClient("gate-1");
  c.receive({ cursor: 2, acked: [], entries: [entry(1, "a"), entry(2, "b")] });
  c.receive({ cursor: 2, acked: [], entries: [entry(2, "b")] });
  assert.equal(c.request().cursor, 2);
  assert.deepEqual(c.entries().map((e) => e.scanId), ["a", "b"]);
});

test("the cursor never moves backwards", () => {
  const c = new SyncClient("gate-1");
  c.receive({ cursor: 5, acked: [], entries: [] });
  c.receive({ cursor: 3, acked: [], entries: [] });
  assert.equal(c.request().cursor, 5);
});

const base = { now: 100_000, online: true, lastSuccessAt: 99_000, lastFailureAt: null, inFlightSince: null };

test("connectivity is ok after a recent success", () => {
  assert.equal(connectivity(base), "ok");
});

test("connectivity is offline when the latest attempt failed", () => {
  assert.equal(connectivity({ ...base, lastFailureAt: 99_500 }), "offline");
});

test("a failure older than the latest success does not count", () => {
  assert.equal(connectivity({ ...base, lastFailureAt: 98_000 }), "ok");
});

test("a request pending over 10 s is only delayed while the browser reports online", () => {
  assert.equal(connectivity({ ...base, inFlightSince: 85_000 }), "delayed");
});

test("a request pending over 10 s with the browser offline is offline", () => {
  assert.equal(connectivity({ ...base, online: false, inFlightSince: 85_000 }), "offline");
});

test("a request pending under 10 s is ok", () => {
  assert.equal(connectivity({ ...base, online: false, inFlightSince: 95_000 }), "ok");
});

test("never having synced is offline", () => {
  assert.equal(connectivity({ ...base, lastSuccessAt: null }), "offline");
});

test("CheckInIndex keeps the latest time per session and code", () => {
  const index = new CheckInIndex();
  index.load({ "5/22": { A001: 1000 } });
  index.add("5/22", "A001", 3000);
  index.add("5/22", "A001", 2000);
  index.add("5/23", "A001", 500);
  assert.equal(index.last("5/22", "A001"), 3000);
  assert.equal(index.last("5/23", "A001"), 500);
  assert.equal(index.last("5/22", "A002"), undefined);
});

test("CheckInIndex.load replaces earlier contents", () => {
  const index = new CheckInIndex();
  index.add("5/22", "A001", 1000);
  index.load({ "5/22": { A002: 2000 } });
  assert.equal(index.last("5/22", "A001"), undefined);
  assert.equal(index.last("5/22", "A002"), 2000);
});
