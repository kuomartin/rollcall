// 集中 Web App 的進入點（PLAN 6.2）。建置時，這裡 export 的函式會成為 Apps Script 的頂層函式。

function json(body: unknown): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

export function doGet(_e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.Content.TextOutput {
  return json({ ok: true, service: "rollcall" });
}

export function doPost(_e: GoogleAppsScript.Events.DoPost): GoogleAppsScript.Content.TextOutput {
  return json({ ok: false, error: "not implemented" });
}
