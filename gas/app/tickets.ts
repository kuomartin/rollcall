// 票券模式的試算表端：金鑰對、填入流水號、簽發、實體票、票種規則（docs/adr/0008-ticket-mode.md）。
// 這些都是主辦方從選單執行的動作，訊息用對話框回報。

import qrcode from "qrcode-generator";
import nacl from "tweetnacl";
import { CODE_FIELD, SERIAL_FIELD } from "../../core/roster.ts";
import { compileRules, matchRule, parseRules, RULE_ACTIONS, RULE_HEADERS, type Rule } from "../../core/rules.ts";
import {
  DEFAULT_WIDTH,
  formatSerial,
  fromBase64url,
  isValidPrefix,
  isValidSerial,
  keyPairFromSeed,
  sign,
  splitPrefix,
  toBase64url,
  verifyToken,
  type KeyPair,
} from "../../core/serial.ts";
import { renderTemplate } from "../../core/template.ts";
import {
  bumpRosterVersion,
  prefixes,
  signingKeys,
  storePrefixes,
  storeSigningKeys,
  type PrefixEntry,
  type PrefixUse,
} from "./settings.ts";
import { readRoster, ROSTER_SHEET, rosterSheet } from "./sheets.ts";

export const RULES_SHEET = "票種規則";
export const TICKET_FIELD = "票券";
export const TICKET_QR_FIELD = "票券 QR";
const TICKET_COLUMNS = [SERIAL_FIELD, TICKET_FIELD, TICKET_QR_FIELD];
const QR_SIZE_PX = 120;
const MAX_PHYSICAL = 500;
const MAX_WIDTH = 10;
const MAX_LISTED_ERRORS = 20;
const LOCK_WAIT_MS = 20_000;

type Sheet = GoogleAppsScript.Spreadsheet.Sheet;

function ui(): GoogleAppsScript.Base.Ui {
  return SpreadsheetApp.getUi();
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/**
 * Apps Script 沒有 CSPRNG；Utilities.getUuid() 每次給 122 bits 的隨機值，
 * 把多個 UUID 與時間戳一起過 SHA-512 後取所需長度。只用於金鑰種子，序號是流水號不需要亂數。
 */
function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let filled = 0;
  for (let counter = 0; filled < n; counter++) {
    const material = `${Utilities.getUuid()}${Utilities.getUuid()}${Utilities.getUuid()}${Date.now()}:${counter}`;
    const digest = nacl.hash(Uint8Array.from(Utilities.newBlob(material).getBytes(), (b) => b & 255));
    for (let i = 0; i < digest.length && filled < n; i++) out[filled++] = digest[i];
  }
  return out;
}

function currentKeys(): KeyPair | null {
  const stored = signingKeys();
  const seed = stored && fromBase64url(stored.seed);
  return seed ? keyPairFromSeed(seed) : null;
}

function requireKeys(): KeyPair | null {
  const keys = currentKeys();
  if (!keys) ui().alert("尚未產生金鑰對，請先執行「票券 → 產生金鑰對」。");
  return keys;
}

function qrCellImage(token: string): GoogleAppsScript.Spreadsheet.CellImage {
  const qr = qrcode(0, "M");
  qr.addData(token);
  qr.make();
  return SpreadsheetApp.newCellImage().setSourceUrl(qr.createDataURL(4, 2)).setAltTextTitle(token).build();
}

function headersOf(sheet: Sheet): string[] {
  return sheet
    .getRange(1, 1, 1, Math.max(1, sheet.getLastColumn()))
    .getValues()[0]
    .map((h) => String(h).trim());
}

/** 切換成票券模式時呼叫：建立票種規則分頁，學員名單補上序號、票券、票券 QR 三欄。 */
export function ensureTicketSheets(): void {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(RULES_SHEET)) {
    const sheet = ss.insertSheet(RULES_SHEET);
    sheet.getRange(1, 1, 1, RULE_HEADERS.length).setValues([[...RULE_HEADERS]]);
    sheet.getRange("A:A").setNumberFormat("@");
    sheet
      .getRange(2, 2, sheet.getMaxRows() - 1, 1)
      .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList([...RULE_ACTIONS], true).build());
    sheet
      .getRange(1, 1)
      .setNote(
        "由上往下比對，第一條符合的生效；沒有任何一條符合就拒絕。\n" +
          "比對是從序號開頭起算的 regex，區分大小寫；要比對到結尾就加 $。\n" +
          "訊息可用 {{序號}}；動作為「需在名單」時也能用學員名單的欄位。",
      );
    sheet.setFrozenRows(1);
  }

  const roster = rosterSheet();
  const headers = headersOf(roster);
  const missing = TICKET_COLUMNS.filter((h) => !headers.includes(h));
  if (missing.length) {
    roster.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers.push(...missing);
  }
  roster.getRange(1, headers.indexOf(SERIAL_FIELD) + 1, roster.getMaxRows(), 1).setNumberFormat("@");
  if (roster.getColumnWidth(headers.indexOf(TICKET_QR_FIELD) + 1) < QR_SIZE_PX) {
    roster.setColumnWidth(headers.indexOf(TICKET_QR_FIELD) + 1, QR_SIZE_PX);
  }
}

export function readRules(): { rules: Rule[]; errors: string[] } {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RULES_SHEET);
  if (!sheet) return { rules: [], errors: [`找不到「${RULES_SHEET}」分頁`] };
  const [, ...rows] = sheet.getDataRange().getValues();
  return parseRules(rows);
}

export function generateKeyPair(): void {
  const registry = prefixes();
  if (signingKeys()) {
    const answer = ui().alert(
      "已經有金鑰對",
      "產生新金鑰對後，先前簽發的票券（名單上的與實體票）全部無法再通過驗章，名單上的票券要重新「簽發」。\n" +
        "測試時掃過的場次，請先用「報到 → 清除報到紀錄」清掉，否則同號的新票會被當成已入場。\n\n確定要覆寫？",
      ui().ButtonSet.YES_NO,
    );
    if (answer !== ui().Button.YES) return;
    const physical = Object.keys(registry).filter((p) => registry[p].use === "實體");
    if (physical.length) {
      const reset = ui().alert(
        "實體票前綴",
        `要將實體票前綴的計數歸零嗎？（${physical.join("、")}）\n名單用途的前綴不受影響：名單上的序號還在，歸零會撞號。`,
        ui().ButtonSet.YES_NO,
      );
      if (reset === ui().Button.YES) {
        withLock(() => {
          const current = prefixes();
          for (const p of physical) delete current[p];
          storePrefixes(current);
        });
      }
    }
  }
  const seed = randomBytes(nacl.sign.seedLength);
  const keys = keyPairFromSeed(seed);
  storeSigningKeys(toBase64url(seed), toBase64url(keys.publicKey));
  ui().alert("金鑰對已產生", "接著用「票券 → 簽發選取的列」簽發名單上的票券。", ui().ButtonSet.OK);
}

/** 只在讀改寫前綴登記的瞬間持有 lock：同步也用這把 lock，不能在簽章、寫 Sheet 時佔著。 */
function withLock<T>(fn: () => T): T {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function askPrefix(title: string, use: PrefixUse): { prefix: string; entry?: PrefixEntry } | null {
  const res = ui().prompt(title, "前綴（結尾不能是數字，例如 P03- 或 VIP_）：", ui().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui().Button.OK) return null;
  const prefix = res.getResponseText().trim();
  if (!isValidPrefix(prefix)) {
    ui().alert("前綴只能用英數字、- 與 _，而且結尾不能是數字。");
    return null;
  }
  const entry = prefixes()[prefix];
  if (entry && entry.use !== use) {
    ui().alert(`前綴「${prefix}」已經用於${entry.use === "實體" ? "實體票" : "名單上的序號"}，一個前綴只能有一種用途。`);
    return null;
  }
  return { prefix, entry };
}

/** 新前綴才問位數，之後固定。 */
function askWidth(prefix: string, entry: PrefixEntry | undefined): number | null {
  if (entry) return entry.width;
  const res = ui().prompt("位數", `「${prefix}」的流水號位數（留空為 ${DEFAULT_WIDTH}）：`, ui().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui().Button.OK) return null;
  const raw = res.getResponseText().trim();
  const width = raw ? Number(raw) : DEFAULT_WIDTH;
  if (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH || prefix.length + width > 32) {
    ui().alert(`位數必須是 1 到 ${MAX_WIDTH} 的整數，而且前綴加位數不超過 32 字。`);
    return null;
  }
  return width;
}

/** 依登記發出 count 個號碼，跳過 taken 裡已有的序號；回傳發出的序號。 */
function reserve(prefix: string, use: PrefixUse, width: number, count: number, taken: ReadonlySet<string>): string[] {
  return withLock(() => {
    const registry = prefixes();
    const entry = registry[prefix] ?? { use, next: 1, width };
    if (entry.use !== use) throw new Error(`前綴「${prefix}」已經用於其他用途`);
    const out: string[] = [];
    let n = entry.next;
    while (out.length < count) {
      const serial = formatSerial(prefix, n++, entry.width);
      if (!taken.has(serial)) out.push(serial);
    }
    if (!isValidSerial(out[out.length - 1])) throw new Error(`序號超過 32 字：${out[out.length - 1]}`);
    registry[prefix] = { ...entry, next: n };
    storePrefixes(registry);
    return out;
  });
}

interface RosterColumns {
  sheet: Sheet;
  headers: readonly string[];
  rows: readonly (readonly unknown[])[];
  code: number;
  serial: number;
  ticket: number;
  qr: number;
}

function rosterColumns(): RosterColumns | null {
  const roster = readRoster();
  const [code, serial, ticket, qr] = [CODE_FIELD, ...TICKET_COLUMNS].map((h) => roster.headers.indexOf(h));
  if ([code, serial, ticket, qr].includes(-1)) {
    ui().alert(`學員名單缺少「${[CODE_FIELD, ...TICKET_COLUMNS].join("、")}」其中的欄位。請先在「報到 → 設定」切換成票券模式。`);
    return null;
  }
  return { sheet: rosterSheet(), headers: roster.headers, rows: roster.rows, code, serial, ticket, qr };
}

/** 選取範圍在學員名單上涵蓋的資料列（0 起算，不含標題列）。 */
function selectedRosterRows(): number[] | null {
  const range = SpreadsheetApp.getActiveRange();
  if (!range || range.getSheet().getName() !== ROSTER_SHEET) {
    ui().alert(`請先在「${ROSTER_SHEET}」選取要處理的列。`);
    return null;
  }
  const first = Math.max(2, range.getRow());
  const last = range.getLastRow();
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i - 2);
}

export function fillSerials(): void {
  const cols = rosterColumns();
  const selected = cols && selectedRosterRows();
  if (!cols || !selected) return;
  const blanks = selected.filter((i) => i < cols.rows.length && !text(cols.rows[i][cols.serial]));
  if (!blanks.length) {
    ui().alert("選取的列都已經有序號，或超出名單範圍。");
    return;
  }
  const asked = askPrefix("填入流水號", "名單");
  const width = asked && askWidth(asked.prefix, asked.entry);
  if (!asked || !width) return;

  const taken = new Set(cols.rows.map((r) => text(r[cols.serial])).filter(Boolean));
  const serials = reserve(asked.prefix, "名單", width, blanks.length, taken);
  blanks.forEach((i, k) => cols.sheet.getRange(i + 2, cols.serial + 1).setValue(serials[k]));
  bumpRosterVersion();
  ui().alert(`已填入 ${serials.length} 個序號（${serials[0]}–${serials[serials.length - 1]}）。接著用「票券 → 簽發選取的列」簽發。`);
}

/** 連續的列合併成一段，一次寫入。 */
function runs(rows: number[]): number[][] {
  const out: number[][] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last && last[last.length - 1] === r - 1) last.push(r);
    else out.push([r]);
  }
  return out;
}

/**
 * 簽發選取的列：全部合格才簽，有任何一列不合格就整批不簽並列出問題。
 * 票券在目前的金鑰下已經對得上序號的列略過，所以改了序號或換了金鑰，重跑一次就會更新。
 */
export function signSelectedRows(): void {
  const keys = requireKeys();
  const cols = keys && rosterColumns();
  const selected = cols && selectedRosterRows();
  if (!keys || !cols || !selected) return;

  const counts = new Map<string, number>();
  for (const r of cols.rows) {
    const s = text(r[cols.serial]);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const registry = prefixes();
  const errors: string[] = [];
  const candidates: number[] = [];
  for (const i of selected) {
    const row = cols.rows[i];
    const serial = row ? text(row[cols.serial]) : "";
    if (!serial) continue;
    const where = `第 ${i + 2} 列（${serial}）`;
    if (!isValidSerial(serial)) errors.push(`${where}：序號只能用英數字、- 與 _，最長 32 字`);
    else if ((counts.get(serial) ?? 0) > 1) errors.push(`${where}：序號重複`);
    else if (registry[splitPrefix(serial).prefix]?.use === "實體") errors.push(`${where}：前綴已用於實體票`);
    else if (!text(row[cols.code])) errors.push(`${where}：學員代號空白`);
    else candidates.push(i);
  }
  if (errors.length) {
    const listed = errors.slice(0, MAX_LISTED_ERRORS).join("\n");
    const more = errors.length > MAX_LISTED_ERRORS ? `\n…另有 ${errors.length - MAX_LISTED_ERRORS} 列` : "";
    ui().alert("沒有簽發任何一列", `${listed}${more}`, ui().ButtonSet.OK);
    return;
  }

  const publicKey = keys.publicKey;
  const todo = candidates.filter((i) => verifyToken(publicKey, text(cols.rows[i][cols.ticket])) !== text(cols.rows[i][cols.serial]));
  for (const run of runs(todo)) {
    const tokens = run.map((i) => sign(keys.secretKey, text(cols.rows[i][cols.serial])));
    cols.sheet.getRange(run[0] + 2, cols.ticket + 1, run.length, 1).setValues(tokens.map((t) => [t]));
    cols.sheet.getRange(run[0] + 2, cols.qr + 1, run.length, 1).setValues(tokens.map((t) => [qrCellImage(t)]));
    cols.sheet.setRowHeightsForced(run[0] + 2, run.length, QR_SIZE_PX);
  }
  if (todo.length) bumpRosterVersion();
  ui().alert(`已簽發 ${todo.length} 列；${candidates.length - todo.length} 列的票券仍有效，略過。`);
}

export function generatePhysicalTickets(): void {
  const keys = requireKeys();
  const asked = keys && askPrefix("產生實體票", "實體");
  if (!keys || !asked) return;
  if (!asked.entry) {
    const roster = readRoster();
    const col = roster.headers.indexOf(SERIAL_FIELD);
    const clash = col === -1 ? undefined : roster.rows.map((r) => text(r[col])).find((s) => s && splitPrefix(s).prefix === asked.prefix);
    if (clash) {
      ui().alert(`學員名單上已有這個前綴的序號（${clash}），實體票不能用同一個前綴。`);
      return;
    }
  }
  const width = askWidth(asked.prefix, asked.entry);
  if (!width) return;
  const res = ui().prompt("產生實體票", `張數（1–${MAX_PHYSICAL}）：`, ui().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui().Button.OK) return;
  const count = Number(res.getResponseText().trim());
  if (!Number.isInteger(count) || count < 1 || count > MAX_PHYSICAL) {
    ui().alert(`張數必須是 1 到 ${MAX_PHYSICAL} 的整數。`);
    return;
  }

  const serials = reserve(asked.prefix, "實體", width, count, new Set());
  const tokens = serials.map((s) => sign(keys.secretKey, s));
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.insertSheet(`實體票 ${serials[0]}–${serials[serials.length - 1]}`);
  sheet.getRange(1, 1).setValue("印完請刪除此分頁。試算表不保留實體票的單張紀錄，只記前綴與下一號。");
  sheet.getRange(2, 1, 1, TICKET_COLUMNS.length).setValues([TICKET_COLUMNS]);
  sheet.getRange(3, 1, count, 1).setNumberFormat("@");
  sheet.getRange(3, 1, count, 3).setValues(serials.map((s, i) => [s, tokens[i], qrCellImage(tokens[i])]));
  sheet.setRowHeightsForced(3, count, QR_SIZE_PX);
  sheet.setColumnWidth(3, QR_SIZE_PX);
  sheet.setFrozenRows(2);
  sheet.activate();
}

export function testRule(): void {
  const res = ui().prompt("測試規則", "序號：", ui().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui().Button.OK) return;
  const serial = res.getResponseText().trim();
  if (!isValidSerial(serial)) {
    ui().alert("序號只能用英數字、- 與 _，最長 32 字。");
    return;
  }
  const { rules, errors } = readRules();
  if (errors.length) {
    ui().alert("票種規則有錯", errors.join("\n"), ui().ButtonSet.OK);
    return;
  }
  const match = matchRule(compileRules(rules), serial);
  if (!match) {
    ui().alert(`${serial}：沒有符合的規則，會被拒絕。`);
    return;
  }
  const { rule } = match;
  let outcome: string;
  if (rule.action === "需在名單") {
    const roster = readRoster();
    const col = roster.headers.indexOf(SERIAL_FIELD);
    const row = col === -1 ? undefined : roster.rows.find((r) => text(r[col]) === serial);
    outcome = row
      ? `名單上有此序號，報到：${renderTemplate(rule.message, { ...Object.fromEntries(roster.headers.map((h, i) => [h, row[i]])), [SERIAL_FIELD]: serial })}`
      : "名單上沒有此序號，會顯示「已作廢」。";
  } else {
    const message = renderTemplate(rule.message, { [SERIAL_FIELD]: serial });
    outcome = rule.action === "放行" ? `報到：${message}` : `拒絕：${message}`;
  }
  ui().alert(`${serial}：符合第 ${rule.row} 列（${rule.pattern}，${rule.action}）\n${outcome}`);
}
