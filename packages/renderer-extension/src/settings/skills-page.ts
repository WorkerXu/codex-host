import { skillsNativeTokens } from "./skills-style.js";
import { renderSkillsInventory } from "./skills-inventory-view.js";
import { showSkillConflicts } from "./skills-conflicts.js";
import { showSkillLinks } from "./skills-link-preview.js";
import { editSkillExclusions } from "./skills-exclusions.js";
import { createRendererSettingsIcon } from "./icons.js";
import { required } from "./skills-dialog.js";
import type {
  SkillMachine,
  SkillSyncPlan,
  SkillsHubRequest,
  SkillLinkPlan,
} from "@codexhost/shared-contracts";
import {
  skillsErrorText,
  type RendererLinkPlanOptions,
  type RendererSkillsClient,
} from "../renderer-skills-client.js";
import type { RendererSettingsPageDefinition } from "./core.js";
import { skillsDialog, skillButton, skillNode } from "./skills-dialog.js";
export interface RendererSkillsSettingsOptions {
  createClient(): RendererSkillsClient | null;
  resolveMachineName?(hostId: string): Promise<string | undefined>;
}
type SyncRequest = Extract<
  SkillsHubRequest,
  {
    op: "sync-plan";
  }
>;
/** The last inventory paints before the Host's cached status answers. */
let cachedMachines: SkillMachine[] | null = null;
export function createSkillsSettingsPage(
  options: RendererSkillsSettingsOptions,
): RendererSettingsPageDefinition {
  return Object.freeze<RendererSettingsPageDefinition>({
    id: "skills",
    label: "技能",
    icon: "session-import",
    mount(context) {
      const document = context.content.ownerDocument;
      const root = skillNode(document, "div", "", "skills-hub");
      for (const [name, value] of Object.entries(skillsNativeTokens))
        root.style.setProperty(name, value);
      const head = skillNode(document, "div", "", "skills-head");
      head.append(skillNode(document, "h1", "技能"));
      const notice = skillNode(document, "div", "", "skills-notice");
      notice.setAttribute("role", "status");
      const matrix = skillNode(document, "div", "", "skills-view");
      const undoBar = skillNode(document, "div", "", "skills-undo");
      const client = options.createClient();
      let machines: SkillMachine[] = [],
        busy = false;
      let tab: "library" | "agents" = "library";
      let search = "";
      let linkFilter: "all" | "linked" | "unlinked" = "all";
      let machineFilter = "";
      let layout: "grid" | "list" = "grid";
      let openAgent: { hostId: string; agentId: string } | null = null;
      const progress = new Map<string, string>();
      const changes = new Map<string, string[]>();
      const button = (label: string, action: () => void, primary = false) =>
        skillButton(document, label, action, primary);
      const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") =>
        skillNode(document, tag, text, className);
      const machineName = (id: string, fallback = id) =>
        machines.find((m) => m.hostId === id)?.name ?? fallback;
      const remember = (hostId: string, id: string) =>
        changes.set(hostId, [...(changes.get(hostId) ?? []), id]);
      async function perform<T>(
        operation: () => Promise<T>,
        success: (result: T) => void | Promise<void>,
      ): Promise<void> {
        if (busy || !client) return;
        busy = true;
        root.setAttribute("aria-busy", "true");
        try {
          const result = await operation();
          if (!context.signal.aborted) await success(result);
        } catch (error) {
          if (!context.signal.aborted) {
            const message = skillsErrorText(error);
            notice.textContent = message;
            for (const [hostId, state] of progress)
              if (state.startsWith("正在")) progress.set(hostId, message);
            if (machines.length) render();
            else matrix.replaceChildren();
          }
        } finally {
          busy = false;
          root.removeAttribute("aria-busy");
        }
      }
      async function load(): Promise<void> {
        if (!client) {
          notice.textContent = "连接失败";
          return;
        }
        machines = await Promise.all(
          (await client.status()).map(async (machine) => ({
            ...machine,
            name:
              (await options.resolveMachineName?.(machine.hostId).catch(() => undefined)) ??
              machine.name,
          })),
        );
        cachedMachines = machines;
        progress.clear();
        if (!context.signal.aborted) render();
      }
      const refresh = button("", () => void perform(load, () => {}));
      refresh.setAttribute("aria-label", "刷新");
      refresh.dataset.skillsRefresh = "true";
      refresh.append(createRendererSettingsIcon("refresh", 14));
      const refreshWrap = node("span", "", "group relative inline-flex");
      const refreshTip = node(
        "span",
        "刷新",
        "pointer-events-none invisible absolute top-full right-0 z-20 mt-2 rounded-md border border-settings-border bg-settings-panel px-2 py-1 text-xs whitespace-nowrap text-settings-text shadow-sm group-hover:visible group-focus-within:visible",
      );
      refreshTip.setAttribute("role", "tooltip");
      refreshTip.id = "skills-refresh-tooltip";
      refresh.setAttribute("aria-describedby", refreshTip.id);
      refreshWrap.addEventListener("pointerenter", () => {
        refreshTip.hidden = false;
      });
      refreshWrap.addEventListener("focusin", () => {
        refreshTip.hidden = false;
      });
      const dismissTooltip = (event: KeyboardEvent) => {
        if (
          event.key === "Escape" &&
          !refreshTip.hidden &&
          refreshWrap.matches(":hover, :focus-within") &&
          refreshWrap.getClientRects().length
        ) {
          event.preventDefault();
          refreshTip.hidden = true;
        }
      };
      document.defaultView?.addEventListener("keydown", dismissTooltip, true);
      refreshWrap.append(refresh, refreshTip);
      const fill = button(
        "全部补齐",
        () =>
          void previewSync({
            op: "sync-plan",
            mode: "fill",
            skill: "--all",
            to: machines.filter((m) => m.inventory).map((m) => m.hostId),
          }),
        true,
      );
      head.append(refreshWrap, fill);
      root.append(head, notice, undoBar, matrix);
      context.content.append(root);
      function render(): void {
        fill.disabled = machines.filter((machine) => machine.inventory).length < 2;
        undoBar.replaceChildren();
        for (const [hostId, ids] of changes) {
          const id = ids.at(-1);
          if (!id) continue;
          const label = machineName(hostId);
          undoBar.append(
            node("span", `${label} 已更新`, "skills-muted"),
            button("撤销", () => confirmUndo(hostId, id)),
          );
        }
        undoBar.hidden = !undoBar.childElementCount;
        renderSkillsInventory({
          container: matrix,
          machines,
          progress,
          state: {
            tab,
            search,
            link: linkFilter,
            machine: machineFilter,
            layout,
            agent: openAgent,
          },
          onState(patch) {
            if (patch.tab !== undefined) {
              tab = patch.tab;
              openAgent = null;
            }
            if (patch.search !== undefined) search = patch.search;
            if (patch.link !== undefined) linkFilter = patch.link;
            if (patch.machine !== undefined) machineFilter = patch.machine;
            if (patch.layout !== undefined) layout = patch.layout;
            if (patch.agent !== undefined) openAgent = patch.agent;
            render();
          },
          sync: syncSelection,
          linkAll: (hostId) => void linkPreview(hostId),
          toggle: (hostId, agentId, skill, linked) =>
            void linkPreview(
              hostId,
              linked
                ? { unlink: [{ agentId, skill }], scope: { agentId, skill } }
                : { scope: { agentId, skill } },
            ),
          refresh: () => void perform(load, () => {}),
          editExclusions: () =>
            editSkillExclusions({
              root,
              machines,
              save: (hostId, ids, close) =>
                void perform(
                  () => required(client).exclusions(hostId, ids),
                  async () => {
                    close();
                    await load();
                  },
                ),
            }),
        });
      }
      function confirmUndo(hostId: string, id: string): void {
        const dialog = skillsDialog(root, "撤销更改");
        dialog.body.append(node("p", "恢复本批更改前的内容；已被修改的文件会保留并提示冲突。"));
        dialog.footer.append(
          button("取消", dialog.close),
          button(
            "撤销",
            () =>
              void perform(
                () => required(client).undo(hostId, id),
                async () => {
                  changes.get(hostId)?.pop();
                  dialog.close();
                  await load();
                },
              ),
            true,
          ),
        );
      }
      function syncSelection(skill: string, fixedSource?: string): void {
        const dialog = skillsDialog(
          root,
          fixedSource ? `从 ${machineName(fixedSource)} 同步到其他机器` : `同步 ${skill}`,
        );
        const source = node("select");
        source.setAttribute("aria-label", "来源机器");
        for (const machine of machines.filter(
          (m) =>
            m.inventory && (skill === "--all" || m.inventory.skills.some((s) => s.key === skill)),
        )) {
          const option = node("option", machine.name);
          option.value = machine.hostId;
          source.append(option);
        }
        if (fixedSource) {
          source.value = fixedSource;
          source.disabled = true;
        }
        const label = node("label", "来源机器", "skills-field");
        label.append(source);
        dialog.body.append(label, node("p", "同步到"));
        const targets: {
          hostId: string;
          input: HTMLInputElement;
        }[] = [];
        for (const machine of machines.filter((m) => m.inventory)) {
          const input = node("input");
          input.type = "checkbox";
          input.checked = machine.hostId !== source.value;
          const label = node("label", "", "skills-target");
          label.append(input, document.createTextNode(machine.name));
          dialog.body.append(label);
          targets.push({ hostId: machine.hostId, input });
        }
        source.addEventListener("change", () => {
          for (const target of targets) target.input.checked = target.hostId !== source.value;
        });
        const error = node("p", "", "skills-muted empty:hidden");
        dialog.body.append(error);
        dialog.footer.append(
          button("取消", dialog.close),
          button(
            "预览",
            () => {
              const to = targets.filter((t) => t.input.checked).map((t) => t.hostId);
              if (!to.length) {
                error.textContent = "请选择目标机器";
                return;
              }
              dialog.close();
              void previewSync({
                op: "sync-plan",
                mode: "sync",
                skill,
                sourceHost: source.value,
                to,
              });
            },
            true,
          ),
        );
      }
      async function previewSync(input: SyncRequest): Promise<void> {
        await perform(
          () => required(client).syncPlan(input),
          (plan) => showSync(plan, input),
        );
      }
      function showSync(plan: SkillSyncPlan, input: SyncRequest): void {
        if (plan.conflicts.length) {
          showSkillConflicts({
            root,
            plan: {
              ...plan,
              conflicts: plan.conflicts.map((conflict) => ({
                ...conflict,
                versions: conflict.versions.map((version) => ({
                  ...version,
                  name: machineName(version.hostId, version.name),
                })),
              })),
            },
            choices: input.choices,
            continueWith: (choices) => void previewSync({ ...input, choices, basedOn: plan.id }),
          });
          return;
        }
        const dialog = skillsDialog(root, "同步预览");
        if (!plan.actions.length) dialog.body.append(node("p", "所有目标机器已一致，无需同步。"));
        for (const action of plan.actions)
          dialog.body.append(
            node(
              "p",
              `${action.skill}：${machineName(action.sourceHost)} → ${machineName(action.targetHost)}${action.expected ? " · 替换已确认的版本" : " · 补齐缺失"}`,
            ),
          );
        const apply = button(
          "开始同步",
          () => {
            dialog.close();
            for (const action of plan.actions) progress.set(action.targetHost, "正在同步…");
            render();
            void perform(
              () => required(client).syncApply(plan.id),
              async (result) => {
                const hosts = new Set(result.results.map((r) => r.hostId));
                for (const host of hosts) {
                  const rows = result.results.filter((r) => r.hostId === host);
                  progress.set(
                    host,
                    rows.some((r) => r.error)
                      ? skillsErrorText(required(rows.find((r) => r.error)).error)
                      : "同步完成",
                  );
                  for (const row of rows) if (row.id) remember(host, row.id);
                }
                await load();
                const done = skillsDialog(root, "同步完成");
                for (const host of hosts) {
                  const row = node("div", "", "skills-head");
                  row.append(node("span", `${machineName(host)} · ${progress.get(host)}`));
                  if (machines.find((machine) => machine.hostId === host)?.inventory?.agents.length)
                    row.append(
                      button("一键链接", () => {
                        done.close();
                        void linkPreview(host);
                      }),
                    );
                  done.body.append(row);
                }
                done.footer.append(button("完成", done.close, true));
              },
            );
          },
          true,
        );
        apply.disabled = !plan.actions.length;
        dialog.footer.append(button("取消", dialog.close), apply);
      }
      async function linkPreview(
        hostId: string,
        planOptions: RendererLinkPlanOptions = {},
        focus?: string,
      ): Promise<void> {
        await perform(
          () => required(client).linkPlan(hostId, planOptions),
          (plan) => showLinks(plan, planOptions, focus),
        );
      }
      function showLinks(
        plan: SkillLinkPlan,
        planOptions: RendererLinkPlanOptions,
        focus?: string,
      ): void {
        showSkillLinks({
          root,
          machines,
          plan,
          adopt: planOptions.adopt ?? [],
          focus,
          replan: (selected, focus) =>
            void linkPreview(plan.hostId, { ...planOptions, adopt: selected }, focus),
          apply: () => {
            const unlinking = plan.actions.some((action) => action.kind === "unlink");
            progress.set(plan.hostId, unlinking ? "正在解除链接…" : "正在链接…");
            render();
            void perform(
              () => required(client).linkApply(plan.hostId, plan.id),
              async (result) => {
                remember(plan.hostId, result.id);
                progress.set(plan.hostId, `已完成 ${result.changed} 项更改`);
                await load();
              },
            );
          },
        });
      }
      matrix.append(node("div", "", "skills-skeleton"));
      if (client && cachedMachines) {
        machines = cachedMachines;
        render();
        void perform(load, () => {});
      } else if (client) void perform(load, () => {});
      else {
        matrix.replaceChildren();
        notice.textContent = "连接失败";
      }
      return () => {
        document.defaultView?.removeEventListener("keydown", dismissTooltip, true);
        root.querySelectorAll("dialog").forEach((dialog) => {
          dialog.close();
          dialog.remove();
        });
        root.remove();
      };
    },
  });
}
