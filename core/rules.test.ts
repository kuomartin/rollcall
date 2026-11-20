import { test } from "node:test";
import assert from "node:assert/strict";
import { compileRules, matchRule, parseRules, rosterFields } from "./rules.ts";

function rules(...rows: string[][]) {
  const { rules, errors } = parseRules(rows);
  assert.deepEqual(errors, []);
  return compileRules(rules);
}

test("the first matching rule wins", () => {
  const r = rules(["P03-", "拒絕", "作廢"], ["P", "放行", "實體票"]);
  assert.equal(matchRule(r, "P03-00001")?.index, 0);
  assert.equal(matchRule(r, "P04-00001")?.index, 1);
});

test("patterns are anchored at the start", () => {
  const r = rules(["P03", "放行", ""]);
  assert.equal(matchRule(r, "XP03-1"), null);
  assert.ok(matchRule(r, "P03-1"));
});

test("anchoring covers every alternative", () => {
  const r = rules(["A|B", "放行", ""]);
  assert.ok(matchRule(r, "B1"));
  assert.equal(matchRule(r, "XB1"), null);
});

test("patterns only anchor the start; $ pins the end", () => {
  const open = rules(["P03-0004", "拒絕", ""]);
  assert.ok(matchRule(open, "P03-00042"));
  const closed = rules(["P03-00042$", "拒絕", ""]);
  assert.ok(matchRule(closed, "P03-00042"));
  assert.equal(matchRule(closed, "P03-000420"), null);
});

test("matching is case-sensitive", () => {
  assert.equal(matchRule(rules(["vip", "放行", ""]), "VIP-0001"), null);
});

test("no matching rule returns null", () => {
  assert.equal(matchRule(rules(["E", "需在名單", ""]), "P03-1"), null);
});

test("blank rows are skipped and values are trimmed", () => {
  const { rules: parsed, errors } = parseRules([["", "", ""], [" P ", " 放行 ", " 歡迎 "]]);
  assert.deepEqual(errors, []);
  assert.deepEqual(parsed, [{ pattern: "P", action: "放行", message: "歡迎" }]);
});

test("invalid rows are reported with their sheet row number", () => {
  const { errors } = parseRules([["P(", "放行", ""], ["P", "通過", ""], ["", "放行", "x"]]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /^第 2 列：.*regex/);
  assert.match(errors[1], /^第 3 列：動作/);
  assert.match(errors[2], /^第 4 列：比對不可空白/);
});

test("rosterFields collects fields from roster-bound rules only", () => {
  const { rules: parsed } = parseRules([
    ["VIP", "需在名單", "貴賓 {{姓名}}（{{序號}}）"],
    ["E", "需在名單", "{{姓名}} {{班級}}"],
    ["P", "放行", "{{座位}}"],
  ]);
  assert.deepEqual(rosterFields(parsed), ["姓名", "班級"]);
});
