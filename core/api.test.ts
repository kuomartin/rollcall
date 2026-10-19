import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequest } from "./api.ts";

test("parses bootstrap and lookup", () => {
  assert.deepEqual(parseRequest({ action: "bootstrap" }), { action: "bootstrap" });
  assert.deepEqual(parseRequest({ action: "lookup", query: "0912345678" }), { action: "lookup", query: "0912345678" });
});

test("parses sync and drops unknown properties", () => {
  const req = parseRequest({
    action: "sync",
    deviceId: "gate-1",
    cursor: 3,
    scans: [{ scanId: "s1", code: "A001", session: "報到", at: 1000, extra: true }],
    extra: 1,
  });
  assert.deepEqual(req, {
    action: "sync",
    deviceId: "gate-1",
    cursor: 3,
    scans: [{ scanId: "s1", code: "A001", session: "報到", at: 1000 }],
  });
});

test("rejects malformed requests", () => {
  for (const bad of [
    null,
    "sync",
    { action: "drop" },
    { action: "lookup" },
    { action: "sync", deviceId: "g", cursor: -1, scans: [] },
    { action: "sync", deviceId: "g", cursor: 0, scans: [{ scanId: "s", code: "A", session: "報到", at: "now" }] },
    { action: "sync", deviceId: "", cursor: 0, scans: [] },
    { action: "sync", deviceId: "g", cursor: 0, scans: "x" },
  ]) {
    assert.throws(() => parseRequest(bad), JSON.stringify(bad));
  }
});

test("rejects oversized batches", () => {
  const scans = Array.from({ length: 501 }, (_, i) => ({ scanId: `s${i}`, code: "A", session: "報到", at: 1 }));
  assert.throws(() => parseRequest({ action: "sync", deviceId: "g", cursor: 0, scans }));
});
