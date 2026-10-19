// 報到成功訊息的 `{{欄位}}` 模板。

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

/** 模板引用到的欄位名稱，依出現順序、不重複。名單快取只帶這些欄位。 */
export function referencedFields(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) seen.add(match[1].trim());
  return [...seen];
}

/** 模板引用了、但學員名單標題沒有的欄位。非空代表模板不能儲存。 */
export function unknownFields(template: string, headers: readonly string[]): string[] {
  const known = new Set(headers);
  return referencedFields(template).filter((field) => !known.has(field));
}

/** 欄位缺值或為空時代入空字串，輸出不會殘留 `{{…}}`。 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, unknown>>,
): string {
  return template.replace(PLACEHOLDER, (_, raw: string) => {
    const value = values[raw.trim()];
    return value === null || value === undefined ? "" : String(value);
  });
}
