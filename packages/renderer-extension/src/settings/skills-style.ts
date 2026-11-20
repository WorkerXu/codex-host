/** Semantic classes are DOM hooks; styles compile into the settings Tailwind sheet. */
const classes: Record<string, string> = {
  "skills-view": "skills-view flex flex-col gap-4",
  "skills-undo":
    "skills-undo flex flex-wrap items-center gap-2 rounded-lg border border-settings-border bg-settings-surface px-3 py-2 text-xs",
  "skills-tabs": "skills-tabs flex w-fit gap-1 rounded-lg bg-settings-hover/70 p-1",
  "skills-tab":
    "skills-tab rounded-md border-0 bg-transparent px-3 py-1.5 text-xs font-medium text-settings-muted transition-colors hover:text-settings-text aria-selected:bg-settings-panel aria-selected:text-settings-text aria-selected:shadow-sm",
  "skills-toolbar": "skills-toolbar flex flex-wrap items-center gap-2",
  "skills-search":
    "skills-search h-9 min-w-[220px] flex-1 rounded-lg border border-settings-border bg-settings-panel px-3 text-sm text-settings-text outline-none placeholder:text-settings-subtle focus:border-settings-focus",
  "skills-segmented": "skills-segmented inline-flex rounded-lg bg-settings-hover/70 p-0.5",
  "skills-filter":
    "skills-filter rounded-md border-0 bg-transparent px-2.5 py-1.5 text-xs text-settings-muted aria-pressed:bg-settings-panel aria-pressed:text-settings-text aria-pressed:shadow-sm",
  "skills-select":
    "skills-select h-9 rounded-lg border border-settings-border bg-settings-panel px-2 text-xs text-settings-text outline-none focus:border-settings-focus",
  "skills-layout-toggle":
    "skills-layout-toggle inline-flex rounded-lg border border-settings-border p-0.5",
  "skills-layout-button":
    "skills-layout-button inline-flex size-7 items-center justify-center rounded-md border-0 bg-transparent text-settings-muted hover:bg-settings-hover aria-pressed:bg-settings-hover aria-pressed:text-settings-text",
  "skills-grid": "skills-grid grid gap-4 sm:grid-cols-2 xl:grid-cols-3",
  "skills-list": "skills-list flex flex-col gap-2",
  "skills-card":
    "skills-card min-w-0 flex flex-col gap-2.5 rounded-xl border border-settings-border bg-settings-panel p-4 transition-colors hover:border-settings-focus/40",
  "skills-card-list":
    "skills-card-list sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,.8fr)_minmax(0,2fr)_auto] sm:items-center sm:gap-3",
  "skills-card-head": "skills-card-head flex min-w-0 items-center gap-2",
  "skills-card-name": "skills-card-name m-0 min-w-0 truncate text-sm font-semibold",
  "skills-version-chip":
    "skills-version-chip shrink-0 rounded bg-settings-hover px-1.5 py-0.5 text-[10px] font-normal text-settings-muted",
  "skills-card-description":
    "skills-card-description m-0 truncate text-xs leading-4 text-settings-muted",
  "skills-card-meta":
    "skills-card-meta min-w-0 truncate text-[11px] leading-4 text-settings-subtle",
  "skills-source": "skills-source truncate",
  "skills-chips": "skills-chips flex flex-wrap items-center gap-1.5 text-[11px] leading-4",
  "skills-chip":
    "skills-chip rounded-md bg-settings-hover px-1.5 py-0.5 text-[11px] leading-4 text-settings-muted data-[state=same]:text-settings-success data-[state=different]:text-settings-warning data-[state=missing]:text-settings-subtle",
  "skills-chip-action":
    "skills-chip-action rounded-md border border-settings-border bg-transparent px-2 py-0.5 text-[11px] leading-4 text-settings-muted hover:bg-settings-hover",
  "skills-badges": "skills-badges flex flex-wrap items-center gap-1 pt-0.5",
  "skills-badge":
    "skills-badge inline-flex size-6 items-center justify-center rounded-full border border-settings-border bg-settings-panel opacity-40 transition-opacity hover:opacity-100 data-[linked=true]:border-settings-focus/50 data-[linked=true]:opacity-100 data-[native=true]:border-settings-success/40 [&_span]:text-[10px]",
  "skills-machine-group": "skills-machine-group flex flex-col gap-3",
  "skills-machine-heading":
    "skills-machine-heading flex flex-wrap items-center gap-2 [&_h3]:m-0 [&_h3]:text-sm [&_h3]:font-semibold",
  "skills-agent-grid": "skills-agent-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-3",
  "skills-agent-card":
    "skills-agent-card flex w-full items-center gap-3 rounded-xl border border-settings-border bg-settings-panel p-3 text-left transition-colors hover:bg-settings-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-settings-focus",
  "skills-agent-icon":
    "skills-agent-icon flex size-9 shrink-0 items-center justify-center rounded-lg bg-settings-hover text-[11px] font-medium",
  "skills-agent-info": "skills-agent-info flex min-w-0 flex-1 flex-col gap-0.5",
  "skills-agent-title":
    "skills-agent-title flex min-w-0 items-center gap-2 text-sm [&_strong]:truncate [&_strong]:font-medium",
  "skills-agent-tags": "skills-agent-tags mt-1 flex flex-wrap items-center gap-1.5",
  "skills-detail-head": "skills-detail-head flex items-start gap-3",
  "skills-back":
    "skills-back inline-flex size-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-settings-muted hover:bg-settings-hover",
  "skills-detail-title": "skills-detail-title flex items-center gap-3",
  "skills-detail-stats": "skills-detail-stats m-0 text-xs text-settings-muted",
  "skills-skill-grid": "skills-skill-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-3",
  "skills-skill-card":
    "skills-skill-card flex flex-col gap-1.5 rounded-lg border border-settings-border bg-settings-panel p-3",
  "skills-skill-top":
    "skills-skill-top flex items-start justify-between gap-2 [&_strong]:text-sm [&_strong]:font-medium",
  "skills-state":
    "skills-state inline-flex items-center whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] leading-4",
  "skills-status-linked": "skills-status-linked bg-settings-success/10 text-settings-success",
  "skills-status-missing": "skills-status-missing bg-settings-hover text-settings-subtle",
  "skills-status-conflict": "skills-status-conflict bg-settings-warning/10 text-settings-warning",
  "skills-status-native": "skills-status-native bg-settings-focus/10 text-settings-focus",
  "skills-status-managed": "skills-status-managed bg-settings-hover text-settings-muted",
  "skills-hub":
    "skills-hub mx-auto flex max-w-[1100px] flex-col gap-6 text-sm leading-5 text-settings-text [&_h3]:m-0 [&_h3]:text-sm [&_h3]:font-semibold",
  "skills-head":
    "skills-head flex flex-wrap items-center gap-3 [&_h1]:m-0 [&_h1]:mr-auto [&_h1]:text-base [&_h1]:font-semibold [&_h2]:m-0 [&_h2]:text-sm [&_h2]:font-semibold",
  "skills-matrix":
    "skills-matrix min-w-0 overflow-x-auto [&_table]:w-full [&_table]:border-collapse [&_table]:text-left [&_th]:border-b [&_th]:border-settings-border [&_th]:px-4 [&_th]:py-3 [&_th]:text-xs [&_th]:font-medium [&_th]:whitespace-nowrap [&_th]:text-settings-muted [&_td]:border-b [&_td]:border-settings-divider [&_td]:px-4 [&_td]:py-3 [&_td]:align-middle [&_tbody_tr]:transition-colors [&_tbody_tr]:duration-120 [&_tbody_tr:hover]:bg-settings-hover [&_td_strong]:font-medium",
  "skills-description":
    "skills-description mt-1 block max-w-[300px] truncate text-xs leading-4 text-settings-muted",
  "skills-muted": "skills-muted text-xs text-settings-muted",
  "skills-status": "skills-status inline-flex items-center gap-2 whitespace-nowrap text-xs",
  "skills-success":
    "skills-status inline-flex items-center gap-2 whitespace-nowrap text-xs text-settings-success",
  "skills-warning":
    "skills-status inline-flex items-center gap-2 whitespace-nowrap text-xs text-settings-warning",
  "skills-missing":
    "skills-status inline-flex items-center gap-2 whitespace-nowrap text-xs text-settings-subtle",
  "skills-machines": "skills-machines flex flex-col gap-4",
  "skills-machine":
    "skills-machine overflow-hidden rounded-xl border border-settings-border bg-settings-panel",
  "skills-machine-head":
    "skills-machine-head flex flex-wrap items-center gap-3 border-b border-settings-divider px-4 py-3 [&_h2]:m-0 [&_h2]:text-sm [&_h2]:font-semibold",
  "skills-machine-title": "skills-machine-title mr-auto flex items-center gap-2",
  "skills-online": "skills-online size-1.5 shrink-0 rounded-full bg-settings-success",
  "skills-offline": "skills-offline size-1.5 shrink-0 rounded-full bg-settings-subtle",
  "skills-agent-scroll": "skills-agent-scroll overflow-x-auto",
  "skills-agent-row":
    "skills-agent-row grid min-w-[608px] grid-cols-[160px_200px_minmax(180px,1fr)] items-center gap-4 border-b border-settings-divider px-4 py-3 last:border-b-0",
  "skills-path": "skills-path min-w-0 truncate text-xs text-settings-muted",
  "skills-agent-progress":
    "skills-agent-progress flex items-center gap-2 whitespace-nowrap text-xs text-settings-muted",
  "skills-agent-linked": "skills-agent-linked inline-flex items-center gap-2 text-settings-success",
  "skills-conflict-badge":
    "skills-conflict-badge inline-flex items-center gap-1 rounded-md bg-settings-warning/10 px-2 py-0.5 text-xs text-settings-warning",
  "skills-notice": "skills-notice text-settings-danger empty:hidden",
  "skills-empty": "skills-empty m-0 px-4 py-5 text-xs text-settings-muted",
  "skills-skeleton": "skills-skeleton h-40 rounded-lg bg-settings-hover",
  "skills-dialog":
    "skills-dialog box-border w-[min(680px,calc(100vw-48px))] max-h-[calc(100vh-48px)] rounded-xl border border-settings-border bg-settings-panel p-6 text-sm leading-5 text-settings-text shadow-xl backdrop:bg-[var(--dialog-backdrop-dim-background)] [&_h2]:mt-0 [&_h2]:mb-5 [&_h2]:text-base [&_h2]:font-semibold [&_select]:rounded-md [&_select]:border [&_select]:border-settings-border [&_select]:bg-settings-panel [&_select]:px-3 [&_select]:py-2 [&_select]:text-settings-text [&_input[type=checkbox]]:accent-settings-focus [&_input[type=radio]]:accent-settings-focus",
  "skills-dialog-body":
    "skills-dialog-body flex max-h-[calc(100vh-224px)] flex-col gap-4 overflow-auto [&_p]:m-0",
  "skills-actions": "skills-actions mt-5 flex justify-end gap-2",
  "skills-versions": "skills-versions grid gap-2 sm:grid-cols-2",
  "skills-version":
    "skills-version flex cursor-pointer items-start gap-3 rounded-lg border border-settings-border p-3 transition-colors duration-120 hover:bg-settings-hover has-[:checked]:border-settings-focus has-[:checked]:bg-settings-focus/5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-settings-focus/30 has-[:focus-visible]:ring-inset [&_input]:mt-1 [&_input:focus-visible]:outline-none",
  "skills-version-meta": "skills-version-meta mt-1 block text-xs leading-5 text-settings-muted",
  "skills-newer":
    "skills-newer ml-2 rounded bg-settings-hover px-1.5 py-0.5 text-xs font-normal text-settings-muted",
  "skills-diff-heading": "skills-diff-heading text-xs text-settings-muted",
  "skills-diff":
    "skills-diff overflow-hidden rounded-lg border border-settings-divider font-mono text-xs leading-5 [&_div]:min-h-5 [&_div]:px-3 [&_div]:whitespace-pre-wrap [&_div]:wrap-anywhere",
  "skills-diff-add": "skills-diff-add bg-settings-success/10 text-settings-success",
  "skills-diff-remove": "skills-diff-remove bg-settings-danger/10 text-settings-danger",
  "skills-diff-context": "skills-diff-context bg-settings-inset text-settings-muted",
  "skills-file-summary":
    "skills-file-summary flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm px-1 py-0.5 text-xs leading-5 text-settings-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-settings-focus [&::-webkit-details-marker]:hidden",
  "skills-file-list":
    "skills-file-list mt-2 mb-0 grid list-none gap-1 pl-5 text-xs text-settings-muted",
  "skills-target":
    "skills-target flex cursor-pointer items-center gap-2 rounded-md py-1 text-sm [&_input]:size-4 [&_input:focus-visible]:outline-2 [&_input:focus-visible]:outline-offset-2 [&_input:focus-visible]:outline-settings-focus",
  "skills-field": "skills-field flex flex-wrap items-center gap-2",
  "skills-summary": "skills-summary text-sm text-settings-text",
  "skills-link-group": "skills-link-group overflow-hidden rounded-lg border border-settings-border",
  "skills-link-group-head":
    "skills-link-group-head flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-settings-divider bg-settings-surface px-3 py-2",
  "skills-link-row":
    "skills-link-row flex min-h-11 flex-wrap items-center gap-3 border-b border-settings-divider px-3 py-2 last:border-b-0 [&_strong]:mr-auto [&_strong]:font-normal",
  "skills-action-tag":
    "skills-action-tag rounded bg-settings-hover px-2 py-0.5 text-xs text-settings-muted",
  "skills-link-choice": "skills-link-choice flex cursor-pointer items-center gap-2 text-xs",
};
export function skillsClass(name: string): string {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) => classes[token] ?? token)
    .join(" ");
}

/** Page-local bindings use the same semantic tokens as the native Desktop controls. */
export const skillsNativeTokens: Record<string, string> = {
  "--settings-panel": "var(--app-color-background-surface)",
  "--settings-surface": "var(--app-color-background-elevated-secondary)",
  "--settings-inset": "var(--app-color-background-elevated-secondary)",
  "--settings-text": "var(--app-color-text-foreground)",
  "--settings-muted": "var(--color-text-secondary)",
  "--settings-subtle": "var(--app-color-text-foreground-tertiary)",
  "--settings-border": "var(--color-token-border-default)",
  "--settings-divider": "var(--color-token-border-default)",
  "--settings-hover": "var(--color-token-list-hover-background)",
  "--settings-focus": "var(--focus-outline-color)",
  "--settings-primary": "var(--color-background-primary-solid)",
  "--settings-primary-hover": "var(--color-background-primary-solid-hover)",
  "--settings-primary-text": "var(--color-text-primary-solid)",
  "--settings-warning": "var(--app-color-text-warning)",
  "--settings-success": "var(--app-color-text-success)",
  "--settings-danger": "var(--app-color-text-error)",
};
