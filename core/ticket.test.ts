import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { CacheRow } from "./roster.ts";
import { compileRules, parseRules } from "./rules.ts";
import { keyPairFromSeed, sign } from "./serial.ts";
import { judge } from "./ticket.ts";

const keys = keyPairFromSeed(new Uint8Array(randomBytes(32)));
const roster = new Map<string, CacheRow>([["E00001", { 學員代號: "S001", 姓名: "張志豪", 序號: "E00001" }]]);
const ctx = {
  publicKey: keys.publicKey,
  rules: compileRules(
    parseRules([
      ["P03-", "拒絕", "{{序號}} 此批已作廢"],
      ["E", "需在名單", "報到成功：{{姓名}}（{{序號}}）"],
      ["P", "放行", "實體票 {{序號}}，歡迎"],
    ]).rules,
  ),
  bySerial: (serial: string) => roster.get(serial),
};

test("an invalid signature is invalid", () => {
  const [serial] = sign(keys.secretKey, "P01-00001").split(".");
  assert.deepEqual(judge(`${serial}.${"A".repeat(86)}`, ctx), { kind: "invalid" });
  assert.deepEqual(judge("S001", ctx), { kind: "invalid" });
});

test("a valid serial no rule matches is unmatched", () => {
  assert.deepEqual(judge(sign(keys.secretKey, "VIP-001"), ctx), { kind: "unmatched", serial: "VIP-001" });
});

test("a reject rule rejects with its message", () => {
  assert.deepEqual(judge(sign(keys.secretKey, "P03-00042"), ctx), {
    kind: "rejected",
    serial: "P03-00042",
    message: "P03-00042 此批已作廢",
  });
});

test("a roster-bound serial on the roster is admitted under the attendee code", () => {
  assert.deepEqual(judge(sign(keys.secretKey, "E00001"), ctx), {
    kind: "admit",
    serial: "E00001",
    code: "S001",
    message: "報到成功：張志豪（E00001）",
  });
});

test("a roster-bound serial missing from the roster is revoked", () => {
  assert.deepEqual(judge(sign(keys.secretKey, "E00002"), ctx), { kind: "revoked", serial: "E00002" });
});

test("an admit rule admits under the serial itself", () => {
  assert.deepEqual(judge(sign(keys.secretKey, "P01-00007"), ctx), {
    kind: "admit",
    serial: "P01-00007",
    code: "P01-00007",
    message: "實體票 P01-00007，歡迎",
  });
});

test("a ticket from another key pair is invalid even if the serial is on the roster", () => {
  const other = keyPairFromSeed(new Uint8Array(randomBytes(32)));
  assert.deepEqual(judge(sign(other.secretKey, "E00001"), ctx), { kind: "invalid" });
});
