import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRosterCache, cacheRow, findRow, maskPhone, missingRequired, type RosterTable } from "./roster.ts";

const table: RosterTable = {
  headers: ["學員代號", "姓名", "手機", "班級", "備註"],
  rows: [
    ["A001", "張志豪", "0912345678", "甲", "素食"],
    ["A002", "李美玲", "0922-333-444", "乙", ""],
    [1003, "王小明", 933111222, "丙", null],
  ],
};

test("cache carries the code plus only the fields the template references", () => {
  const cache = buildRosterCache(table, "歡迎 {{姓名}}（{{班級}}）", "v1");
  assert.deepEqual(cache.fields, ["姓名", "班級"]);
  assert.deepEqual(cache.rows[0], { 學員代號: "A001", 姓名: "張志豪", 班級: "甲" });
  assert.equal(cache.version, "v1");
});

test("cache never carries the raw phone number", () => {
  const cache = buildRosterCache(table, "{{姓名}} {{手機}}", "v1");
  assert.equal(cache.rows[0]["手機"], "*******678");
  assert.ok(!JSON.stringify(cache).includes("0912345678"));
});

test("cache ignores template fields missing from the header", () => {
  assert.deepEqual(buildRosterCache(table, "{{姓名}} {{序號}}", "v1").fields, ["姓名"]);
});

test("cache stringifies values and turns blanks into empty strings", () => {
  const cache = buildRosterCache(table, "{{備註}}", "v1");
  assert.deepEqual(cache.rows[2], { 學員代號: "1003", 備註: "" });
});

test("cache skips rows without a code", () => {
  const cache = buildRosterCache({ headers: table.headers, rows: [...table.rows, ["", "空白", "", "", ""]] }, "", "v1");
  assert.equal(cache.rows.length, 3);
});

test("findRow matches the code exactly", () => {
  assert.equal(findRow(table, "A002"), 1);
  assert.equal(findRow(table, " A002 "), 1);
  assert.equal(findRow(table, "1003"), 2);
});

test("findRow falls back to the phone, ignoring separators and a dropped leading zero", () => {
  assert.equal(findRow(table, "0922333444"), 1);
  assert.equal(findRow(table, "0912-345-678"), 0);
  assert.equal(findRow(table, "0933111222"), 2);
});

test("findRow returns -1 when nothing matches", () => {
  assert.equal(findRow(table, "A999"), -1);
  assert.equal(findRow(table, ""), -1);
});

test("cacheRow builds the same shape as the cache rows", () => {
  const cache = buildRosterCache(table, "{{姓名}} {{手機}}", "v1");
  assert.deepEqual(cacheRow(table, 1, cache.fields), cache.rows[1]);
});

test("maskPhone keeps only the last three digits", () => {
  assert.equal(maskPhone("0922-333-444"), "*******444");
  assert.equal(maskPhone("12"), "**");
});

test("missingRequired reports a roster without the code column", () => {
  assert.deepEqual(missingRequired(["姓名", "手機"]), ["學員代號"]);
  assert.deepEqual(missingRequired(table.headers), []);
});
