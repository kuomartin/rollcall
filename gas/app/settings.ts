// Script Properties 裡的設定、名單版本、部署 ID、金鑰對、前綴登記與入口名稱。只有試算表擁有者能改設定。

import type { Mode } from "../../core/api.ts";

const KEY = {
  template: "template",
  sessions: "sessions",
  mode: "mode",
  rosterVersion: "rosterVersion",
  deploymentId: "deploymentId",
  seed: "SIGNING_SEED",
  publicKey: "PUBLIC_KEY",
  prefixes: "prefixes",
} as const;
const GATE_PREFIX = "gate:";

export const DEFAULT_TEMPLATE = "報到成功：{{姓名}}";
export const DEFAULT_SESSIONS = ["報到"];

export interface Settings {
  template: string;
  sessions: string[];
  mode: Mode;
}

function props(): GoogleAppsScript.Properties.Properties {
  return PropertiesService.getScriptProperties();
}

export function parseSessions(text: string): string[] {
  return [...new Set(text.split(/[,，]/).map((s) => s.trim()).filter(Boolean))];
}

export function getSettings(): Settings {
  const p = props();
  const sessions = p.getProperty(KEY.sessions);
  return {
    template: p.getProperty(KEY.template) ?? DEFAULT_TEMPLATE,
    sessions: sessions ? (JSON.parse(sessions) as string[]) : DEFAULT_SESSIONS,
    mode: p.getProperty(KEY.mode) === "ticket" ? "ticket" : "code",
  };
}

export function saveSettings(settings: Settings): void {
  props().setProperties({
    [KEY.template]: settings.template,
    [KEY.sessions]: JSON.stringify(settings.sessions),
    [KEY.mode]: settings.mode,
  });
  bumpRosterVersion();
}

export function rosterVersion(): string {
  return props().getProperty(KEY.rosterVersion) ?? "0";
}

/** 名單或模板變了：各裝置下次同步時重抓名單快取。 */
export function bumpRosterVersion(): void {
  props().setProperty(KEY.rosterVersion, String(Date.now()));
}

export function deploymentId(): string | null {
  return props().getProperty(KEY.deploymentId);
}

export function storeDeploymentId(id: string): void {
  if (props().getProperty(KEY.deploymentId) !== id) props().setProperty(KEY.deploymentId, id);
}

/** 金鑰對的種子與公鑰，皆為 base64url；私鑰由種子重新推導。 */
export function signingKeys(): { seed: string; publicKey: string } | null {
  const p = props();
  const seed = p.getProperty(KEY.seed);
  const publicKey = p.getProperty(KEY.publicKey);
  return seed && publicKey ? { seed, publicKey } : null;
}

export function storeSigningKeys(seed: string, publicKey: string): void {
  props().setProperties({ [KEY.seed]: seed, [KEY.publicKey]: publicKey });
  bumpRosterVersion();
}

export type PrefixUse = "名單" | "實體";

/** 前綴登記：每個前綴的用途、下一號與位數。 */
export interface PrefixEntry {
  use: PrefixUse;
  next: number;
  width: number;
}

export function prefixes(): Record<string, PrefixEntry> {
  const raw = props().getProperty(KEY.prefixes);
  return raw ? (JSON.parse(raw) as Record<string, PrefixEntry>) : {};
}

export function storePrefixes(entries: Record<string, PrefixEntry>): void {
  props().setProperty(KEY.prefixes, JSON.stringify(entries));
}

const gateKey = (deviceId: string) => `${GATE_PREFIX}${deviceId}`;

function gatesFrom(all: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) if (key.startsWith(GATE_PREFIX)) out[key.slice(GATE_PREFIX.length)] = value;
  return out;
}

/** deviceId → 入口名稱。 */
export function gates(): Record<string, string> {
  return gatesFrom(props().getProperties());
}

/** 入口名稱有變才寫入，回傳最新的對照。 */
export function syncGate(deviceId: string, name: string | undefined): Record<string, string> {
  const all = props().getProperties();
  if (name !== undefined && all[gateKey(deviceId)] !== name) {
    props().setProperty(gateKey(deviceId), name);
    all[gateKey(deviceId)] = name;
  }
  return gatesFrom(all);
}
