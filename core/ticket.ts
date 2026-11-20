// 票券模式的掃描判定：驗章 → 比對票種規則 → 依動作查名單（docs/adr/0008-ticket-mode.md）。
// 重複報到的提醒由呼叫端依回傳的 code 判斷，與代號模式共用。

import { CODE_FIELD, type CacheRow } from "./roster.ts";
import { matchRule, SERIAL_FIELD, type CompiledRule } from "./rules.ts";
import { verifyToken } from "./serial.ts";
import { renderTemplate } from "./template.ts";

export type Verdict =
  | { kind: "invalid" }
  | { kind: "unmatched"; serial: string }
  | { kind: "rejected"; serial: string; message: string }
  | { kind: "revoked"; serial: string }
  /** code：寫進報到紀錄的值。需在名單的票是學員代號，放行的票是序號。 */
  | { kind: "admit"; serial: string; code: string; message: string };

export interface TicketContext {
  publicKey: Uint8Array;
  rules: readonly CompiledRule[];
  bySerial(serial: string): CacheRow | undefined;
}

export function judge(token: string, ctx: TicketContext): Verdict {
  const serial = verifyToken(ctx.publicKey, token);
  if (serial === null) return { kind: "invalid" };
  const match = matchRule(ctx.rules, serial);
  if (!match) return { kind: "unmatched", serial };
  const { rule } = match;
  switch (rule.action) {
    case "拒絕":
      return { kind: "rejected", serial, message: renderTemplate(rule.message, { [SERIAL_FIELD]: serial }) };
    case "放行":
      return { kind: "admit", serial, code: serial, message: renderTemplate(rule.message, { [SERIAL_FIELD]: serial }) };
    case "需在名單": {
      const row = ctx.bySerial(serial);
      if (!row) return { kind: "revoked", serial };
      return {
        kind: "admit",
        serial,
        code: row[CODE_FIELD],
        message: renderTemplate(rule.message, { ...row, [SERIAL_FIELD]: serial }),
      };
    }
  }
}
