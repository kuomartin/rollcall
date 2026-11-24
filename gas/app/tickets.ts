// 票券模式的試算表端：金鑰對、填入流水號、簽發、實體票、票種規則（docs/adr/0008-ticket-mode.md）。
// 這些都是主辦方從選單執行的動作，訊息用對話框回報。

import qrcode from "qrcode-generator";
import nacl from "tweetnacl";
import { SERIAL_FIELD } from "../../core/roster.ts";
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
import { readRoster, rosterSheet } from "./sheets.ts";

export const RULES_SHEET = "票種規則";
export const TICKET_FIELD = "票券";
export const TICKET_QR_FIELD = "票券 QR";
const TICKET_COLUMNS = [SERIAL_FIELD, TICKET_FIELD, TICKET_QR_FIELD];
const QR_SIZE_PX = 120;
const MAX_WIDTH = 10;
const MAX_LISTED_ERRORS = 20;
const LOCK_WAIT_MS = 20_000;
/**
 * 寫一張 QR 儲存格圖片實測約 0.7 秒，與圖片大小無關；選單動作單次最多執行 6 分鐘，
 * 所以補 QR 到這個時間就停下，再執行一次會從沒補到的列接著做。
 */
const QR_BUDGET_MS = 270_000;
const QR_BATCH = 20;

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
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let filled = 0;
  for (let counter = 0; filled < n; counter++) {
    const material = `${Utilities.getUuid()}${Utilities.getUuid()}${Utilities.getUuid()}${Date.now()}:${counter}`;
    const digest = nacl.hash(Uint8Array.from(Utilities.newBlob(material).getBytes(), (b) => b & 255));
    for (let i = 0; i < digest.length && filled < n; i++) out[filled++] = digest[i];
  }
  return out;
}

export function currentKeys(): KeyPair | null {
  const stored = signingKeys();
  const seed = stored && fromBase64url(stored.seed);
  return seed ? keyPairFromSeed(seed) : null;
}

function requireKeys(): KeyPair | null {
  const keys = currentKeys();
  if (!keys) ui().alert("尚未產生金鑰對，請先執行「票券 → 產生金鑰對」。");
  return keys;
}

export function qrCellImage(token: string): GoogleAppsScript.Spreadsheet.CellImage {
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

export interface RosterColumns {
  sheet: Sheet;
  headers: readonly string[];
  rows: readonly (readonly unknown[])[];
  serial: number;
  ticket: number;
  qr: number;
}

export function rosterColumns(alert = true): RosterColumns | null {
  const roster = readRoster();
  const [serial, ticket, qr] = TICKET_COLUMNS.map((h) => roster.headers.indexOf(h));
  if ([serial, ticket, qr].includes(-1)) {
    if (alert) ui().alert(`學員名單缺少「${TICKET_COLUMNS.join("、")}」其中的欄位。請先在「報到 → 設定」切換成票券模式。`);
    return null;
  }
  return { sheet: rosterSheet(), headers: roster.headers, rows: roster.rows, serial, ticket, qr };
}

/** 選取範圍在學員名單上涵蓋的資料列（0 起算，不含標題列）。 */
function selectedRosterRows(): number[] | null {
  const range = SpreadsheetApp.getActiveRange();
  const name = rosterSheet().getName();
  if (!range || range.getSheet().getName() !== name) {
    ui().alert(`請先在名單分頁「${name}」選取要處理的列。`);
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

/** 儲存格裡是這張票券的 QR 圖：寫入時把票券放在替代文字。 */
function hasQr(cell: unknown, token: string): boolean {
  const image = cell as Partial<GoogleAppsScript.Spreadsheet.CellImage> | null;
  return typeof image?.getAltTextTitle === "function" && image.getAltTextTitle() === token;
}

export type SignResult =
  | { ok: false; errors: string[] }
  | { ok: true; resigned: number; kept: number; redrawn: number; remaining: number };

/**
 * 簽發學員名單上的這些列（0 起算的資料列）：全部合格才簽，有任何一列不合格就整批不簽並回傳問題。
 * 票券在目前的金鑰下已經對得上序號的列不重簽，所以改了序號或換了金鑰，重跑一次就會更新；
 * 但 QR 圖缺了或不是這張票券的就補上，列高也一律設好。
 */
export function signRosterRows(keys: KeyPair, cols: RosterColumns, selected: readonly number[]): SignResult {
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
    else candidates.push(i);
  }
  if (errors.length) return { ok: false, errors };

  const tokens = new Map<number, string>();
  const resigned: number[] = [];
  for (const i of candidates) {
    const serial = text(cols.rows[i][cols.serial]);
    const existing = text(cols.rows[i][cols.ticket]);
    if (verifyToken(keys.publicKey, existing) === serial) {
      tokens.set(i, existing);
    } else {
      tokens.set(i, sign(keys.secretKey, serial));
      resigned.push(i);
    }
  }
  const missingQr = candidates.filter((i) => !hasQr(cols.rows[i][cols.qr], tokens.get(i)!));

  for (const run of runs(resigned)) {
    cols.sheet.getRange(run[0] + 2, cols.ticket + 1, run.length, 1).setValues(run.map((i) => [tokens.get(i)!]));
  }
  for (const run of runs(candidates)) cols.sheet.setRowHeightsForced(run[0] + 2, run.length, QR_SIZE_PX);
  if (resigned.length) bumpRosterVersion();
  SpreadsheetApp.flush();

  const started = Date.now();
  let drawn = 0;
  while (drawn < missingQr.length && Date.now() - started < QR_BUDGET_MS) {
    const batch = missingQr.slice(drawn, drawn + QR_BATCH);
    for (const run of runs(batch)) {
      cols.sheet.getRange(run[0] + 2, cols.qr + 1, run.length, 1).setValues(run.map((i) => [qrCellImage(tokens.get(i)!)]));
    }
    SpreadsheetApp.flush();
    drawn += batch.length;
  }
  const resignedSet = new Set(resigned);
  return {
    ok: true,
    resigned: resigned.length,
    kept: candidates.length - resigned.length,
    redrawn: missingQr.slice(0, drawn).filter((i) => !resignedSet.has(i)).length,
    remaining: missingQr.length - drawn,
  };
}

export function signSelectedRows(): void {
  const keys = requireKeys();
  const cols = keys && rosterColumns();
  const selected = cols && selectedRosterRows();
  if (!keys || !cols || !selected) return;
  const result = signRosterRows(keys, cols, selected);
  if (!result.ok) {
    const listed = result.errors.slice(0, MAX_LISTED_ERRORS).join("\n");
    const more = result.errors.length > MAX_LISTED_ERRORS ? `\n…另有 ${result.errors.length - MAX_LISTED_ERRORS} 列` : "";
    ui().alert("沒有簽發任何一列", `${listed}${more}`, ui().ButtonSet.OK);
    return;
  }
  const remaining = result.remaining
    ? `\n\n還有 ${result.remaining} 列的 QR 沒寫完（每張約需 0.7 秒），請再執行一次「簽發選取的列」接著做。`
    : "";
  ui().alert(
    `已簽發 ${result.resigned} 列；${result.kept} 列的票券仍有效，不重簽` +
      (result.redrawn ? `，其中 ${result.redrawn} 列補上 QR。` : "。") +
      remaining,
  );
}

export interface PhysicalForm {
  hasKeys: boolean;
  /** 已登記為實體票的前綴與下一號；新前綴才需要填位數。 */
  prefixes: { prefix: string; next: number; width: number }[];
  defaultWidth: number;
}

export function physicalForm(): PhysicalForm {
  const registry = prefixes();
  return {
    hasKeys: signingKeys() !== null,
    prefixes: Object.entries(registry)
      .filter(([, e]) => e.use === "實體")
      .map(([prefix, e]) => ({ prefix, next: e.next, width: e.width })),
    defaultWidth: DEFAULT_WIDTH,
  };
}

/**
 * 一批實體票：號碼已經發出，由側邊欄分段簽章。
 * 輸出到分頁時 sheet 是已建好的分頁名稱；輸出成列印頁與 CSV 時為 null，試算表不留任何單張紀錄。
 */
export interface PhysicalBatch {
  sheet: string | null;
  prefix: string;
  width: number;
  first: number;
  count: number;
}

/**
 * 側邊欄按下「產生」：檢查參數、一次發出全部號碼，輸出到分頁時建立分頁。
 * 簽章交給 signPhysicalChunk／writePhysicalChunk 分段做，張數再多也不會超過 Apps Script 單次執行的時間上限。
 */
export function startPhysical(prefixText: string, widthText: string, countText: string, toSheet: boolean): PhysicalBatch {
  if (!currentKeys()) throw new Error("尚未產生金鑰對，請先執行「票券 → 產生金鑰對」。");
  const prefix = prefixText.trim();
  if (!isValidPrefix(prefix)) throw new Error("前綴只能用英數字、- 與 _，而且結尾不能是數字。");
  const entry = prefixes()[prefix];
  if (entry && entry.use !== "實體") throw new Error(`前綴「${prefix}」已經用於名單上的序號，一個前綴只能有一種用途。`);
  if (!entry) {
    const roster = readRoster();
    const col = roster.headers.indexOf(SERIAL_FIELD);
    const clash = col === -1 ? undefined : roster.rows.map((r) => text(r[col])).find((s) => s && splitPrefix(s).prefix === prefix);
    if (clash) throw new Error(`學員名單上已有這個前綴的序號（${clash}），實體票不能用同一個前綴。`);
  }
  const width = entry ? entry.width : widthText.trim() ? Number(widthText) : DEFAULT_WIDTH;
  if (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH || prefix.length + width > 32) {
    throw new Error(`位數必須是 1 到 ${MAX_WIDTH} 的整數，而且前綴加位數不超過 32 字。`);
  }
  const count = Number(countText);
  if (!Number.isInteger(count) || count < 1) throw new Error("張數必須是正整數。");

  const serials = reserveRange(prefix, width, count);
  const first = Number(splitPrefix(serials.first).digits);
  if (!toSheet) return { sheet: null, prefix, width, first, count };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.insertSheet(`實體票 ${serials.first}–${serials.last}`);
  if (sheet.getMaxRows() < count + 2) sheet.insertRowsAfter(sheet.getMaxRows(), count + 2 - sheet.getMaxRows());
  sheet.getRange(1, 1).setValue("印完請刪除此分頁。試算表不保留實體票的單張紀錄，只記前綴與下一號。");
  sheet.getRange(2, 1, 1, TICKET_COLUMNS.length).setValues([TICKET_COLUMNS]);
  sheet.getRange(3, 1, count, 1).setNumberFormat("@");
  sheet.setColumnWidth(3, QR_SIZE_PX);
  sheet.setFrozenRows(2);
  return { sheet: sheet.getName(), prefix, width, first, count };
}

/** 實體票只發連續號碼：不跳號，起訖就能代表整批。 */
function reserveRange(prefix: string, width: number, count: number): { first: string; last: string } {
  const serials = reserve(prefix, "實體", width, count, new Set());
  return { first: serials[0], last: serials[serials.length - 1] };
}

/** 簽出一批實體票的第 offset 張起 n 張，回傳 [序號, 票券]；同一段重簽結果相同，失敗可以重試。 */
export function signPhysicalChunk(batch: PhysicalBatch, offset: number, n: number): [string, string][] {
  const keys = currentKeys();
  if (!keys) throw new Error("找不到金鑰對");
  const size = Math.min(n, batch.count - offset);
  return Array.from({ length: size }, (_, k) => {
    const serial = formatSerial(batch.prefix, batch.first + offset + k, batch.width);
    return [serial, sign(keys.secretKey, serial)];
  });
}

/** 簽出並寫入分頁；一張 QR 儲存格圖片約 0.7 秒，所以這條路比列印頁慢得多。 */
export function writePhysicalChunk(batch: PhysicalBatch, offset: number, n: number): number {
  const sheet = batch.sheet && SpreadsheetApp.getActiveSpreadsheet().getSheetByName(batch.sheet);
  if (!sheet) throw new Error(`找不到「${batch.sheet}」分頁`);
  const signed = signPhysicalChunk(batch, offset, n);
  const size = signed.length;
  const rows = signed.map(([serial, token]) => [serial, token, qrCellImage(token)]);
  sheet.getRange(3 + offset, 1, size, 3).setValues(rows);
  sheet.setRowHeightsForced(3 + offset, size, QR_SIZE_PX);
  return offset + size;
}

export function showPhysicalSheet(name: string): void {
  SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name)?.activate();
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
