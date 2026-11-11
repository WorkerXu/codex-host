import type {
  DesktopProjectsCatalog,
  ProjectGroup,
  ProjectGroupMember,
} from "@codexhost/shared-contracts";

export interface ProjectGroupsDialogSaveResult {
  ok: boolean;
  conflict?: boolean;
  message?: string;
}

export interface ProjectGroupsDialogOptions {
  document: Document;
  window: Window;
  catalog(): DesktopProjectsCatalog | null;
  groups(): readonly ProjectGroup[];
  save(groups: readonly ProjectGroup[]): Promise<ProjectGroupsDialogSaveResult>;
  onClosed?(): void;
}

function style(element: HTMLElement, values: Record<string, string>): void {
  for (const [property, value] of Object.entries(values))
    element.style.setProperty(property, value);
}

function button(document: Document, text: string, primary = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  style(element, {
    border: primary ? "0" : "1px solid var(--color-border, #d0d0d0)",
    background: primary ? "var(--color-accent, #2f6feb)" : "transparent",
    color: primary ? "#fff" : "var(--color-text, inherit)",
    "border-radius": "7px",
    padding: "6px 12px",
    cursor: "pointer",
    "font-size": "13px",
  });
  return element;
}

export function projectGroupMemberFromProject(
  projectId: string,
  catalog: DesktopProjectsCatalog,
): ProjectGroupMember | null {
  const local = catalog.localProjects[projectId];
  if (local && local.rootPaths.length > 0)
    return {
      projectKind: "local",
      projectId,
      rootPaths: local.rootPaths,
      label: local.name,
    };
  const remote = catalog.remoteProjects.find(({ id }) => id === projectId);
  return remote
    ? {
        projectKind: "remote",
        projectId,
        hostId: remote.hostId,
        remotePath: remote.remotePath,
        label: remote.label,
      }
    : null;
}

export function projectGroupProjectLabel(
  projectId: string,
  catalog: DesktopProjectsCatalog,
): string {
  return (
    catalog.localProjects[projectId]?.name ??
    catalog.remoteProjects.find(({ id }) => id === projectId)?.label ??
    projectId
  );
}

export function projectGroupProjectHost(
  projectId: string,
  catalog: DesktopProjectsCatalog,
): string {
  if (catalog.localProjects[projectId]) return "本机";
  const remote = catalog.remoteProjects.find(({ id }) => id === projectId);
  if (!remote) return "其他";
  return (
    catalog.codexManagedRemoteConnections.find(({ hostId }) => hostId === remote.hostId)
      ?.displayName ?? remote.hostId
  );
}

export class ProjectGroupsDialog {
  readonly #document: Document;
  readonly #window: Window;
  readonly #options: ProjectGroupsDialogOptions;
  #overlay: HTMLElement | null = null;
  #editingId: string | null = null;
  #name = "";
  #members: ProjectGroupMember[] = [];
  #deleteArmed = false;
  #saving = false;

  constructor(options: ProjectGroupsDialogOptions) {
    this.#document = options.document;
    this.#window = options.window;
    this.#options = options;
  }

  open(groupId?: string): void {
    this.close();
    const groups = this.#options.groups();
    const existing = groupId ? groups.find(({ id }) => id === groupId) : undefined;
    this.#editingId = existing?.id ?? null;
    this.#name = existing?.name ?? "";
    this.#members = existing ? existing.members.map((member) => ({ ...member })) : [];
    this.#deleteArmed = false;
    this.#render(true);
  }

  close(): void {
    if (!this.#overlay) return;
    this.#overlay.remove();
    this.#overlay = null;
    this.#options.onClosed?.();
  }

  #render(focusName = false): void {
    this.#overlay?.remove();
    this.#overlay = null;
    const catalog = this.#options.catalog();
    const overlay = this.#document.createElement("div");
    overlay.setAttribute("data-codexhost-project-groups-dialog", "");
    style(overlay, {
      position: "fixed",
      inset: "0",
      "z-index": "2147483000",
      background: "rgba(0, 0, 0, 0.35)",
      display: "flex",
      "align-items": "center",
      "justify-content": "center",
      padding: "24px",
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) this.close();
    });

    const panel = this.#document.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "项目组管理");
    style(panel, {
      width: "560px",
      "max-width": "100%",
      "max-height": "82vh",
      overflow: "auto",
      background: "var(--color-surface, #fff)",
      color: "var(--color-text, #111)",
      "border-radius": "12px",
      "box-shadow": "0 18px 60px rgba(0,0,0,0.28)",
      padding: "18px",
      display: "flex",
      "flex-direction": "column",
      gap: "14px",
      "font-size": "13px",
    });

    const header = this.#document.createElement("div");
    style(header, {
      display: "flex",
      "align-items": "center",
      "justify-content": "space-between",
      gap: "12px",
    });
    const title = this.#document.createElement("div");
    title.textContent = this.#editingId ? "编辑项目组" : "新建项目组";
    style(title, { "font-size": "16px", "font-weight": "600" });
    const close = button(this.#document, "关闭");
    close.addEventListener("click", () => this.close());
    header.append(title, close);

    const nameLabel = this.#document.createElement("label");
    nameLabel.textContent = "组名称";
    style(nameLabel, { display: "flex", "flex-direction": "column", gap: "6px" });
    const nameInput = this.#document.createElement("input");
    nameInput.value = this.#name;
    nameInput.placeholder = "例如：跨机前端";
    nameInput.setAttribute("aria-label", "项目组名称");
    style(nameInput, {
      border: "1px solid var(--color-border, #d0d0d0)",
      "border-radius": "7px",
      padding: "7px 9px",
      background: "transparent",
      color: "inherit",
      "font-size": "13px",
    });
    nameInput.addEventListener("input", () => {
      this.#name = nameInput.value;
    });
    nameLabel.append(nameInput);

    const memberSection = this.#document.createElement("div");
    style(memberSection, { display: "flex", "flex-direction": "column", gap: "8px" });
    const memberTitle = this.#document.createElement("div");
    memberTitle.textContent = `成员项目（${this.#members.length}）`;
    style(memberTitle, { "font-weight": "600" });
    memberSection.append(memberTitle);

    if (this.#members.length === 0) {
      const empty = this.#document.createElement("div");
      empty.textContent = "还没有成员项目，请在下方添加。";
      style(empty, { color: "var(--color-text-secondary, #777)" });
      memberSection.append(empty);
    }
    for (const member of this.#members) {
      const row = this.#document.createElement("div");
      style(row, {
        display: "flex",
        "align-items": "center",
        gap: "8px",
        padding: "6px 8px",
        "border-radius": "7px",
        background: "var(--color-surface-secondary, rgba(127,127,127,0.08))",
      });
      const label = this.#document.createElement("span");
      label.textContent = `${member.label} · ${catalog ? projectGroupProjectHost(member.projectId, catalog) : member.projectKind === "local" ? "本机" : member.hostId}`;
      style(label, { flex: "1 1 auto", "min-width": "0" });
      const remove = button(this.#document, "移除");
      remove.addEventListener("click", () => {
        this.#members = this.#members.filter(
          (candidate) =>
            !(
              candidate.projectKind === member.projectKind &&
              candidate.projectId === member.projectId
            ),
        );
        this.#render();
      });
      row.append(label, remove);
      memberSection.append(row);
    }

    const addSection = this.#document.createElement("div");
    style(addSection, { display: "flex", "flex-direction": "column", gap: "6px" });
    const addTitle = this.#document.createElement("div");
    addTitle.textContent = "添加成员";
    style(addTitle, { "font-weight": "600" });
    addSection.append(addTitle);

    if (catalog) {
      const used = new Set(
        this.#options
          .groups()
          .filter(({ id }) => id !== this.#editingId)
          .flatMap((group) => group.members.map((member) => member.projectId)),
      );
      for (const member of this.#members) used.add(member.projectId);
      const projectIds = [
        ...Object.keys(catalog.localProjects),
        ...catalog.remoteProjects.map(({ id }) => id),
      ];
      const available = projectIds.filter((projectId) => !used.has(projectId));
      if (available.length === 0) {
        const empty = this.#document.createElement("div");
        empty.textContent = "没有可添加的原生项目。";
        style(empty, { color: "var(--color-text-secondary, #777)" });
        addSection.append(empty);
      }
      const byHost = new Map<string, string[]>();
      for (const projectId of available) {
        const host = projectGroupProjectHost(projectId, catalog);
        const list = byHost.get(host) ?? [];
        list.push(projectId);
        byHost.set(host, list);
      }
      for (const [host, projects] of byHost) {
        const hostLabel = this.#document.createElement("div");
        hostLabel.textContent = host;
        style(hostLabel, {
          color: "var(--color-text-secondary, #777)",
          "font-size": "11px",
          "margin-top": "4px",
        });
        addSection.append(hostLabel);
        for (const projectId of projects) {
          const member = projectGroupMemberFromProject(projectId, catalog);
          if (!member) continue;
          const row = this.#document.createElement("label");
          style(row, {
            display: "flex",
            "align-items": "center",
            gap: "8px",
            padding: "4px 6px",
            cursor: "pointer",
          });
          const checkbox = this.#document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) this.#members = [...this.#members, member];
            else
              this.#members = this.#members.filter(
                (candidate) =>
                  !(
                    candidate.projectKind === member.projectKind &&
                    candidate.projectId === member.projectId
                  ),
              );
            this.#render();
          });
          const label = this.#document.createElement("span");
          label.textContent = projectGroupProjectLabel(projectId, catalog);
          style(label, { flex: "1 1 auto" });
          row.append(checkbox, label);
          addSection.append(row);
        }
      }
    } else {
      const empty = this.#document.createElement("div");
      empty.textContent = "项目目录暂不可用，无法添加成员。";
      style(empty, { color: "var(--color-text-secondary, #777)" });
      addSection.append(empty);
    }

    const footer = this.#document.createElement("div");
    style(footer, {
      display: "flex",
      "align-items": "center",
      "justify-content": "flex-end",
      gap: "8px",
    });
    if (this.#editingId) {
      const remove = button(this.#document, this.#deleteArmed ? "再次点击确认删除" : "删除项目组");
      style(remove, { "margin-right": "auto", color: "var(--color-chart-red, #d33)" });
      remove.addEventListener("click", () => {
        if (!this.#deleteArmed) {
          this.#deleteArmed = true;
          remove.textContent = "再次点击确认删除";
          return;
        }
        void this.#save(this.#options.groups().filter(({ id }) => id !== this.#editingId));
      });
      footer.append(remove);
    }
    const cancel = button(this.#document, "取消");
    cancel.addEventListener("click", () => this.close());
    const save = button(this.#document, "保存", true);
    save.addEventListener("click", () => {
      if (!this.#name.trim() || this.#members.length === 0) {
        this.#showError(panel, "请填写组名称并至少添加一个成员项目。");
        return;
      }
      const now = new Date().toISOString();
      const groups = this.#options.groups();
      const existing = this.#editingId
        ? groups.find(({ id }) => id === this.#editingId)
        : undefined;
      const group: ProjectGroup = {
        id: this.#editingId ?? this.#window.crypto.randomUUID(),
        name: this.#name.trim(),
        order: existing?.order ?? groups.length,
        collapsed: existing?.collapsed ?? false,
        members: this.#members,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      void this.#save(
        this.#editingId
          ? groups.map((candidate) => (candidate.id === this.#editingId ? group : candidate))
          : [...groups, group],
      );
    });
    footer.append(cancel, save);
    panel.append(header, nameLabel, memberSection, addSection, footer);
    overlay.append(panel);
    this.#document.body.append(overlay);
    this.#overlay = overlay;
    if (focusName) nameInput.focus();
  }

  async #save(groups: readonly ProjectGroup[]): Promise<void> {
    if (this.#saving) return;
    this.#saving = true;
    try {
      const result = await this.#options.save(groups);
      if (result.ok) {
        this.close();
        return;
      }
      const panel = this.#overlay?.querySelector<HTMLElement>('[role="dialog"]');
      if (panel) this.#showError(panel, result.message ?? "保存失败");
    } finally {
      this.#saving = false;
    }
  }

  #showError(root: HTMLElement, message: string): void {
    const existing = root.querySelector<HTMLElement>("[data-codexhost-project-groups-error]");
    if (existing) {
      existing.textContent = message;
      return;
    }
    const error = this.#document.createElement("div");
    error.dataset.codexhostProjectGroupsError = "";
    error.textContent = message;
    style(error, { color: "var(--color-chart-red, #d33)", "font-size": "12px" });
    root.append(error);
  }
}
