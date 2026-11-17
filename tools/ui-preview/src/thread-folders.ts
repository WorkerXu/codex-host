import nativeComposerHtml from "../fixtures/native-composer.html";
import { pickDesktopFolders } from "../../../packages/renderer-extension/src/renderer-folder-picker.js";
import {
  createThreadFoldersControl,
  folderIcon,
  updateThreadFoldersNote,
} from "../../../packages/renderer-extension/src/renderer-thread-folders-control.js";

/** Captured Desktop Composer DOM; only filesystem and Host replies are fixtures. */
export function mountThreadFoldersPreview(root: HTMLElement, scenario: string) {
  document.documentElement.dataset.codexWindowType = "electron";
  const remote = scenario === "thread-folders-remote";
  const existing = scenario === "thread-folders-existing";
  const prefix = remote ? "/home/ubuntu" : "/Users/lin";
  const project = `${prefix}/Projects/codexhost`;
  const pickerMode = new URL(location.href).searchParams.get("picker") ?? "unavailable";
  const pickerModule =
    location.protocol === "about:"
      ? "about:rpc-folder-picker-preview.js"
      : new URL("/assets/rpc-folder-picker-preview.js", location.href).href;
  Reflect.set(window, "__codexhostLoadedModulesV1", {
    complete: true,
    documentUrl: location.href,
    urls: [pickerModule],
  });
  let folders = scenario === "thread-folders-empty" ? [] : [project];
  const recent =
    scenario === "thread-folders-empty"
      ? []
      : [
          `${prefix}/Projects/shared-ui`,
          `${prefix}/Projects/docs`,
          `${prefix}/Projects/workbench/packages/design-system/components/shared-components`,
        ];
  const style = document.createElement("style");
  style.textContent = `
    html, body, #preview-root { width:100%; height:100%; margin:0; }
    #preview-root { background:var(--color-token-main-surface-primary); }
    body { background:var(--color-token-main-surface-primary); color:var(--color-token-text-primary); font-family:var(--font-sans); }
    .folders-preview { box-sizing:border-box; display:flex; flex-direction:column; justify-content:flex-end; gap:24px; width:min(800px,100%); height:100dvh; margin:auto; padding:32px 24px; }
    .folders-preview [data-above-composer-portal] { padding-bottom:8px; }
    .folders-preview-transcript { margin-bottom:32px; font-size:var(--font-text-sm-size); line-height:1.6; }
    .folders-preview-transcript p { margin:12px 0; }
    .folders-preview-transcript h1 { margin:0 0 32px; font-size:var(--font-heading-lg-size); font-weight:600; }
  `;
  document.head.append(style);
  const stage = document.createElement("main");
  stage.className = "folders-preview";
  if (existing) {
    const transcript = document.createElement("article");
    transcript.className = "folders-preview-transcript";
    transcript.innerHTML =
      "<h1>梳理组件结构</h1><p>基础组件已整理好。接下来检查共享目录里的引用关系。</p>";
    stage.append(transcript);
  }
  const note = document.createElement("div");
  note.className = "codexhost-folders-note";
  note.setAttribute("role", "status");
  note.hidden = true;
  stage.append(note);
  const fragment = document.createElement("div");
  fragment.innerHTML = nativeComposerHtml;
  const composer = fragment.querySelector<HTMLElement>("[data-codex-composer-root]")!;
  const editor = composer.querySelector<HTMLElement>("[contenteditable]")!;
  editor.innerHTML =
    '<p data-empty-paragraph="true" data-placeholder="和 Codex 一起工作" class="placeholder before:composer-placeholder"><br class="ProseMirror-trailingBreak"></p>';
  stage.append(composer);
  root.append(stage);
  const above = composer.querySelector<HTMLElement>("[data-above-composer-portal]")!;
  const machine = document.createElement("button");
  machine.type = "button";
  machine.className = "codexhost-folders-chip";
  machine.innerHTML = `${folderIcon}<span>${remote ? "开发机" : "本机"} · codexhost</span>`;
  machine.setAttribute("aria-label", "机器与项目");
  above.append(machine);
  const nativeButton = composer.querySelector<HTMLButtonElement>(
    "[data-composer-navigation-target=add-context]",
  )!;
  const model = nativeButton.cloneNode(false) as HTMLButtonElement;
  model.classList.remove("aspect-square", "!px-0");
  model.removeAttribute("aria-label");
  model.removeAttribute("data-composer-navigation-target");
  model.textContent = scenario === "thread-folders-limited" ? "Example Harness ⌄" : "Codex ⌄";
  nativeButton.after(model);
  const control = createThreadFoldersControl({
    document,
    pickLocal: () =>
      pickDesktopFolders(window, async () => ({
        appServices:
          pickerMode === "unavailable"
            ? {}
            : {
                fileAttachments: {
                  async pickFiles(input: unknown) {
                    document.body.dataset.folderPickerCall = JSON.stringify(input);
                    if (pickerMode === "error") throw new Error("Native dialog unavailable");
                    if (pickerMode === "delayed")
                      await new Promise((resolve) => setTimeout(resolve, 500));
                    document.body.dataset.folderPickerReturned = "true";
                    if (pickerMode === "cancel") return [];
                    return ["shared-ui", "docs", "shared-ui"].map((name) => ({
                      fsPath: `${prefix}/Projects/${name}`,
                      path: `${prefix}/Projects/${name}/`,
                      label: name,
                    }));
                  },
                },
              },
      })),
    async load() {
      if (scenario === "thread-folders-loading") await new Promise(() => {});
      if (scenario === "thread-folders-error") throw new Error("Connection lost");
      return {
        folders,
        projectFolders: scenario === "thread-folders-empty" ? [] : [project],
        recent,
        remote,
        existing,
        machine: remote ? "开发机 · Ubuntu" : "本机 · Mac",
        additionalDirectories: scenario !== "thread-folders-limited",
      };
    },
    async save(selected) {
      if (scenario === "thread-folders-save-error") throw new Error("Connection lost");
      folders = selected;
      document.body.dataset.folderSelection = JSON.stringify(selected);
      if (existing) {
        updateThreadFoldersNote(note, selected);
        note.hidden = false;
      }
    },
    async list(path) {
      const base = path.replace(/\/+$/u, "");
      if (base === `${prefix}/Projects`)
        return [
          project,
          `${prefix}/Projects/shared-ui`,
          `${prefix}/Projects/docs`,
          `${prefix}/Projects/sandbox`,
          `${prefix}/Projects/workbench`,
        ];
      if (base === `${project}/packages`)
        return [
          "adapters",
          "console-server",
          "desktop-control",
          "harness-adapter",
          "harness-broker",
          "harness-discovery",
          "harness-plugin-files",
          "host-runtime",
          "mapping-store",
          "protocol-core",
          "renderer-extension",
          "shared-contracts",
          "update-manager",
        ].map((name) => `${base}/${name}`);
      if (base === project) return [`${project}/packages`, `${project}/docs`];
      return [`${base}/frontend`, `${base}/backend`, `${base}/shared`];
    },
    async validate(path) {
      if (!path.startsWith("/")) throw new Error("请输入绝对路径");
    },
  });
  above.append(control.root);
  control.updateChip(folders, scenario !== "thread-folders-limited");
}
