// Script Properties 裡的設定、名單版本與部署 ID。只有試算表擁有者能改。

const KEY = {
  template: "template",
  sessions: "sessions",
  rosterVersion: "rosterVersion",
  deploymentId: "deploymentId",
} as const;

export const DEFAULT_TEMPLATE = "報到成功：{{姓名}}";
export const DEFAULT_SESSIONS = ["報到"];

export interface Settings {
  template: string;
  sessions: string[];
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
  };
}

export function saveSettings(settings: Settings): void {
  props().setProperties({
    [KEY.template]: settings.template,
    [KEY.sessions]: JSON.stringify(settings.sessions),
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
