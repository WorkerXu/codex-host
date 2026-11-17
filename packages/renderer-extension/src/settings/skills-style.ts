/** Semantic classes are DOM hooks; all styling is compiled into the settings Tailwind sheet. */
const classes: Record<string, string> = {
  "skills-hub":
    "skills-hub mx-auto flex max-w-[1100px] flex-col gap-6 text-sm leading-5 text-settings-text [&_h3]:my-4 [&_h3]:text-sm [&_h3]:font-semibold [&_table]:w-full [&_table]:border-collapse [&_table]:text-left [&_th]:border-b [&_th]:border-settings-border [&_th]:p-3 [&_th]:font-normal [&_th]:whitespace-nowrap [&_th]:text-settings-subtle [&_td]:border-b [&_td]:border-settings-border [&_td]:p-3 [&_td]:align-middle [&_td_strong]:font-medium [&_input:focus-visible]:outline-2 [&_input:focus-visible]:outline-offset-2 [&_input:focus-visible]:outline-settings-focus",
  "skills-head":
    "skills-head flex flex-wrap items-center gap-3 [&_h1]:m-0 [&_h1]:mr-auto [&_h1]:text-base [&_h1]:font-semibold [&_h2]:m-0 [&_h2]:mr-auto [&_h2]:text-base [&_h2]:font-semibold",
  "skills-matrix": "skills-matrix min-w-0 overflow-x-auto",
  "skills-description":
    "skills-description mt-1 block max-w-[300px] truncate text-xs leading-4 text-settings-subtle",
  "skills-muted": "skills-muted text-xs text-settings-subtle",
  "skills-different": "skills-different text-settings-focus",
  "skills-path": "skills-path max-w-[240px] truncate text-xs text-settings-subtle",
  "skills-machines": "skills-machines flex flex-col gap-6",
  "skills-machine": "skills-machine flex flex-col gap-3 overflow-x-auto",
  "skills-exclusions": "skills-exclusions flex items-center gap-2",
  "skills-notice": "skills-notice text-settings-danger empty:hidden",
  "skills-empty": "skills-empty py-6 text-settings-subtle",
  "skills-skeleton": "skills-skeleton h-40 rounded-lg bg-settings-hover",
  "skills-dialog":
    "skills-dialog box-border w-[min(760px,calc(100vw-48px))] max-h-[calc(100vh-64px)] rounded-xl border border-settings-border bg-settings-panel p-6 text-sm leading-5 text-settings-text backdrop:bg-black/30 [&_h2]:mt-0 [&_h2]:mb-4 [&_h2]:text-base [&_h2]:font-semibold [&_select]:ml-3 [&_select]:rounded-md [&_select]:border [&_select]:border-settings-border [&_select]:bg-settings-surface [&_select]:px-3 [&_select]:py-2 [&_select]:text-settings-text [&_textarea]:box-border [&_textarea]:block [&_textarea]:min-h-40 [&_textarea]:w-full [&_textarea]:resize-y [&_textarea]:rounded-md [&_textarea]:border [&_textarea]:border-settings-border [&_textarea]:bg-settings-surface [&_textarea]:px-3 [&_textarea]:py-2 [&_textarea]:text-settings-text [&_textarea:focus-visible]:outline-2 [&_textarea:focus-visible]:outline-settings-focus",
  "skills-dialog-body":
    "skills-dialog-body max-h-[calc(100vh-240px)] overflow-auto [&_p]:mt-0 [&_p]:mb-3",
  "skills-actions": "skills-actions mt-6 flex justify-end gap-2",
  "skills-version":
    "skills-version my-2 flex cursor-pointer items-start gap-3 rounded-lg border border-settings-border p-3 [&_.skills-description]:max-w-[560px] [&_.skills-description]:wrap-anywhere [&_.skills-description]:whitespace-normal",
  "skills-diff":
    "skills-diff max-h-[200px] overflow-auto rounded-md bg-settings-inset p-3 text-xs whitespace-pre-wrap wrap-anywhere",
  "skills-target": "skills-target flex items-center gap-2 py-2",
  "skills-link-row":
    "skills-link-row flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-settings-border py-3 [&_strong]:mr-auto",
};
export function skillsClass(name: string): string {
  return classes[name] ?? name;
}
export const skillsButtonClass =
  "skills-button cursor-pointer appearance-none rounded-md border-0 bg-transparent px-3 py-2 text-sm leading-5 whitespace-nowrap text-settings-text transition-colors duration-120 hover:bg-settings-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-focus disabled:cursor-default disabled:opacity-45";
