import { createRendererSettingsIcon } from "./icons.js";
import { hubButton, hubElement, hubIconButton } from "./hub-admin-ui.js";

export function validateHubHeaders(rows: readonly (readonly [string, string])[]): {
  value?: Record<string, string>;
  error?: string;
} {
  const used = new Set<string>();
  const entries: [string, string][] = [];
  for (const [rawName, value] of rows) {
    const name = rawName.trim();
    if (!name && !value) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) return { error: "请输入有效的请求头名称" };
    if (/[\r\n]/u.test(value)) return { error: "请求头内容不能包含换行" };
    if (used.has(name.toLowerCase())) return { error: "请求头名称不能重复" };
    used.add(name.toLowerCase());
    entries.push([name, value]);
  }
  return { value: Object.fromEntries(entries) };
}
export function createHubHeaderEditor(document: Document) {
  const root = hubElement(document, "div", "hub-field hub-header-editor");
  root.append(hubElement(document, "span", "", "请求头"));
  const rows = hubElement(document, "div", "hub-header-rows");
  const error = hubElement(document, "p", "hub-field-error");
  error.setAttribute("role", "alert");
  let touched = false;
  const add = () => {
    const row = hubElement(document, "div", "hub-header-row");
    const key = hubElement(document, "input");
    key.placeholder = "名称";
    key.setAttribute("aria-label", "请求头名称");
    const value = hubElement(document, "input");
    value.placeholder = "内容";
    value.setAttribute("aria-label", "请求头内容");
    row.append(
      key,
      value,
      hubIconButton(document, "删除请求头", "trash", () => {
        touched = true;
        row.remove();
      }),
    );
    row.addEventListener("input", () => {
      touched = true;
      error.textContent = "";
    });
    rows.append(row);
  };
  const addButton = hubButton(document, "添加一行", () => {
    add();
    touched = true;
    rows.lastElementChild?.querySelector("input")?.focus();
  });
  addButton.prepend(createRendererSettingsIcon("add", 16));
  root.append(rows, addButton, error);
  add();
  return {
    root,
    read() {
      const result = validateHubHeaders(
        [...rows.children].map((row) => {
          const inputs = row.querySelectorAll("input");
          return [inputs[0]?.value ?? "", inputs[1]?.value ?? ""] as const;
        }),
      );
      error.textContent = result.error ?? "";
      if (result.error) throw new Error("invalid");
      return touched ? result.value : undefined;
    },
  };
}
