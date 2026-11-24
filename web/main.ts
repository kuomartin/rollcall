// 掃描頁（docs/adr/0003-local-first-check-in-with-one-writer.md）：名單快取本機比對、先回應再背景同步、斷線禁止報到。
// 票券模式（docs/adr/0008-ticket-mode.md）在本機驗章與比對票種規則，其餘流程與代號模式相同。

import type { ApiRequest, ApiResponse, BootstrapResult, LookupResult, SyncResult } from "../core/api.ts";
import { CheckInIndex, SyncClient, ago, connectivity, type Connectivity } from "../core/client.ts";
import { CODE_FIELD, SERIAL_FIELD, type CacheRow } from "../core/roster.ts";
import { compileRules } from "../core/rules.ts";
import { fromBase64url } from "../core/serial.ts";
import type { LogEntry, Scan } from "../core/sync.ts";
import { renderTemplate } from "../core/template.ts";
import { judge, type TicketContext } from "../core/ticket.ts";
import type { BarcodeFormat } from "./barcode.ts";

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
  gate: $<HTMLInputElement>("gate"),
  mode: $("mode"),
  notice: $("notice"),
  status: $("status"),
  pending: $("pending"),
  form: $<HTMLFormElement>("form"),
  input: $<HTMLInputElement>("input"),
  camera: $<HTMLButtonElement>("camera"),
  video: $<HTMLVideoElement>("video"),
  scan: $("scan"),
  result: $("result"),
  recent: $<HTMLOListElement>("recent"),
  theme: $<HTMLButtonElement>("theme"),
};

type Theme = "auto" | "light" | "dark";
const THEMES: Theme[] = ["auto", "light", "dark"];
const THEME_LABEL: Record<Theme, string> = { auto: "外觀：自動", light: "外觀：淺色", dark: "外觀：深色" };

function applyTheme(theme: Theme): void {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  ui.theme.textContent = THEME_LABEL[theme];
}

function storedTheme(): Theme {
  try {
    const t = localStorage.getItem("rollcall.theme");
    return THEMES.includes(t as Theme) ? (t as Theme) : "auto";
  } catch {
    return "auto";
  }
}

let theme = storedTheme();
applyTheme(theme);
ui.theme.addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
  try {
    localStorage.setItem("rollcall.theme", theme);
  } catch {
    // 無痕模式等情況存不了，只影響下次開頁。
  }
});

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

const GATE_ANIMALS = "鹿熊鷹鯨狐貓虎兔鶴龜象豹";

function randomGateName(): string {
  const animal = GATE_ANIMALS[Math.floor(Math.random() * GATE_ANIMALS.length)];
  return `入口-${animal}${Math.floor(Math.random() * 10)}`;
}

/** 入口名稱存在這台裝置；第一次開頁給一個隨機名稱，工作人員可以自己改。 */
function storedGateName(): string {
  try {
    const name = localStorage.getItem("rollcall.gate")?.trim();
    if (name) return name;
    const fresh = randomGateName();
    localStorage.setItem("rollcall.gate", fresh);
    return fresh;
  } catch {
    return randomGateName();
  }
}

let gateName = storedGateName();
ui.gate.value = gateName;
ui.gate.addEventListener("change", () => {
  gateName = ui.gate.value.trim() || gateName;
  ui.gate.value = gateName;
  try {
    localStorage.setItem("rollcall.gate", gateName);
  } catch {
    // 存不了只影響下次開頁。
  }
});

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
const rosterBySerial = new Map<string, CacheRow>();
/** 票券模式的驗章與規則；規則有錯時沿用先前的，尚未有金鑰對時為 null。 */
let ticket: TicketContext | null = null;
let gateNames: Record<string, string> = {};
/** scanId → 報到當下顯示的訊息，點最近報到時重新顯示。 */
const shown = new Map<string, string>();
const checkedIn = new CheckInIndex();
const own: LogEntry[] = [];
let lastSuccessAt: number | null = null;
let lastFailureAt: number | null = null;
let lastError = "";
let inFlightSince: number | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function state(): Connectivity {
  return connectivity({ now: Date.now(), online: navigator.onLine, lastSuccessAt, lastFailureAt, inFlightSince });
}

const RESULT_HIDE_MS = 5_000;
let resultTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 訊息 5 秒後自動隱藏，入口前一位的結果不會留給下一位看。
 * 帶按鈕的訊息（重複報到要按「仍要報到」）與 sticky 的訊息（載入中、載入失敗）留到被下一則訊息取代。
 */
function showResult(
  kind: "ok" | "error" | "info" | "warn",
  text: string,
  action?: { label: string; run: () => void },
  sticky = false,
): void {
  clearTimeout(resultTimer);
  ui.result.className = `result ${kind}`;
  ui.result.textContent = text;
  if (!action && !sticky) {
    resultTimer = setTimeout(() => {
      ui.result.className = "result hidden";
      ui.result.textContent = "";
    }, RESULT_HIDE_MS);
  }
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", action.run, { once: true });
    ui.result.append(document.createElement("br"), button);
  }
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
  const ownIds = new Set(own.map((e) => e.scanId));
  const entries = [...own, ...client.entries().filter((e) => !ownIds.has(e.scanId))]
    .filter((e) => e.session === session)
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_LIMIT);
  ui.recent.replaceChildren(
    ...entries.map((e) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const name = rosterByCode.get(e.code)?.["姓名"] ?? "";
      const mine = e.deviceId === client.deviceId;
      button.textContent = `${clock(e.at)}　${e.code}　${name}${mine ? "" : `　（${gateNames[e.deviceId] ?? "其他入口"}）`}`;
      button.addEventListener("click", () => recall(e));
      li.append(button);
      return li;
    }),
  );
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("zh-TW", { hour12: false });
}

/** 點最近報到的一筆：重新顯示報到成功訊息。本入口的用當時的訊息，其他入口的用目前的名單快取與模板渲染。 */
function recall(e: LogEntry): void {
  const message = shown.get(e.scanId);
  if (message !== undefined) {
    showResult("ok", `${clock(e.at)} 報到｜${message}`);
    return;
  }
  const row = rosterByCode.get(e.code);
  if (!config || !row || config.mode === "ticket") {
    showResult("info", `${clock(e.at)} 報到：${e.code}`);
    return;
  }
  showResult("ok", `${clock(e.at)} 報到｜${renderTemplate(config.template, row)}`);
}

function render(): void {
  renderStatus();
  renderRecent();
}

function showNotice(kind: "error" | "warn" | null, text = ""): void {
  ui.notice.hidden = kind === null;
  ui.notice.className = `notice ${kind ?? ""}`;
  ui.notice.textContent = text;
}

function applyTicketMode(data: BootstrapResult): void {
  const publicKey = data.publicKey ? fromBase64url(data.publicKey) : null;
  if (!publicKey) {
    ticket = null;
    showNotice("error", "主辦方尚未產生金鑰對，無法驗證票券。");
    return;
  }
  const errors = data.ruleErrors ?? [];
  const bySerial = (serial: string) => rosterBySerial.get(serial);
  if (errors.length && ticket) {
    // 活動中把規則改壞了：沿用先前的規則照常報到，提醒主辦方修正。
    ticket = { ...ticket, publicKey, bySerial };
    showNotice("warn", `票種規則有錯，沿用先前的規則：${errors.join("；")}`);
    return;
  }
  ticket = { publicKey, rules: compileRules(data.rules ?? []), bySerial };
  showNotice(errors.length ? "error" : null, errors.length ? `票種規則有錯，所有票券都會被拒絕：${errors.join("；")}` : "");
}

function applyBootstrap(data: BootstrapResult): void {
  const previous = ui.session.value;
  config = data;
  rosterByCode.clear();
  rosterBySerial.clear();
  for (const row of data.roster.rows) {
    rosterByCode.set(row[CODE_FIELD], row);
    if (row[SERIAL_FIELD]) rosterBySerial.set(row[SERIAL_FIELD], row);
  }
  gateNames = data.gates ?? gateNames;
  const ticketMode = data.mode === "ticket";
  document.body.classList.toggle("ticket", ticketMode);
  ui.mode.textContent = ticketMode ? "票券模式" : "";
  ui.input.placeholder = ticketMode ? "掃描票券 QR（可接條碼槍）" : "學員代號或手機";
  ui.input.setAttribute("aria-label", ui.input.placeholder);
  if (ticketMode) applyTicketMode(data);
  else {
    ticket = null;
    showNotice(null);
  }
  checkedIn.load(data.checkedIn, data.checkedInBy);
  for (const e of [...own, ...client.entries()]) checkedIn.add(e.session, e.code, e.at, e.deviceId);
  ui.session.replaceChildren(...data.sessions.map((s) => new Option(s, s)));
  if (data.sessions.includes(previous)) ui.session.value = previous;
}

async function refreshBootstrap(): Promise<void> {
  applyBootstrap(await call<BootstrapResult>({ action: "bootstrap" }));
}

/** 有待送掃描或離線時用短間隔：離線時要盡快恢復，不能等閒置間隔。 */
function schedule(delay?: number): void {
  clearTimeout(timer);
  const busy = client.pending().length > 0 || state() === "offline";
  timer = setTimeout(syncOnce, delay ?? (busy ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS));
}

/** 側邊欄：自己的報到同步確認後，請外層跳到學員名單的那一列。 */
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
    const res = await call<SyncResult>({ action: "sync", ...client.request(), gate: gateName });
    client.receive(res);
    if (res.gates) gateNames = res.gates;
    for (const e of res.entries) checkedIn.add(e.session, e.code, e.at, e.deviceId);
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
  // 本機查無：可能是手機號碼，或名單剛改過。
  const res = await call<LookupResult>({ action: "lookup", query });
  if (res.row) {
    rosterByCode.set(res.row[CODE_FIELD], res.row);
    for (const [session, at] of Object.entries(res.checkedIn)) checkedIn.add(session, res.row[CODE_FIELD], at);
  }
  return res.row;
}

function record(code: string, session: string, message: string): void {
  const scan: Scan = { scanId: crypto.randomUUID(), code, session, at: Date.now() };
  client.enqueue(scan);
  checkedIn.add(session, code, scan.at, client.deviceId);
  own.push({ ...scan, seq: 0, deviceId: client.deviceId });
  shown.set(scan.scanId, message);
  showResult("ok", message);
  render();
  if (inFlightSince === null) schedule(ENQUEUE_DELAY_MS);
}

/** 「3 分鐘前已於入口「東門」入場」；舊版 Apps Script 給的報到時間沒有入口，就不寫入口。 */
function previousCheckIn(session: string, code: string, at: number): string {
  const deviceId = checkedIn.lastDevice(session, code);
  const where = !deviceId ? "已" : deviceId === client.deviceId ? "已於本入口" : `已於入口「${gateNames[deviceId] ?? deviceId}」`;
  return `${ago(Date.now(), at)}${where}入場`;
}

function checkInTicket(token: string, confirmed: boolean): void {
  if (!ticket) {
    showResult("error", "無法驗證票券：主辦方尚未產生金鑰對。");
    return;
  }
  const verdict = judge(token, ticket);
  switch (verdict.kind) {
    case "invalid":
      showResult("error", "序號無效：不是這個活動簽發的票券。");
      return;
    case "unmatched":
      showResult("error", `${verdict.serial}：沒有符合的票種規則，不可入場。`);
      return;
    case "rejected":
      showResult("error", verdict.message || `${verdict.serial}：不可入場。`);
      return;
    case "revoked":
      showResult("error", `${verdict.serial}：已作廢。`);
      return;
  }
  const session = ui.session.value;
  const previous = checkedIn.last(session, verdict.code);
  if (previous !== undefined && !confirmed) {
    const name = rosterByCode.get(verdict.code)?.["姓名"];
    const who = verdict.code === verdict.serial ? verdict.serial : `${verdict.serial}（${name ?? verdict.code}）`;
    showResult("warn", `${who} ${previousCheckIn(session, verdict.code, previous)}（${session}）`, {
      label: "仍要報到",
      run: () => void checkIn(token, true),
    });
    return;
  }
  record(verdict.code, session, verdict.message);
}

/**
 * confirmed：同一場次已報到過的學員，要工作人員按「仍要報到」才記錄。
 * 報到允許重複（例如中途離場再入場），但多半是誤掃，所以預設提醒而不是直接記錄。
 */
async function checkIn(raw: string, confirmed = false): Promise<void> {
  const query = raw.trim();
  if (!query || !config) return;
  if (state() === "offline") {
    showResult("error", "離線中，禁止報到。請確認網路後再試。");
    if (inFlightSince === null) schedule(0);
    return;
  }
  if (config.mode === "ticket") {
    checkInTicket(query, confirmed);
    return;
  }
  let row: CacheRow | null;
  try {
    showResult("info", "查詢中…", undefined, true);
    row = await resolve(query);
  } catch (err) {
    showResult("error", `查詢失敗：${err instanceof Error ? err.message : err}`);
    return;
  }
  if (!row) {
    showResult("error", `查無此學員：${query}`);
    return;
  }
  const session = ui.session.value;
  const code = row[CODE_FIELD];
  const previous = checkedIn.last(session, code);
  if (previous !== undefined && !confirmed) {
    const name = row["姓名"] ? ` ${row["姓名"]}` : "";
    showResult("warn", `${code}${name} 已在 ${clock(previous)} 報到過（${session}）`, {
      label: "仍要報到",
      run: () => void checkIn(code, true),
    });
    return;
  }
  record(code, session, renderTemplate(config.template, row));
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
declare const BarcodeDetector:
  | { new (options: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> }
  | undefined;

type Detect = (video: HTMLVideoElement) => Promise<string | null>;

/** 內建的 BarcodeDetector 支援全部所需格式才用；否則載入 ponyfill。 */
async function createDetector(): Promise<Detect> {
  const { FORMATS, WASM_FILE, createPonyfill } = await import("./barcode.ts");
  // 票券只會是 QR code；不掃一維條碼，免得學員證的條碼被當成票券。
  const formats: BarcodeFormat[] = config?.mode === "ticket" ? ["qr_code"] : [...FORMATS];
  let detector: Detector;
  const supported = typeof BarcodeDetector === "undefined" ? [] : await BarcodeDetector.getSupportedFormats();
  if (typeof BarcodeDetector !== "undefined" && formats.every((f) => supported.includes(f))) {
    detector = new BarcodeDetector({ formats });
  } else {
    detector = createPonyfill(new URL(WASM_FILE, document.baseURI).href, formats);
  }
  return async (video) => (await detector.detect(video).catch(() => []))[0]?.rawValue ?? null;
}

/**
 * 相機只會處在關閉、啟動中、開啟三者之一。啟動要等載入辨識器、使用者授權、影像開始播放，
 * 這段時間按鈕停用：否則再按一次會開第二支串流，換掉 srcObject 而中斷前一次的 play()。
 */
let cameraStarting = false;

function renderCamera(): void {
  ui.scan.classList.toggle("live", !ui.video.hidden);
  ui.camera.disabled = cameraStarting;
  ui.camera.textContent = cameraStarting ? "相機啟動中…" : ui.video.srcObject ? "關閉相機" : "相機";
}

async function startCamera(): Promise<void> {
  cameraStarting = true;
  renderCamera();
  let stream: MediaStream | null = null;
  try {
    const detect = await createDetector();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    ui.video.srcObject = stream;
    ui.video.hidden = false;
    renderCamera();
    await ui.video.play();
    let last = { value: "", at: 0 };
    const loop = async () => {
      if (ui.video.srcObject !== stream) return;
      const value = await detect(ui.video);
      if (value && !(value === last.value && Date.now() - last.at < CAMERA_REPEAT_MS)) {
        last = { value, at: Date.now() };
        void checkIn(value);
      }
      setTimeout(loop, 250);
    };
    void loop();
  } catch (err) {
    // 啟動途中相機已被關掉（srcObject 換了），play() 的中斷不是錯誤。
    if (stream && ui.video.srcObject !== stream) return;
    stream?.getTracks().forEach((t) => t.stop());
    if (ui.video.srcObject === stream) stopCamera();
    throw err;
  } finally {
    cameraStarting = false;
    renderCamera();
  }
}

function stopCamera(): void {
  (ui.video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  ui.video.srcObject = null;
  ui.video.hidden = true;
  renderCamera();
}

ui.camera.hidden = !navigator.mediaDevices?.getUserMedia;
ui.camera.addEventListener("click", () => {
  if (cameraStarting) return;
  if (ui.video.srcObject) stopCamera();
  else startCamera().catch((err) => showResult("error", `無法開啟相機：${err instanceof Error ? err.message : err}`));
});

async function main(): Promise<void> {
  if (!endpoint) {
    showResult("error", "連結缺少部署 ID，請向主辦方取得正確的工作人員連結。", undefined, true);
    return;
  }
  document.body.classList.toggle("sidebar", inSidebar);
  setInterval(renderStatus, 1_000);
  try {
    showResult("info", "載入名單中…", undefined, true);
    await refreshBootstrap();
    lastSuccessAt = Date.now();
    const loaded = config!.mode === "ticket" ? `票券模式：名單上有 ${config!.roster.rows.length} 張票券` : `已載入 ${config!.roster.rows.length} 位學員`;
    showResult("info", `${loaded}，可以開始報到。`);
  } catch (err) {
    lastFailureAt = Date.now();
    lastError = err instanceof Error ? err.message : String(err);
    showResult("error", `載入失敗：${lastError}`, undefined, true);
  }
  render();
  schedule(0);
  ui.input.focus();
}

void main();
