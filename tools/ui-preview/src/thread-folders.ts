import { createThreadFoldersControl } from "../../../packages/renderer-extension/src/renderer-thread-folders-control.js";

/** The production control, with deterministic filesystem and Host replies for pointer/keyboard review. */
export function mountThreadFoldersPreview(root: HTMLElement, scenario: string) {
  const remote = scenario === "thread-folders-remote";
  const existing = scenario === "thread-folders-existing";
  const prefix = remote ? "/home/ubuntu" : "/Users/lin";
  const project = `${prefix}/Projects/codexhost`;
  let folders = [project];
  const recent = [`${prefix}/Projects/shared-ui`, `${prefix}/Projects/docs`];
  const stage = document.createElement("div");
  stage.className = "preview-stage";
  stage.innerHTML = `<aside class="preview-projects"><div class="preview-projects-heading">项目</div><div class="preview-project-row">codexhost</div><div class="preview-project-row">shared-ui</div></aside><main class="preview-canvas"><article class="preview-thread" style="width:min(760px,100%);align-self:stretch;display:flex;flex-direction:column;justify-content:flex-end"><h1>${existing ? "继续梳理组件结构" : "开始新对话"}</h1><p>${existing ? "已经整理好基础组件，下一步检查共享目录。" : "选择工作文件夹，让这次对话从合适的位置开始。"}</p><div data-preview-folder-notes></div><div data-preview-folder-toolbar style="display:flex;gap:6px;align-items:center;margin-top:30px;margin-bottom:8px"><span style="font-size:12px;color:var(--color-token-text-secondary);padding:0 8px">${remote ? "开发机" : "本机"} · codexhost</span></div><div class="preview-composer" contenteditable="true" role="textbox" aria-label="消息" style="min-height:85px;margin:0">${existing ? "接着检查共享组件…" : "输入消息…"}</div><div style="font-size:12px;text-align:right;padding:12px;color:var(--color-token-text-secondary)">${scenario === "thread-folders-limited" ? "Example Harness" : "Codex"} ⌄ &nbsp; ↑</div></article></main>`;
  root.append(stage);
  const control = createThreadFoldersControl({
    document,
    async load() {
      return {
        folders,
        projectFolders: [project],
        recent,
        remote,
        existing,
        machine: remote ? "开发机 · Ubuntu" : "本机 · Mac",
        additionalDirectories: scenario !== "thread-folders-limited",
      };
    },
    async save(selected) {
      folders = selected;
      document.body.dataset.folderSelection = JSON.stringify(selected);
      if (existing) {
        const note = stage.querySelector<HTMLElement>("[data-preview-folder-notes]")!;
        note.className = "codexhost-folders-note";
        note.setAttribute("role", "status");
        note.textContent = `工作文件夹已改为 ${selected.join("、")}（主要：${selected[0]}）`;
      }
    },
    async list(path) {
      const base = path.replace(/\/+$/u, "");
      if (base === `${prefix}/Projects`) return [project, ...recent, `${prefix}/Projects/sandbox`];
      if (base === project) return [`${project}/packages`, `${project}/docs`];
      return [`${base}/frontend`, `${base}/backend`, `${base}/shared`];
    },
    async validate(path) {
      if (!path.startsWith("/")) throw new Error("请输入绝对路径");
    },
  });
  stage.querySelector("[data-preview-folder-toolbar]")!.append(control.root);
  control.updateChip(folders, scenario !== "thread-folders-limited");
}
