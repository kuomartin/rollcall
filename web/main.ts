// 掃描頁（PLAN 4）：名單快取本機比對、先回應再背景同步、斷線禁止報到。

import type { ApiRequest, ApiResponse, BootstrapResult, LookupResult, SyncResult } from "../core/api.ts";
import { SyncClient, connectivity, type Connectivity } from "../core/client.ts";
import { CODE_FIELD, type CacheRow } from "../core/roster.ts";
import type { LogEntry, Scan } from "../core/sync.ts";
import { renderTemplate } from "../core/template.ts";

const BUSY_INTERVAL_MS = 3_000;
const IDLE_INTERVAL_MS = 10_000;
const ENQUEUE_DELAY_MS = 500;
const CAMERA_REPEAT_MS = 3_000;
const RECENT_LIMIT = 30;

const params = new URLSearchParams(location.hash.slice(1));
const deployId = params.get("id");
const inSidebar = params.get("sidebar") === "1";
const endpoint = deployId ? `https://script.google.com/macros/s/${deployId}/exec` : "";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  session: $<HTMLSelectElement>("session"),
  status: $("status"),
  pending: $("pending"),
  form: $<HTMLFormElement>("form"),
  input: $<HTMLInputElement>("input"),
  camera: $<HTMLButtonElement>("camera"),
  video: $<HTMLVideoElement>("video"),
  result: $("result"),
  recent: $<HTMLOListElement>("recent"),
};

function storedDeviceId(): string {
  const fresh = `dev-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const id = localStorage.getItem("rollcall.deviceId") ?? fresh;
    localStorage.setItem("rollcall.deviceId", id);
    return id;
  } catch {
    return fresh;
  }
}

async function call<T>(body: ApiRequest): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as ApiResponse<T>;
  if (!json.ok) throw new Error(json.error);
  return json.data;
}

const client = new SyncClient(storedDeviceId());
let config: BootstrapResult | null = null;
const rosterByCode = new Map<string, CacheRow>();
const own: LogEntry[] = [];
let lastSuccessAt: number | null = null;
let lastFailureAt: number | null = null;
let lastError = "";
let inFlightSince: number | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function state(): Connectivity {
  return connectivity({ now: Date.now(), online: navigator.onLine, lastSuccessAt, lastFailureAt, inFlightSince });
}

function showResult(kind: "ok" | "error" | "info", text: string): void {
  ui.result.className = `result ${kind}`;
  ui.result.textContent = text;
}

function renderStatus(): void {
  const s = state();
  const label = { ok: "同步正常", delayed: "同步延遲，照常報到", offline: "離線，禁止報到" }[s];
  ui.status.className = `status ${s}`;
  ui.status.textContent = s === "offline" && lastError ? `${label}（${lastError}）` : label;
  const n = client.pending().length;
  ui.pending.textContent = n ? `未送出 ${n} 筆` : "";
}

function renderRecent(): void {
  const session = ui.session.value;
  const entries = [...own, ...client.others()]
    .filter((e) => e.session === session)
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_LIMIT);
  ui.recent.replaceChildren(
    ...entries.map((e) => {
      const li = document.createElement("li");
      const time = new Date(e.at).toLocaleTimeString("zh-TW", { hour12: false });
      const name = rosterByCode.get(e.code)?.["姓名"] ?? "";
      const mine = e.deviceId === client.deviceId;
      li.textContent = `${time}　${e.code}　${name}${mine ? "" : "　（其他入口）"}`;
      return li;
    }),
  );
}

function render(): void {
  renderStatus();
  renderRecent();
}

function applyBootstrap(data: BootstrapResult): void {
  const previous = ui.session.value;
  config = data;
  rosterByCode.clear();
  for (const row of data.roster.rows) rosterByCode.set(row[CODE_FIELD], row);
  ui.session.replaceChildren(...data.sessions.map((s) => new Option(s, s)));
  if (data.sessions.includes(previous)) ui.session.value = previous;
}

async function refreshBootstrap(): Promise<void> {
  applyBootstrap(await call<BootstrapResult>({ action: "bootstrap" }));
}

function schedule(delay?: number): void {
  clearTimeout(timer);
  timer = setTimeout(syncOnce, delay ?? (client.pending().length ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS));
}

/** 側邊欄：自己的報到同步確認後，請外層跳到學員名單的那一列（PLAN 4.8）。 */
function notifyJump(acked: string[]): void {
  if (!inSidebar || !acked.length) return;
  const last = own.filter((e) => acked.includes(e.scanId)).at(-1);
  if (last) parent.postMessage({ type: "rollcall:jump", code: last.code }, "*");
}

async function syncOnce(): Promise<void> {
  if (inFlightSince !== null) return;
  inFlightSince = Date.now();
  renderStatus();
  try {
    const res = await call<SyncResult>({ action: "sync", ...client.request() });
    client.receive(res);
    lastSuccessAt = Date.now();
    lastError = "";
    notifyJump(res.acked);
    if (config && res.rosterVersion !== config.roster.version) await refreshBootstrap();
  } catch (err) {
    lastFailureAt = Date.now();
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    inFlightSince = null;
    render();
    schedule();
  }
}

async function resolve(query: string): Promise<CacheRow | null> {
  const local = rosterByCode.get(query);
  if (local) return local;
  // 本機查無：可能是手機號碼，或名單剛改過（PLAN 4.1c、4.3）。
  const { row } = await call<LookupResult>({ action: "lookup", query });
  if (row) rosterByCode.set(row[CODE_FIELD], row);
  return row;
}

async function checkIn(raw: string): Promise<void> {
  const query = raw.trim();
  if (!query || !config) return;
  if (state() === "offline") {
    showResult("error", "離線中，禁止報到。請確認網路後再試。");
    return;
  }
  let row: CacheRow | null;
  try {
    showResult("info", "查詢中…");
    row = await resolve(query);
  } catch (err) {
    showResult("error", `查詢失敗：${err instanceof Error ? err.message : err}`);
    return;
  }
  if (!row) {
    showResult("error", `查無此學員：${query}`);
    return;
  }
  const scan: Scan = { scanId: crypto.randomUUID(), code: row[CODE_FIELD], session: ui.session.value, at: Date.now() };
  client.enqueue(scan);
  own.push({ ...scan, seq: 0, deviceId: client.deviceId });
  showResult("ok", renderTemplate(config.template, row));
  render();
  if (inFlightSince === null) schedule(ENQUEUE_DELAY_MS);
}

ui.form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const value = ui.input.value;
  ui.input.value = "";
  void checkIn(value);
});
ui.session.addEventListener("change", renderRecent);

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
declare const BarcodeDetector: { new (options: { formats: string[] }): Detector } | undefined;

async function startCamera(): Promise<void> {
  if (typeof BarcodeDetector === "undefined") return;
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  ui.video.srcObject = stream;
  ui.video.hidden = false;
  await ui.video.play();
  let last = { value: "", at: 0 };
  const loop = async () => {
    if (!ui.video.srcObject) return;
    const [code] = await detector.detect(ui.video).catch(() => []);
    if (code && !(code.rawValue === last.value && Date.now() - last.at < CAMERA_REPEAT_MS)) {
      last = { value: code.rawValue, at: Date.now() };
      void checkIn(code.rawValue);
    }
    setTimeout(loop, 250);
  };
  void loop();
}

function stopCamera(): void {
  (ui.video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  ui.video.srcObject = null;
  ui.video.hidden = true;
}

ui.camera.hidden = typeof BarcodeDetector === "undefined";
ui.camera.addEventListener("click", () => {
  if (ui.video.srcObject) stopCamera();
  else startCamera().catch((err) => showResult("error", `無法開啟相機：${err instanceof Error ? err.message : err}`));
});

async function main(): Promise<void> {
  if (!endpoint) {
    showResult("error", "連結缺少部署 ID，請向主辦方取得正確的工作人員連結。");
    return;
  }
  document.body.classList.toggle("sidebar", inSidebar);
  setInterval(renderStatus, 1_000);
  try {
    showResult("info", "載入名單中…");
    await refreshBootstrap();
    lastSuccessAt = Date.now();
    showResult("info", `已載入 ${config!.roster.rows.length} 位學員，可以開始報到。`);
  } catch (err) {
    lastFailureAt = Date.now();
    lastError = err instanceof Error ? err.message : String(err);
    showResult("error", `載入失敗：${lastError}`);
  }
  render();
  schedule(0);
  ui.input.focus();
}

void main();
