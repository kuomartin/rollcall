// 票種規則：依序號決定放行、需在名單或拒絕（docs/adr/0008-ticket-mode.md）。
// 由上往下比對，第一條符合的生效；比對是從序號開頭起算的 regex，區分大小寫。

import { referencedFields } from "./template.ts";

export const RULE_HEADERS = ["比對", "動作", "訊息"] as const;
export const RULE_ACTIONS = ["放行", "需在名單", "拒絕"] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

/** 訊息裡代入序號的欄位名稱。 */
export const SERIAL_FIELD = "序號";

export interface Rule {
  pattern: string;
  action: RuleAction;
  message: string;
}

export interface CompiledRule extends Rule {
  re: RegExp;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/** 開頭錨定：`P03` 不會比對到 `XP03-1`。 */
function compile(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})`);
}

/**
 * 讀取「票種規則」分頁第 1 列標題之後的列。整列空白的略過；
 * 有任何一列不合格就回傳錯誤，讓主辦方修正，不要帶著寫錯的規則上場。
 */
export function parseRules(rows: readonly (readonly unknown[])[]): { rules: Rule[]; errors: string[] } {
  const rules: Rule[] = [];
  const errors: string[] = [];
  rows.forEach((row, i) => {
    const [pattern, action, message] = [0, 1, 2].map((c) => text(row[c]));
    if (!pattern && !action && !message) return;
    const where = `第 ${i + 2} 列`;
    if (!pattern) {
      errors.push(`${where}：比對不可空白`);
      return;
    }
    try {
      compile(pattern);
    } catch {
      errors.push(`${where}：比對不是有效的 regex：${pattern}`);
      return;
    }
    if (!(RULE_ACTIONS as readonly string[]).includes(action)) {
      errors.push(`${where}：動作必須是 ${RULE_ACTIONS.join("、")}`);
      return;
    }
    rules.push({ pattern, action: action as RuleAction, message });
  });
  return { rules, errors };
}

export function compileRules(rules: readonly Rule[]): CompiledRule[] {
  return rules.map((rule) => ({ ...rule, re: compile(rule.pattern) }));
}

/** 第一條符合的規則與它的索引（從 0 起算），沒有符合為 null。 */
export function matchRule(rules: readonly CompiledRule[], serial: string): { index: number; rule: CompiledRule } | null {
  const index = rules.findIndex((rule) => rule.re.test(serial));
  return index === -1 ? null : { index, rule: rules[index] };
}

/** 「需在名單」規則的訊息引用到的名單欄位；名單快取只帶這些欄位。 */
export function rosterFields(rules: readonly Rule[]): string[] {
  const fields = new Set<string>();
  for (const rule of rules) {
    if (rule.action !== "需在名單") continue;
    for (const field of referencedFields(rule.message)) if (field !== SERIAL_FIELD) fields.add(field);
  }
  return [...fields];
}
