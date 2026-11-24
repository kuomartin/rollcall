// 只在 `npm run build -- --dev` 的建置裡存在：讓端到端測試能建立假名單、讀回寫入結果、清除場次。
// 正式建置時 __DEV__ 為 false，doPost 不會呼叫這裡，esbuild 會把整段移除。

import nacl from "tweetnacl";
import { keyPairFromSeed, sign, toBase64url } from "../../core/serial.ts";
import { bumpRosterVersion, saveSettings, storePrefixes, storeSigningKeys } from "./settings.ts";
import { ensureLogSheet, LOG_HEADERS, ROSTER_SHEET } from "./sheets.ts";
import { clearSession, ensureMarkColumns } from "./store.ts";
import { ensureTicketSheets, qrCellImage, randomBytes, RULES_SHEET, TICKET_FIELD, TICKET_QR_FIELD } from "./tickets.ts";

const DEV_HEADERS = ["學員代號", "姓名", "手機", "班級"];

function seed(count: number, sessions: string[]): unknown {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone("Asia/Taipei");
  const roster = ss.getSheetByName(ROSTER_SHEET) ?? ss.insertSheet(ROSTER_SHEET, 0);
  roster.clear();
  const rows = Array.from({ length: count }, (_, i) => [
    `T${String(i + 1).padStart(4, "0")}`,
    `測試學員${i + 1}`,
    `'09${String(10_000_000 + i)}`,
    `${"甲乙丙丁"[i % 4]}班`,
  ]);
  roster.getRange(1, 1, 1, DEV_HEADERS.length).setValues([DEV_HEADERS]);
  roster.getRange(2, 1, rows.length, DEV_HEADERS.length).setValues(rows);

  for (const session of sessions) {
    const existing = ss.getSheetByName(session);
    if (existing) ss.deleteSheet(existing);
    ensureLogSheet(session).getRange(1, LOG_HEADERS.length + 1, 1, 2).setValues([["姓名", "班級"]]);
  }
  saveSettings({ template: "報到成功；姓名：{{姓名}}，班級：{{班級}}", sessions, mode: "code" });
  ensureMarkColumns(sessions);
  const props = PropertiesService.getScriptProperties();
  for (const key of props.getKeys()) if (key === "seq" || key.startsWith("row:")) props.deleteProperty(key);
  CacheService.getScriptCache().remove("recent");
  return { roster: count, sessions };
}

/**
 * 在 seed 之後切換成票券模式：前 signed 位學員簽發 E 序號，另外簽幾張不進名單的實體票，回傳票券讓測試掃描。
 * 名單上的前兩張寫入 QR 儲存格圖片，確認 data URL 的圖片寫得進去。
 */
function ticketSeed(signed: number, sessions: string[]): unknown {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  saveSettings({ template: "報到成功；姓名：{{姓名}}", sessions, mode: "ticket" });
  const rules = ss.getSheetByName(RULES_SHEET);
  if (rules) ss.deleteSheet(rules);
  ensureTicketSheets();
  ss.getSheetByName(RULES_SHEET)!.getRange(2, 1, 4, 3).setValues([
    ["P09-", "拒絕", "{{序號}} 此批已作廢"],
    ["E", "需在名單", "報到成功：{{姓名}}（{{班級}}）"],
    ["P", "放行", "實體票 {{序號}}，歡迎入場"],
    ["X", "需在名單", "不在名單的票"],
  ]);
  const seed = randomBytes(nacl.sign.seedLength);
  const keys = keyPairFromSeed(seed);
  storeSigningKeys(toBase64url(seed), toBase64url(keys.publicKey));

  const roster = ss.getSheetByName(ROSTER_SHEET)!;
  const headers = roster.getRange(1, 1, 1, roster.getLastColumn()).getValues()[0].map(String);
  const col = (h: string) => headers.indexOf(h) + 1;
  const serials = Array.from({ length: signed }, (_, i) => `E${String(i + 1).padStart(5, "0")}`);
  const tokens = serials.map((s) => sign(keys.secretKey, s));
  roster.getRange(2, col("序號"), signed, 1).setValues(serials.map((s) => [s]));
  roster.getRange(2, col(TICKET_FIELD), signed, 1).setValues(tokens.map((t) => [t]));
  roster.getRange(2, col(TICKET_QR_FIELD), 2, 1).setValues(tokens.slice(0, 2).map((t) => [qrCellImage(t)]));
  storePrefixes({ E: { use: "名單", next: signed + 1, width: 5 }, "P01-": { use: "實體", next: 4, width: 5 } });

  const other = keyPairFromSeed(randomBytes(nacl.sign.seedLength));
  return {
    roster: tokens,
    physical: ["P01-00001", "P01-00002", "P01-00003"].map((s) => sign(keys.secretKey, s)),
    revokedBatch: sign(keys.secretKey, "P09-00001"),
    revokedRoster: sign(keys.secretKey, `E${String(signed + 1).padStart(5, "0")}`),
    unmatched: sign(keys.secretKey, "VIP-001"),
    otherKey: sign(other.secretKey, "P01-00001"),
  };
}

/** 覆寫票種規則（第 2 列起），模擬主辦方在活動中編輯。 */
function setRules(rows: string[][]): unknown {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RULES_SHEET)!;
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, 3).setValues(rows);
  bumpRosterVersion();
  return { rules: rows.length };
}

function dump(): unknown {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return Object.fromEntries(
    ss.getSheets().map((s) => {
      const values = s.getDataRange().getDisplayValues();
      return [s.getName(), { rows: values.length - 1, head: values.slice(0, 3), all: values.map((r) => r.slice(0, 5)) }];
    }),
  );
}

export function devHandle(body: unknown): unknown {
  const b = body as { action?: string; count?: number; sessions?: string[]; session?: string; signed?: number; rows?: string[][] };
  if (b.action === "devSeed") return seed(b.count ?? 40, b.sessions ?? ["報到"]);
  if (b.action === "devDump") return dump();
  if (b.action === "devRules" && b.rows) return setRules(b.rows);
  if (b.action === "devTicketSeed") return ticketSeed(b.signed ?? 5, b.sessions ?? ["報到"]);
  if (b.action === "devClear" && b.session) {
    clearSession(b.session);
    return { cleared: b.session };
  }
  return undefined;
}
