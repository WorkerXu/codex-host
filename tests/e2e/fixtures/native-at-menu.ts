/** Native @ menu fixture with Desktop row classes and mention-section attributes. */
const NATIVE_HEADER_CLASS =
  "text-codex-description shrink-0 h-[var(--suggestion-menu-header-height,auto)] px-row-x py-1 " +
  "text-sm sticky top-0 z-10 " +
  "bg-[var(--suggestion-menu-header-background,var(--color-surface-elevated-secondary))]";
const NATIVE_ROW_CLASS =
  "text-default outline-hidden focus:bg-secondary-ghost-hover cursor-interaction flex w-full " +
  "shrink-0 items-center overflow-hidden text-start min-h-[var(--app-menu-item-height,0px)] " +
  "rounded-[var(--suggestion-menu-item-radius,var(--radius-xl))] " +
  "p-[var(--suggestion-menu-item-padding,var(--app-menu-item-padding,var(--padding-row-y)_var(--padding-row-x)))] " +
  "text-sm [content-visibility:auto] [contain-intrinsic-block-size:auto_1lh]";
const NATIVE_ROW_CONTENT_CLASS =
  "flex w-full min-w-0 items-center gap-[var(--spacing-menu-item-content,calc(var(--spacing)*1.5))]";
const NATIVE_ROW_ACTIVE = "bg-secondary-ghost-hover opacity-100";
const NATIVE_ROW_IDLE = "menu-row-opacity";

function nativeRow(
  label: string,
  options: { active?: boolean; description?: string } = {},
): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.setAttribute("data-list-navigation-item", "true");
  row.className = `${NATIVE_ROW_CLASS} ${options.active ? NATIVE_ROW_ACTIVE : NATIVE_ROW_IDLE}`;
  if (options.active) row.setAttribute("aria-current", "true");
  const content = document.createElement("div");
  content.setAttribute("data-menu-row-content", "true");
  content.className = NATIVE_ROW_CONTENT_CLASS;
  const labelSpan = document.createElement("span");
  labelSpan.className = "min-w-0 truncate";
  labelSpan.textContent = label;
  content.append(labelSpan);
  if (options.description) {
    const description = document.createElement("span");
    description.className = "min-w-0 flex-1 truncate text-sm text-codex-description";
    description.textContent = options.description;
    content.append(description);
  }
  row.append(content);
  return row;
}

function nativeSection(id: string, title: string, rows: HTMLElement[], first = false): HTMLElement {
  const section = document.createElement("div");
  section.setAttribute("data-mention-section-id", id);
  const header = document.createElement("div");
  header.className = first ? NATIVE_HEADER_CLASS : `${NATIVE_HEADER_CLASS} pt-2`;
  header.textContent = title;
  const items = document.createElement("div");
  items.setAttribute("data-mention-section-items", "true");
  items.append(...rows);
  section.append(header, items);
  return section;
}

/** Panel + the single native scroll container that owns every section. */
export function nativeAtMenu(): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "preview-at-menu suggestionMenu-Preview";
  const scroll = document.createElement("div");
  scroll.className = "vertical-scroll-fade-mask flex w-full flex-1 flex-col overflow-y-auto";
  scroll.setAttribute("data-mention-list-scroll-area", "");
  scroll.append(
    nativeSection("context-actions", "添加", [nativeRow("文件和文件夹"), nativeRow("图片")], true),
    nativeSection("agents", "智能体", [
      nativeRow("Codex", { description: "默认编码智能体", active: true }),
    ]),
  );
  panel.append(scroll);
  return panel;
}
