import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  formatSerial,
  fromBase64url,
  isValidPrefix,
  isValidSerial,
  keyPairFromSeed,
  parseToken,
  sign,
  splitPrefix,
  toBase64url,
  verifyToken,
} from "./serial.ts";

const seed = new Uint8Array(randomBytes(32));
const keys = keyPairFromSeed(seed);

test("base64url round-trips every length", () => {
  for (let n = 0; n <= 70; n++) {
    const bytes = new Uint8Array(randomBytes(n));
    const text = toBase64url(bytes);
    assert.match(text, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual(fromBase64url(text), bytes);
  }
});

test("token is the serial, a dot, and an 86-char signature", () => {
  assert.match(sign(keys.secretKey, "P03-00042"), /^P03-00042\.[A-Za-z0-9_-]{86}$/);
});

test("verifyToken returns the serial for the matching key", () => {
  assert.equal(verifyToken(keys.publicKey, sign(keys.secretKey, "VIP-001")), "VIP-001");
});

test("verifyToken ignores surrounding whitespace", () => {
  assert.equal(verifyToken(keys.publicKey, ` ${sign(keys.secretKey, "A1")}\n`), "A1");
});

test("verifyToken rejects another key pair", () => {
  const other = keyPairFromSeed(new Uint8Array(randomBytes(32)));
  assert.equal(verifyToken(other.publicKey, sign(keys.secretKey, "A1")), null);
});

test("changing any character of the serial breaks the signature", () => {
  const [, sig] = sign(keys.secretKey, "P03-00042").split(".");
  for (const forged of ["VIP03-00042", "P03-00043", "p03-00042", "P03-0004", "P03-000420"]) {
    assert.equal(verifyToken(keys.publicKey, `${forged}.${sig}`), null, forged);
  }
});

test("a tampered signature is rejected", () => {
  const [serial, sig] = sign(keys.secretKey, "A1").split(".");
  const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  assert.equal(verifyToken(keys.publicKey, `${serial}.${flipped}`), null);
});

test("malformed tokens are rejected", () => {
  const sig = "A".repeat(86);
  for (const bad of ["", "abc", "a.b.c", `A1.${"A".repeat(85)}`, `A1.${"*".repeat(86)}`, `${"A".repeat(33)}.${sig}`, `中.${sig}`]) {
    assert.equal(parseToken(bad), null, bad);
    assert.equal(verifyToken(keys.publicKey, bad), null, bad);
  }
});

test("sign refuses serials outside the allowed characters or length", () => {
  for (const bad of ["", "A.1", "A/1", "中文", "A".repeat(33)]) {
    assert.throws(() => sign(keys.secretKey, bad), /序號格式不符/, bad);
  }
});

test("the same seed gives the same key pair", () => {
  assert.deepEqual(keyPairFromSeed(seed), keys);
});

test("isValidSerial", () => {
  assert.ok(isValidSerial("VIP_a-1"));
  assert.ok(isValidSerial("A".repeat(32)));
  assert.ok(!isValidSerial("A B"));
});

test("prefixes must not end with a digit", () => {
  for (const ok of ["P03-", "VIP_", "A", "x"]) assert.ok(isValidPrefix(ok), ok);
  for (const bad of ["", "P03", "P0", "A.", "中"]) assert.ok(!isValidPrefix(bad), bad);
});

test("splitPrefix cuts the trailing digit run", () => {
  assert.deepEqual(splitPrefix("P03-00042"), { prefix: "P03-", digits: "00042" });
  assert.deepEqual(splitPrefix("VIP-001"), { prefix: "VIP-", digits: "001" });
  assert.deepEqual(splitPrefix("ABC"), { prefix: "ABC", digits: "" });
  assert.deepEqual(splitPrefix("00042"), { prefix: "", digits: "00042" });
});

test("serials from different valid prefixes never collide", () => {
  const prefixes = ["P", "P0-", "P-", "PA", "A_", "a"];
  const seen = new Map<string, string>();
  for (const prefix of prefixes) {
    for (let n = 0; n < 200; n++) {
      for (const width of [1, 3, 5]) {
        const serial = formatSerial(prefix, n, width);
        if (!/^\d+$/.test(serial.slice(prefix.length))) continue;
        assert.equal(splitPrefix(serial).prefix, prefix);
        const owner = seen.get(serial);
        assert.ok(owner === undefined || owner === prefix, `${serial} from ${owner} and ${prefix}`);
        seen.set(serial, prefix);
      }
    }
  }
});

test("formatSerial pads to the width", () => {
  assert.equal(formatSerial("P03-", 42, 5), "P03-00042");
  assert.equal(formatSerial("A", 123456, 5), "A123456");
});
