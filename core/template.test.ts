import { test } from "node:test";
import assert from "node:assert/strict";
import { referencedFields, renderTemplate, unknownFields } from "./template.ts";

const headers = ["學員代號", "姓名", "手機", "班級"];

test("referencedFields lists each field once, in order", () => {
  assert.deepEqual(referencedFields("{{姓名}}／{{班級}}／{{姓名}}"), ["姓名", "班級"]);
});

test("referencedFields trims whitespace inside braces", () => {
  assert.deepEqual(referencedFields("{{ 姓名 }}"), ["姓名"]);
});

test("unknownFields flags fields missing from the roster header", () => {
  assert.deepEqual(unknownFields("報到成功；姓名：{{姓名}}，序號：{{序號}}", headers), ["序號"]);
});

test("unknownFields is empty for a valid template", () => {
  assert.deepEqual(unknownFields("歡迎 {{姓名}}（{{班級}}）", headers), []);
});

test("renderTemplate substitutes values", () => {
  assert.equal(renderTemplate("歡迎 {{姓名}}", { 姓名: "張志豪" }), "歡迎 張志豪");
});

test("renderTemplate renders missing and empty values as empty strings", () => {
  assert.equal(renderTemplate("{{姓名}}-{{班級}}-{{序號}}", { 姓名: "張志豪", 班級: null }), "張志豪--");
});

test("renderTemplate stringifies non-string values", () => {
  assert.equal(renderTemplate("座位 {{座位}}", { 座位: 12 }), "座位 12");
});
