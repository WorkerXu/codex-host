import { required } from "./skills-dialog.js";
import type {
  SkillMachine,
  SkillSyncPlan,
  SkillsHubRequest,
  SkillLinkPlan,
} from "@codexhost/shared-contracts";
import { skillsErrorText, type RendererSkillsClient } from "../renderer-skills-client.js";
import type { RendererSettingsPageDefinition } from "./core.js";
import { skillsDialog, skillButton, skillNode } from "./skills-dialog.js";
export interface RendererSkillsSettingsOptions {
  createClient(): RendererSkillsClient | null;
}
type SyncRequest = Extract<
  SkillsHubRequest,
  {
    op: "sync-plan";
  }
>;
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
      const head = skillNode(document, "div", "", "skills-head");
      head.append(skillNode(document, "h1", "技能"));
      const notice = skillNode(document, "div", "", "skills-notice");
      notice.setAttribute("role", "status");
      const matrix = skillNode(document, "div", "", "skills-matrix");
      const agents = skillNode(document, "div", "", "skills-machines");
      const client = options.createClient();
      let machines: SkillMachine[] = [],
        busy = false;
      const progress = new Map<string, string>();
      const changes = new Map<string, string[]>();
      const button = (label: string, action: () => void, primary = false) =>
        skillButton(document, label, action, primary);
      const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") =>
        skillNode(document, tag, text, className);
      const machineName = (id: string) => machines.find((m) => m.hostId === id)?.name ?? id;
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
        machines = await client.status();
        if (!context.signal.aborted) render();
      }
      const refresh = button("刷新", () => void perform(load, () => {}));
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
      head.append(refresh, fill);
      root.append(head, notice, matrix, agents);
      context.content.append(root);
      function render(): void {
        matrix.replaceChildren();
        agents.replaceChildren();
        const keys = [
          ...new Set(machines.flatMap((m) => m.inventory?.skills.map((s) => s.key) ?? [])),
        ].sort();
        fill.disabled = machines.filter((m) => m.inventory).length < 2;
        if (!keys.length) matrix.append(node("p", "中央库中还没有技能", "skills-empty"));
        else {
          const table = node("table");
          const header = node("tr");
          header.append(node("th", "技能"));
          for (const machine of machines) header.append(node("th", machine.name));
          header.append(node("th", ""));
          const thead = node("thead");
          thead.append(header);
          table.append(thead);
          const body = node("tbody");
          for (const key of keys) {
            const entries = machines.flatMap(
              (m) => m.inventory?.skills.filter((s) => s.key === key) ?? [],
            );
            const different = new Set(entries.map((s) => s.fingerprint)).size > 1;
            const row = node("tr");
            const name = node("td");
            name.append(node("strong", key));
            const description = node("span", entries[0]?.description ?? "", "skills-description");
            description.title = description.textContent ?? "";
            name.append(description);
            row.append(name);
            for (const machine of machines) {
              const entry = machine.inventory?.skills.find((s) => s.key === key);
              const cell = node("td");
              const status = node(
                "span",
                !machine.inventory
                  ? skillsErrorText(machine.error)
                  : !entry
                    ? "缺失"
                    : different
                      ? "版本不同"
                      : "一致",
                entry && different ? "skills-different" : !entry ? "skills-muted" : "",
              );
              if (entry)
                status.title = `${entry.version ?? ""} · ${new Date(entry.modifiedAt).toLocaleString("zh-CN")} · ${entry.fingerprint.slice(0, 12)}`;
              cell.append(status);
              row.append(cell);
            }
            const action = node("td");
            action.append(button("同步…", () => syncSelection(key)));
            row.append(action);
            body.append(row);
          }
          table.append(body);
          matrix.append(table);
        }
        for (const machine of machines) {
          const section = node("section", "", "skills-machine");
          const heading = node("div", "", "skills-head");
          heading.append(node("h2", machine.name));
          const state = node(
            "span",
            progress.get(machine.hostId) ??
              (machine.inventory ? "" : skillsErrorText(machine.error)),
            "skills-muted",
          );
          state.setAttribute("role", "status");
          heading.append(state);
          if (machine.inventory) {
            heading.append(
              button("推送中央库…", () => syncSelection("--all", machine.hostId)),
              button("一键链接", () => void linkPreview(machine.hostId)),
            );
            const history = changes.get(machine.hostId) ?? [];
            if (history.length)
              heading.append(
                button("撤销上次更改", () => confirmUndo(machine.hostId, required(history.at(-1)))),
              );
          } else heading.append(button("重试", () => void perform(load, () => {})));
          section.append(heading);
          if (machine.inventory) {
            const table = node("table");
            const tbody = node("tbody");
            for (const agent of machine.inventory.agents) {
              const row = node("tr");
              const name = node("td", agent.name);
              name.title = agent.evidence;
              row.append(
                name,
                node(
                  "td",
                  agent.skillsDir.replace(/^.*(?=\/\.[^/]+\/skills$)/u, "~"),
                  "skills-path",
                ),
                node(
                  "td",
                  agent.native === true ? "原生支持" : agent.native === false ? "需链接" : "待核实",
                ),
              );
              row.append(
                node(
                  "td",
                  agent.excluded
                    ? "已排除"
                    : agent.native
                      ? "直接读取中央库"
                      : `${agent.linked} 已链接 · ${agent.missing} 待链接${agent.conflicts ? ` · ${agent.conflicts} 冲突` : ""}${agent.managed ? ` · ${agent.managed} 自动管理` : ""}`,
                  "skills-muted",
                ),
              );
              tbody.append(row);
            }
            if (!machine.inventory.agents.length) tbody.append(node("tr", "未发现智能体"));
            table.append(tbody);
            section.append(table);
            const exclusions = node("div", "", "skills-exclusions");
            exclusions.append(
              node(
                "span",
                `排除：${machine.inventory.exclusions.join("、") || "无"}`,
                "skills-muted",
              ),
              button("编辑", () => editExclusions(machine)),
            );
            section.append(exclusions);
            if (machine.inventory.warnings.length)
              section.append(
                node(
                  "p",
                  `${machine.inventory.warnings.length} 个技能或目录无法读取，请检查文件与权限`,
                  "skills-muted",
                ),
              );
          }
          agents.append(section);
        }
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
      function editExclusions(machine: SkillMachine): void {
        const dialog = skillsDialog(root, "排除的智能体");
        const input = node("textarea");
        input.value = required(machine.inventory).exclusions.join("\n");
        input.setAttribute("aria-label", "智能体标识，每行一个");
        dialog.body.append(node("p", "每行一个智能体标识；排除后不会创建链接。"), input);
        dialog.footer.append(
          button("取消", dialog.close),
          button(
            "保存",
            () =>
              void perform(
                () =>
                  required(client).exclusions(
                    machine.hostId,
                    input.value.split(/[\s,，]+/u).filter(Boolean),
                  ),
                async () => {
                  dialog.close();
                  await load();
                },
              ),
            true,
          ),
        );
        input.focus();
      }
      function syncSelection(skill: string, fixedSource?: string): void {
        const dialog = skillsDialog(
          root,
          fixedSource ? `推送 ${machineName(fixedSource)} 的中央库` : `同步 ${skill}`,
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
        const label = node("label", "来源机器");
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
        const error = node("p", "", "skills-muted");
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
          const dialog = skillsDialog(root, "选择保留的版本");
          const choices: Record<string, string> = { ...input.choices };
          let continueButton: HTMLButtonElement | null = null;
          for (const conflict of plan.conflicts) {
            dialog.body.append(node("h3", conflict.skill));
            for (const version of conflict.versions) {
              const label = node("label", "", "skills-version");
              const radio = node("input");
              radio.type = "radio";
              radio.name = conflict.skill;
              radio.value = version.hostId;
              radio.addEventListener("change", () => {
                choices[conflict.skill] = version.hostId;
                if (continueButton)
                  continueButton.disabled = plan.conflicts.some((entry) => !choices[entry.skill]);
              });
              const detail = node("div");
              detail.append(
                node("strong", version.name),
                node(
                  "span",
                  `${new Date(version.entry.modifiedAt).toLocaleString("zh-CN")} · ${version.entry.fingerprint.slice(0, 12)}`,
                  "skills-description",
                ),
                node(
                  "span",
                  version.entry.files.map((f) => f.path).join("、"),
                  "skills-description",
                ),
              );
              label.append(radio, detail);
              dialog.body.append(label);
            }
            const diff = node("pre", conflict.diff, "skills-diff");
            diff.setAttribute("aria-label", `${conflict.skill} 差异`);
            dialog.body.append(diff);
          }
          const next = button(
            "继续预览",
            () => {
              if (plan.conflicts.some((c) => !choices[c.skill])) return;
              dialog.close();
              void previewSync({ ...input, choices, basedOn: plan.id });
            },
            true,
          );
          continueButton = next;
          next.disabled = true;
          dialog.footer.append(button("取消", dialog.close), next);
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
                  row.append(
                    node("span", `${machineName(host)} · ${progress.get(host)}`),
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
        adopt: {
          agentId: string;
          skill: string;
        }[] = [],
      ): Promise<void> {
        await perform(
          () => required(client).linkPlan(hostId, adopt),
          (plan) => showLinks(plan, adopt),
        );
      }
      function showLinks(
        plan: SkillLinkPlan,
        adopt: {
          agentId: string;
          skill: string;
        }[],
      ): void {
        const dialog = skillsDialog(root, `${machineName(plan.hostId)} · 链接预览`);
        dialog.body.append(node("p", "现有文件会保留；收进中央库的目录会移动并留下链接，可撤销。"));
        for (const action of plan.actions) {
          const row = node("div", "", "skills-link-row");
          row.append(
            node("strong", action.skill),
            node("span", action.agentId, "skills-muted"),
            node(
              "span",
              {
                link: "创建链接",
                "remove-dangling": "清理失效链接",
                conflict: "现有文件冲突",
                adopt: "收进中央库并替换同名版本",
              }[action.kind],
            ),
          );
          if (action.kind === "conflict" && action.fingerprint)
            row.append(
              button("收进中央库", () => {
                const confirm = skillsDialog(root, "收进中央库");
                confirm.body.append(
                  node(
                    "p",
                    `将 ${action.agentId} 的 ${action.skill} 移入中央库，同名中央版本会备份。请确认保留这个版本。`,
                  ),
                );
                confirm.footer.append(
                  button("取消", confirm.close),
                  button(
                    "保留此版本并预览",
                    () => {
                      confirm.close();
                      dialog.close();
                      void linkPreview(plan.hostId, [
                        ...adopt,
                        { agentId: action.agentId, skill: action.skill },
                      ]);
                    },
                    true,
                  ),
                );
              }),
            );
          dialog.body.append(row);
        }
        if (!plan.actions.length) dialog.body.append(node("p", "链接已就绪，无需更改。"));
        const apply = button(
          "应用链接",
          () => {
            dialog.close();
            progress.set(plan.hostId, "正在链接…");
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
          true,
        );
        apply.disabled = !plan.actions.some((a) => a.kind !== "conflict");
        dialog.footer.append(button("取消", dialog.close), apply);
      }
      matrix.append(node("div", "", "skills-skeleton"));
      if (client) void perform(load, () => {});
      else {
        matrix.replaceChildren();
        notice.textContent = "连接失败";
      }
      return () => {
        root.querySelectorAll("dialog").forEach((dialog) => {
          dialog.close();
          dialog.remove();
        });
        root.remove();
      };
    },
  });
}
