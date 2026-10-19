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
  textarea, input[type=text] { width: 100%; box-sizing: border-box; font: inherit; padding: 6px; }
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
<label>報到成功訊息（用 {{欄位名稱}} 代入學員名單的欄位）</label>
<textarea id="template" rows="4"></textarea>
<label>場次（每個場次一個報到分頁，用逗號分隔）</label>
<input type="text" id="sessions">
<p id="headers"></p>
<button id="save">儲存</button>
<p id="msg"></p>
<script>
  const $ = (id) => document.getElementById(id);
  google.script.run.withSuccessHandler((s) => {
    $("template").value = s.template;
    $("sessions").value = s.sessions.join(", ");
    $("headers").textContent = "學員名單欄位：" + s.headers.join("、");
  }).loadSettings();
  $("save").addEventListener("click", () => {
    $("msg").textContent = "儲存中…";
    $("msg").className = "";
    google.script.run
      .withSuccessHandler((r) => {
        $("msg").textContent = r.ok ? "已儲存" : r.error;
        $("msg").className = r.ok ? "ok" : "error";
      })
      .withFailureHandler((e) => { $("msg").textContent = e.message; $("msg").className = "error"; })
      .storeSettings($("template").value, $("sessions").value);
  });
</script>`;
