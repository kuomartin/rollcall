// 試算表內的對話框與側邊欄，以及 Web App 的初始化頁。

export const PAGES_ORIGIN = "https://kuomartin.github.io";
export const PAGES_URL = `${PAGES_ORIGIN}/rollcall/`;

export function staffUrl(deploymentId: string): string {
  return `${PAGES_URL}#id=${encodeURIComponent(deploymentId)}`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `<style>
  body { font-family: system-ui, sans-serif; margin: 12px; line-height: 1.5; }
  textarea, input[type=text], select { width: 100%; box-sizing: border-box; font: inherit; padding: 6px; }
  button { font: inherit; padding: 6px 14px; margin-top: 8px; }
  .error { color: #c62828; } .ok { color: #2e7d32; }
  code { word-break: break-all; }
</style>`;

export const NEED_SETUP = `${STYLE}
<p>尚未取得部署 ID。請先「部署 → 新增部署作業」部署成網頁應用程式（執行身分：我；存取權：所有人），再用瀏覽器開一次網頁應用程式網址。</p>`;

export function setupPage(deploymentId: string | null): string {
  if (!deploymentId) return `${STYLE}<p class="error">無法取得部署 ID，請確認此專案已部署成網頁應用程式。</p>`;
  const url = staffUrl(deploymentId);
  return `${STYLE}
<p class="ok">已完成初始化。</p>
<p>工作人員連結：<br><a href="${escape(url)}" target="_top"><code>${escape(url)}</code></a></p>
<p>之後也可以在試算表選單「報到 → 工作人員連結」取得。</p>`;
}

export function staffLinkDialog(deploymentId: string): string {
  const url = staffUrl(deploymentId);
  return `${STYLE}
<p>把這個連結或 QR code 交給入口工作人員。知道連結的人就能報到。</p>
<p><a href="${escape(url)}" target="_blank"><code>${escape(url)}</code></a></p>
<div id="qr"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>new QRCode(document.getElementById("qr"), { text: ${JSON.stringify(url)}, width: 240, height: 240 });</script>`;
}

export function sidebar(deploymentId: string): string {
  const url = `${staffUrl(deploymentId)}&sidebar=1`;
  return `<style>
  html, body { margin: 0; height: 100%; font-family: system-ui, sans-serif; }
  body { display: flex; flex-direction: column; }
  label { padding: 8px 12px; font-size: 14px; }
  iframe { flex: 1; border: 0; width: 100%; }
</style>
<label><input type="checkbox" id="jump" checked> 報到後跳到學員名單的那一列</label>
<iframe src="${escape(url)}" allow="camera"></iframe>
<script>
  window.addEventListener("message", (ev) => {
    if (ev.origin !== ${JSON.stringify(PAGES_ORIGIN)}) return;
    const msg = ev.data;
    if (msg && msg.type === "rollcall:jump" && typeof msg.code === "string" && document.getElementById("jump").checked) {
      google.script.run.jumpTo(msg.code);
    }
  });
</script>`;
}

export const SETTINGS_DIALOG = `${STYLE}
<label>模式</label>
<select id="mode">
  <option value="code">代號模式：掃學員代號或條碼、可輸入代號或手機</option>
  <option value="ticket">票券模式：只掃簽章的票券 QR，訊息由「票種規則」決定</option>
</select>
<label>名單分頁（第 1 列是欄位名稱）</label>
<select id="roster"></select>
<label>報到成功訊息（代號模式用；用 {{欄位名稱}} 代入名單的欄位）</label>
<textarea id="template" rows="4"></textarea>
<label>場次（每個場次一個報到分頁，用逗號分隔）</label>
<input type="text" id="sessions">
<p id="headers"></p>
<button id="save">儲存</button>
<p id="msg"></p>
<script>
  const $ = (id) => document.getElementById(id);
  let sheets = [];
  const showHeaders = () => {
    const sheet = sheets.find((x) => x.name === $("roster").value);
    $("headers").textContent = sheet ? "名單欄位：" + (sheet.headers.join("、") || "（第 1 列是空的）") : "";
  };
  google.script.run.withSuccessHandler((s) => {
    sheets = s.sheets;
    $("template").value = s.template;
    $("sessions").value = s.sessions.join(", ");
    $("mode").value = s.mode;
    const names = s.sheets.map((x) => x.name);
    // 設定的名單分頁不見了（被改名或刪除）也列出來，讓主辦方看得到要改。
    if (!names.includes(s.roster)) names.unshift(s.roster);
    $("roster").replaceChildren(...names.map((n) => new Option(n, n)));
    $("roster").value = s.roster;
    showHeaders();
  }).loadSettings();
  $("roster").addEventListener("change", showHeaders);
  $("save").addEventListener("click", () => {
    $("msg").textContent = "儲存中…";
    $("msg").className = "";
    google.script.run
      .withSuccessHandler((r) => {
        $("msg").textContent = r.ok ? "已儲存" : r.error;
        $("msg").className = r.ok ? "ok" : "error";
      })
      .withFailureHandler((e) => { $("msg").textContent = e.message; $("msg").className = "error"; })
      .storeSettings($("template").value, $("sessions").value, $("mode").value, $("roster").value);
  });
</script>`;

export const CLEAR_DIALOG = `${STYLE}
<p>清除一個場次的所有報到紀錄，以及學員名單上該場次的報到時間，用於活動前清掉測試掃描。<strong>無法復原。</strong></p>
<p>確定沒有入口正在報到再清除。清除後，所有開著的掃描頁都要重新整理，否則仍會把清掉的學員當成已報到。</p>
<label>場次</label>
<select id="session"></select>
<label>輸入場次名稱以確認</label>
<input type="text" id="confirm" autocomplete="off">
<button id="clear" disabled>清除</button>
<p id="msg"></p>
<script>
  const $ = (id) => document.getElementById(id);
  const check = () => { $("clear").disabled = $("confirm").value.trim() !== $("session").value; };
  google.script.run.withSuccessHandler((sessions) => {
    $("session").replaceChildren(...sessions.map((s) => new Option(s, s)));
    check();
  }).loadSessions();
  $("session").addEventListener("change", check);
  $("confirm").addEventListener("input", check);
  $("clear").addEventListener("click", () => {
    $("clear").disabled = true;
    $("msg").textContent = "清除中…";
    $("msg").className = "";
    google.script.run
      .withSuccessHandler((r) => {
        $("msg").textContent = r.ok ? "已清除。請重新整理所有開著的掃描頁。" : r.error;
        $("msg").className = r.ok ? "ok" : "error";
        $("confirm").value = "";
      })
      .withFailureHandler((e) => { $("msg").textContent = e.message; $("msg").className = "error"; check(); })
      .clearCheckIns($("session").value, $("confirm").value);
  });
</script>`;

/**
 * 產生實體票的側邊欄。號碼在「產生」時一次發出，之後分段簽章並顯示進度；
 * 某一段失敗時可以從那一段繼續，同一段重簽結果相同。
 * 輸出成列印頁與 CSV 時，QR 在瀏覽器裡畫，幾千張也只要幾秒，試算表不留任何單張紀錄；
 * 輸出到分頁時每張 QR 儲存格圖片約 0.7 秒。
 */
export const PHYSICAL_SIDEBAR = `${STYLE}
<style>
  .choice { display: block; margin: 4px 0; }
  .note { color: #666; font-size: 0.9em; }
</style>
<p>產生不記名的實體票。試算表只記前綴與下一號。</p>
<label>前綴（結尾不能是數字，例如 P03-）</label>
<input type="text" id="prefix" list="known" autocomplete="off">
<datalist id="known"></datalist>
<p id="hint" class="note"></p>
<div id="widthRow">
  <label>流水號位數</label>
  <input type="text" id="width" inputmode="numeric">
</div>
<label>張數</label>
<input type="text" id="count" inputmode="numeric">
<label>輸出</label>
<label class="choice"><input type="radio" name="out" value="print" checked> 列印頁與 CSV（快，不留在試算表）</label>
<label class="choice"><input type="radio" name="out" value="sheet"> 寫入新分頁（每張約 0.7 秒，印完請刪除分頁）</label>
<button id="go">產生</button>
<button id="resume" hidden>從中斷處繼續</button>
<p id="msg"></p>
<div id="done" hidden>
  <button id="print">開啟列印頁</button>
  <button id="csv">下載 CSV</button>
  <p class="note">關掉側邊欄前請先列印或下載。關掉後要重新產生，會發新的號碼；這批號碼仍然有效，只是沒有印出。</p>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
<script>
  const SIGN_CHUNK = 500;
  const SHEET_CHUNK = 100;
  const $ = (id) => document.getElementById(id);
  let form = { hasKeys: false, prefixes: [], defaultWidth: 5 };
  let batch = null;
  let offset = 0;
  let tickets = [];

  const say = (text, kind) => { $("msg").textContent = text; $("msg").className = kind || ""; };
  const pad = (n, w) => String(n).padStart(w, "0");
  const range = () => batch.prefix + pad(batch.first, batch.width) + "–" + batch.prefix + pad(batch.first + batch.count - 1, batch.width);
  const toSheet = () => document.querySelector("input[name=out]:checked").value === "sheet";

  function update() {
    const known = form.prefixes.find((p) => p.prefix === $("prefix").value.trim());
    $("widthRow").hidden = !!known;
    $("hint").textContent = known ? "從 " + known.prefix + pad(known.next, known.width) + " 開始編號" : "";
  }

  function load() {
    google.script.run.withSuccessHandler((f) => {
      form = f;
      $("width").placeholder = String(f.defaultWidth);
      $("known").replaceChildren(...f.prefixes.map((p) => new Option(p.prefix)));
      if (!f.hasKeys) say("尚未產生金鑰對，請先執行「票券 → 產生金鑰對」。", "error");
      $("go").disabled = !f.hasKeys;
      update();
    }).physicalForm();
  }

  function finish() {
    say("完成：" + batch.count + " 張（" + range() + "）。", "ok");
    $("go").disabled = false;
    if (batch.sheet) google.script.run.showPhysicalSheet(batch.sheet);
    else $("done").hidden = false;
    load();
  }

  function next() {
    if (offset >= batch.count) return finish();
    say((batch.sheet ? "寫入中… " : "簽章中… ") + offset + " / " + batch.count);
    const failed = (e) => {
      say("在第 " + (offset + 1) + " 張中斷：" + e.message, "error");
      $("resume").hidden = false;
    };
    if (batch.sheet) {
      google.script.run
        .withSuccessHandler((done) => { offset = done; next(); })
        .withFailureHandler(failed)
        .writePhysicalChunk(batch, offset, SHEET_CHUNK);
    } else {
      google.script.run
        .withSuccessHandler((rows) => { tickets.push(...rows); offset += rows.length; next(); })
        .withFailureHandler(failed)
        .signPhysicalChunk(batch, offset, SIGN_CHUNK);
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");
  }

  /** GIF data URL 每張約 2.7 KB；SVG 每張約 21 KB，幾千張的列印頁會大到瀏覽器吃不消。 */
  function qrImg(token) {
    const qr = qrcode(0, "M");
    qr.addData(token);
    qr.make();
    return '<img alt="" src="' + qr.createDataURL(4, 0) + '">';
  }

  function printPage() {
    const cards = tickets.map(([serial, token]) =>
      '<div class="card">' + qrImg(token) + '<div class="serial">' + escapeHtml(serial) + "</div></div>").join("");
    return '<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><title>實體票 ' + escapeHtml(range()) + "</title>" +
      "<style>@page{size:A4;margin:10mm}body{margin:0;font-family:system-ui,sans-serif}" +
      ".grid{display:grid;grid-template-columns:repeat(4,1fr);gap:4mm}" +
      // QR 四周要留約 4 個模組的空白才好掃：36mm 的 QR 約 41 個模組，padding 4mm 剛好。
      ".card{break-inside:avoid;border:1px dashed #999;padding:4mm;text-align:center}" +
      ".card img{width:36mm;height:36mm;image-rendering:pixelated}.serial{font:12pt monospace;margin-top:2mm}" +
      "@media screen{body{padding:10mm}}</style></head><body><div class=\\"grid\\">" + cards + "</div></body></html>";
  }

  $("print").addEventListener("click", () => {
    // 新視窗要在點擊當下開，否則會被當成彈出式視窗擋下；列印頁幾千張要幾秒，開好視窗再填內容。
    const w = window.open("", "_blank");
    if (!w) return say("瀏覽器擋下了新視窗，請允許此試算表開啟彈出式視窗後再按一次。", "error");
    w.document.write("<p>產生列印頁中…</p>");
    setTimeout(() => {
      w.document.open();
      w.document.write(printPage());
      w.document.close();
    }, 0);
  });

  $("csv").addEventListener("click", () => {
    const lines = ["序號,票券", ...tickets.map(([serial, token]) => serial + "," + token)];
    // 開頭的 BOM 讓 Excel 以 UTF-8 開啟。
    const blob = new Blob(["﻿" + lines.join("\\r\\n") + "\\r\\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "實體票 " + range() + ".csv";
    document.body.append(a);
    a.click();
    a.remove();
  });

  $("prefix").addEventListener("input", update);
  $("go").addEventListener("click", () => {
    $("go").disabled = true;
    $("resume").hidden = true;
    $("done").hidden = true;
    tickets = [];
    say("發出號碼中…");
    google.script.run
      .withSuccessHandler((b) => { batch = b; offset = 0; next(); })
      .withFailureHandler((e) => { say(e.message, "error"); $("go").disabled = false; })
      .startPhysical($("prefix").value, $("width").value, $("count").value, toSheet());
  });
  $("resume").addEventListener("click", () => { $("resume").hidden = true; next(); });
  load();
</script>`;

/**
 * 序號側邊欄：在名單分頁填入流水號，並列出所有前綴。
 * 名單用途的前綴可以把下一號改成任意值或刪除登記；實體票的前綴只顯示，換金鑰對時才能歸零。
 */
export const SERIALS_SIDEBAR = `${STYLE}
<style>
  .note { color: #666; font-size: 0.9em; }
  .prefix { border-top: 1px solid #ddd; padding: 8px 0; }
  .prefix b { font-family: monospace; }
  .row { display: flex; gap: 6px; align-items: center; }
  .row input { flex: 1; min-width: 0; }
  .row button { margin-top: 0; }
</style>
<h3>填入流水號</h3>
<p class="note" id="where"></p>
<label>前綴（結尾不能是數字，例如 VIP-）</label>
<input type="text" id="prefix" list="known" autocomplete="off">
<datalist id="known"></datalist>
<p id="hint" class="note"></p>
<div id="widthRow">
  <label>流水號位數</label>
  <input type="text" id="width" inputmode="numeric">
</div>
<button id="fill">填入選取的格子</button>
<p id="msg"></p>
<h3>前綴</h3>
<div id="list"></div>
<button id="reload">重新整理</button>
<script>
  const $ = (id) => document.getElementById(id);
  const pad = (n, w) => String(n).padStart(w, "0");
  let form = { roster: "", defaultWidth: 5, prefixes: [] };

  const say = (text, kind) => { $("msg").textContent = text; $("msg").className = kind || ""; };
  const fail = (e) => say(e.message, "error");
  const issued = (p) => p.next > 1 ? p.prefix + pad(1, p.width) + "–" + p.prefix + pad(p.next - 1, p.width) : "尚未發號";

  function update() {
    const known = form.prefixes.find((p) => p.prefix === $("prefix").value.trim());
    $("widthRow").hidden = !!known;
    $("hint").textContent = known
      ? (known.use === "名單" ? "從 " + known.prefix + pad(known.next, known.width) + " 開始，跳過名單上已有的序號" : "這個前綴用於實體票，不能填進名單")
      : "";
  }

  function item(p) {
    const div = document.createElement("div");
    div.className = "prefix";
    const head = document.createElement("div");
    head.innerHTML = "<b></b>（" + p.use + "，" + p.width + " 位）<br><span class=note></span>";
    head.querySelector("b").textContent = p.prefix;
    // 名單用途的下一號可以被重設，1 到下一號之前不代表實際用過的號碼，所以只顯示下一號。
    head.querySelector("span").textContent = p.use === "名單" ? "下一號：" + p.prefix + pad(p.next, p.width) : "已發：" + issued(p);
    div.append(head);
    if (p.use !== "名單") {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = "實體票的前綴不能重設：已發出的票會和新票同號。換金鑰對時可以歸零。";
      div.append(note);
      return div;
    }
    const row = document.createElement("div");
    row.className = "row";
    const next = document.createElement("input");
    next.type = "text";
    next.inputMode = "numeric";
    next.value = String(p.next);
    next.setAttribute("aria-label", p.prefix + " 的下一號");
    const set = document.createElement("button");
    set.textContent = "設為下一號";
    set.addEventListener("click", () => {
      say("儲存中…");
      google.script.run.withSuccessHandler(() => { say(p.prefix + " 的下一號改為 " + next.value.trim(), "ok"); load(); })
        .withFailureHandler(fail).setNextNumber(p.prefix, next.value);
    });
    const del = document.createElement("button");
    del.textContent = "刪除";
    // 第一次按只改成確認文字，再按一次才刪除。
    del.addEventListener("click", () => {
      if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = "確定刪除？"; return; }
      say("刪除中…");
      google.script.run.withSuccessHandler(() => { say("已刪除 " + p.prefix + "。名單上的序號不受影響。", "ok"); load(); })
        .withFailureHandler(fail).deletePrefix(p.prefix);
    });
    row.append(next, set, del);
    div.append(row);
    return div;
  }

  function load() {
    google.script.run.withSuccessHandler((f) => {
      form = f;
      $("where").textContent = "在名單分頁「" + f.roster + "」選取要填的列；序號欄空白的格子會依序填入。";
      $("width").placeholder = String(f.defaultWidth);
      $("known").replaceChildren(...f.prefixes.filter((p) => p.use === "名單").map((p) => new Option(p.prefix)));
      $("list").replaceChildren(...(f.prefixes.length ? f.prefixes.map(item) : [Object.assign(document.createElement("p"), { className: "note", textContent: "還沒有登記任何前綴。" })]));
      update();
    }).withFailureHandler(fail).serialsForm();
  }

  $("prefix").addEventListener("input", update);
  $("fill").addEventListener("click", () => {
    $("fill").disabled = true;
    say("填入中…");
    google.script.run
      .withSuccessHandler((m) => { say(m, "ok"); $("fill").disabled = false; load(); })
      .withFailureHandler((e) => { fail(e); $("fill").disabled = false; })
      .fillSelected($("prefix").value, $("width").value);
  });
  $("reload").addEventListener("click", load);
  load();
</script>`;
