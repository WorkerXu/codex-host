/** Semantic classes are DOM hooks; styles compile into the settings Tailwind sheet. */
const classes: Record<string, string> = {
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
    "skills-agent-row grid min-w-[680px] grid-cols-[minmax(120px,1fr)_minmax(160px,1.4fr)_100px_184px] items-center gap-4 border-b border-settings-divider px-4 py-3 last:border-b-0",
  "skills-agent-excluded":
    "skills-agent-row grid min-w-[680px] grid-cols-[minmax(120px,1fr)_minmax(160px,1.4fr)_100px_184px] items-center gap-4 border-b border-settings-divider px-4 py-3 text-settings-subtle last:border-b-0",
  "skills-path": "skills-path min-w-0 truncate text-xs text-settings-muted",
  "skills-agent-progress":
    "skills-agent-progress flex items-center gap-2 whitespace-nowrap text-xs text-settings-muted",
  "skills-conflict-badge":
    "skills-conflict-badge inline-flex items-center gap-1 rounded-md bg-settings-warning/10 px-2 py-0.5 text-xs text-settings-warning",
  "skills-exclusions":
    "skills-exclusions flex flex-wrap items-center gap-2 border-t border-settings-divider pt-4",
  "skills-notice": "skills-notice text-settings-danger empty:hidden",
  "skills-empty": "skills-empty m-0 px-4 py-5 text-xs text-settings-muted",
  "skills-skeleton": "skills-skeleton h-40 rounded-lg bg-settings-hover",
  "skills-dialog":
    "skills-dialog box-border w-[min(680px,calc(100vw-48px))] max-h-[calc(100vh-48px)] rounded-xl border border-settings-border bg-settings-panel p-6 text-sm leading-5 text-settings-text shadow-xl backdrop:bg-black/30 [&_h2]:mt-0 [&_h2]:mb-5 [&_h2]:text-base [&_h2]:font-semibold [&_select]:rounded-md [&_select]:border [&_select]:border-settings-border [&_select]:bg-settings-panel [&_select]:px-3 [&_select]:py-2 [&_select]:text-settings-text [&_input[type=checkbox]]:accent-settings-focus [&_input[type=radio]]:accent-settings-focus",
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
  "skills-file-list": "skills-file-list m-0 grid list-none gap-1 p-0 text-xs text-settings-muted",
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
  "skills-link-choice":
    "skills-link-choice flex cursor-pointer items-center gap-2 text-xs [&_input]:size-4 [&_input]:accent-settings-focus [&_input:focus-visible]:outline-2 [&_input:focus-visible]:outline-offset-2 [&_input:focus-visible]:outline-settings-focus",
};
export function skillsClass(name: string): string {
  return classes[name] ?? name;
}

/** Page-local bindings use the same semantic tokens as the native Desktop controls. */
export const skillsNativeTokens: Record<string, string> = {
  "--settings-panel": "var(--app-color-background-surface, light-dark(#fff,#181818))",
  "--settings-surface":
    "var(--app-color-background-elevated-secondary, light-dark(#f6f6f6,#232323))",
  "--settings-inset": "var(--app-color-background-elevated-secondary, light-dark(#f6f6f6,#232323))",
  "--settings-text": "var(--app-color-text-foreground, light-dark(#0d0d0d,#ececec))",
  "--settings-muted": "var(--app-color-text-foreground-tertiary, light-dark(#676767,#a3a3a3))",
  "--settings-subtle": "var(--app-color-text-foreground-tertiary, light-dark(#8a8a8a,#777))",
  "--settings-border": "var(--color-token-border-default, light-dark(#e5e5e5,#383838))",
  "--settings-divider": "var(--color-token-border-default, light-dark(#e5e5e5,#383838))",
  "--settings-hover": "var(--color-token-list-hover-background, light-dark(#f0f0f0,#303030))",
  "--settings-focus": "var(--focus-outline-color, light-dark(#0b75d1,#66aaf9))",
  "--settings-primary": "var(--color-background-primary-solid, light-dark(#171717,#f4f4f4))",
  "--settings-primary-hover":
    "var(--color-background-primary-solid-hover, light-dark(#2f2f2f,#fff))",
  "--settings-primary-text": "var(--color-text-primary-solid, light-dark(#fff,#171717))",
  "--settings-warning": "var(--app-color-text-warning, light-dark(#a45800,#ffb15b))",
  "--settings-success": "var(--app-color-text-success, light-dark(#008641,#6cdb9b))",
  "--settings-danger": "var(--app-color-text-error, light-dark(#b42318,#f87171))",
};
