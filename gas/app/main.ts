// Apps Script 進入點。建置時，這裡 export 的函式會成為頂層函式。

import { parseRequest, type ApiResponse } from "../../core/api.ts";
import { CODE_FIELD, missingRequired } from "../../core/roster.ts";
import { unknownFields } from "../../core/template.ts";
import { handle } from "./api.ts";
import { devHandle } from "./dev.ts";
import { bumpRosterVersion, deploymentId, getSettings, parseSessions, saveSettings, storeDeploymentId } from "./settings.ts";
import { ensureLogSheet, readRoster, ROSTER_SHEET, rosterSheet } from "./sheets.ts";
import { ensureMarkColumns } from "./store.ts";
import { NEED_SETUP, SETTINGS_DIALOG, setupPage, sidebar, staffLinkDialog } from "./ui.ts";

function json(body: ApiResponse<unknown>): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 擁有者部署後開一次 Web App 網址，記下部署 ID。
 * ScriptApp.getService().getUrl() 只在 doGet/doPost 內可靠，選單裡呼叫會拿到錯的 ID。
 */
export function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  const match = ScriptApp.getService().getUrl().match(/\/macros\/s\/([^/]+)\/exec/);
  if (match) storeDeploymentId(match[1]);
  return HtmlService.createHtmlOutput(setupPage(match ? match[1] : null)).setTitle("報到系統");
}

export function doPost(e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  try {
    const body: unknown = JSON.parse(e.postData.contents);
    if (__DEV__) {
      const dev = devHandle(body);
      if (dev !== undefined) return json({ ok: true, data: dev });
    }
    return json({ ok: true, data: handle(parseRequest(body)) });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export function onOpen(): void {
  SpreadsheetApp.getUi()
    .createMenu("報到")
    .addItem("顯示報到側邊欄", "showSidebar")
    .addItem("工作人員連結", "showStaffLink")
    .addItem("設定", "showSettings")
    .addToUi();
}

/** simple trigger：學員名單被手動編輯時，讓各裝置重抓名單快取。script 自己的寫入不會觸發。 */
export function onEdit(e: GoogleAppsScript.Events.SheetsOnEdit): void {
  if (e.range.getSheet().getName() === ROSTER_SHEET) bumpRosterVersion();
}

function withDeployment(render: (id: string) => GoogleAppsScript.HTML.HtmlOutput): GoogleAppsScript.HTML.HtmlOutput {
  const id = deploymentId();
  return id ? render(id) : HtmlService.createHtmlOutput(NEED_SETUP);
}

export function showSidebar(): void {
  const html = withDeployment((id) => HtmlService.createHtmlOutput(sidebar(id)));
  SpreadsheetApp.getUi().showSidebar(html.setTitle("報到"));
}

export function showStaffLink(): void {
  const html = withDeployment((id) => HtmlService.createHtmlOutput(staffLinkDialog(id)));
  SpreadsheetApp.getUi().showModalDialog(html.setWidth(420).setHeight(420), "工作人員連結");
}

export function showSettings(): void {
  const html = HtmlService.createHtmlOutput(SETTINGS_DIALOG).setWidth(480).setHeight(420);
  SpreadsheetApp.getUi().showModalDialog(html, "設定");
}

export function loadSettings(): { template: string; sessions: string[]; headers: string[] } {
  return { ...getSettings(), headers: readRoster().headers.filter(Boolean) };
}

/** 模板引用了學員名單沒有的欄位就不儲存（PLAN 2.5a）。 */
export function storeSettings(template: string, sessionsText: string): { ok: true } | { ok: false; error: string } {
  const headers = readRoster().headers;
  const missing = missingRequired(headers);
  if (missing.length) return { ok: false, error: `學員名單缺少欄位：${missing.join("、")}` };
  const unknown = unknownFields(template, headers);
  if (unknown.length) return { ok: false, error: `學員名單沒有這些欄位：${unknown.join("、")}` };
  const sessions = parseSessions(sessionsText);
  if (!sessions.length) return { ok: false, error: "至少要有一個場次" };
  if (sessions.includes(ROSTER_SHEET)) return { ok: false, error: `場次不能叫「${ROSTER_SHEET}」` };

  saveSettings({ template, sessions });
  sessions.forEach(ensureLogSheet);
  ensureMarkColumns(sessions);
  return { ok: true };
}

/** 側邊欄自動跳轉（PLAN 4.8）。 */
export function jumpTo(code: string): void {
  const roster = readRoster();
  const col = roster.headers.indexOf(CODE_FIELD);
  const row = roster.rows.findIndex((r) => String(r[col]).trim() === code);
  if (row === -1) return;
  const sheet = rosterSheet();
  sheet.getRange(row + 2, 1, 1, sheet.getLastColumn()).activate();
}
