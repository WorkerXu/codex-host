import type { SkillMachine, SkillSyncPlan } from "@codexhost/shared-contracts";
import type { RendererSkillsClient } from "../../../packages/renderer-extension/src/renderer-skills-client.js";
import { createSkillsSettingsPage } from "../../../packages/renderer-extension/src/settings/skills-page.js";
import { installRendererSettingsShell } from "../../../packages/renderer-extension/src/settings/shell.js";
import { rendererSettingsMessages } from "../../../packages/renderer-extension/src/settings/localization.js";

const uuid = "00000000-0000-4000-8000-000000000001";
function entry(key: string, variant = "a") {
  return {
    key,
    name: key,
    description:
      key === "design-review"
        ? "检查界面的一致性、交互和可访问性"
        : key === "writing-guide"
          ? "统一文档结构、措辞和写作风格"
          : "检索项目资料并整理结果",
    version: variant === "a" ? "1.2" : "1.3",
    fingerprint: variant.repeat(64),
    modifiedAt: variant === "a" ? "2026-11-16T09:30:00Z" : "2026-11-17T02:10:00Z",
    source: key === "writing-guide" ? { source: "mattpocock/skills" } : null,
    skillMd: `---\nname: ${key}\nversion: ${variant === "a" ? "1.2" : "1.3"}\n---\n${variant === "a" ? "检查颜色、间距和键盘交互" : "检查颜色、间距、键盘交互与屏幕阅读器"}`,
    files: [
      { path: "SKILL.md", hash: variant.repeat(64), size: 128, executable: false },
      { path: "references/checklist.md", hash: variant.repeat(64), size: 200, executable: false },
    ],
  };
}
function fakeClient(): RendererSkillsClient {
  const machines: SkillMachine[] = [
    {
      hostId: "local",
      name: "MacBook Pro",
      error: null,
      inventory: {
        skills: [entry("design-review"), entry("project-search"), entry("writing-guide")],
        warnings: [],
        exclusions: ["github-copilot", "qoder"],
        agents: [
          {
            id: "codex",
            name: "Codex",
            skillsDir: "~/.codex/skills",
            native: true,
            evidence: "Codex 用户技能目录",
            excluded: false,
            linked: 0,
            conflicts: 0,
            managed: 0,
            missing: 0,
            states: {
              "design-review": "native",
              "project-search": "native",
              "writing-guide": "native",
            },
          },
          {
            id: "claude-code",
            name: "Claude Code",
            skillsDir: "~/.claude/skills",
            native: false,
            evidence: "Claude Code 个人技能目录",
            excluded: false,
            linked: 1,
            conflicts: 1,
            managed: 1,
            missing: 1,
            states: {
              "design-review": "conflict",
              "project-search": "linked",
              "writing-guide": "missing",
            },
          },
          {
            id: "cursor",
            name: "Cursor",
            skillsDir: "~/.cursor/skills",
            native: false,
            evidence: "Cursor 用户技能目录",
            excluded: false,
            linked: 1,
            conflicts: 0,
            managed: 0,
            missing: 2,
            states: {
              "design-review": "missing",
              "project-search": "linked",
              "writing-guide": "missing",
            },
          },
          {
            id: "github-copilot",
            name: "GitHub Copilot",
            skillsDir: "~/.copilot/skills",
            native: false,
            evidence: "GitHub Copilot 用户技能目录",
            excluded: true,
            linked: 0,
            conflicts: 0,
            managed: 0,
            missing: 3,
            states: {
              "design-review": "missing",
              "project-search": "missing",
              "writing-guide": "missing",
            },
          },
        ],
      },
    },
    {
      hostId: "oracle-main",
      name: "oracle-main",
      error: null,
      inventory: {
        skills: [entry("design-review", "b"), entry("project-search")],
        warnings: [],
        exclusions: ["github-copilot", "qoder"],
        agents: [
          {
            id: "codebuddy",
            name: "CodeBuddy",
            skillsDir: "~/.codebuddy/skills",
            native: false,
            evidence: "CodeBuddy 用户技能目录",
            excluded: false,
            linked: 2,
            conflicts: 0,
            managed: 0,
            missing: 0,
            states: { "design-review": "linked", "project-search": "linked" },
          },
        ],
      },
    },
    {
      hostId: "build-server",
      name: "build-server",
      error: null,
      inventory: {
        skills: [entry("project-search")],
        warnings: [],
        exclusions: ["github-copilot", "qoder"],
        agents: [],
      },
    },
  ];
  let current: SkillSyncPlan | undefined;
  let pending:
    | { hostId: string; scope: { agentId: string; skill: string }; kind: "link" | "unlink" }
    | undefined;
  let lastToggle:
    | {
        hostId: string;
        scope: { agentId: string; skill: string };
        previous: "linked" | "missing" | "conflict" | "managed" | "native";
      }
    | undefined;
  document.body.dataset.skillsLinkApplies = "0";
  return {
    status: async () => structuredClone(machines),
    async linkPlan(hostId, options) {
      const scope = options?.scope;
      if (scope) {
        const agent = machines
          .find((machine) => machine.hostId === hostId)
          ?.inventory?.agents.find((item) => item.id === scope.agentId);
        const previous = agent?.states[scope.skill] ?? "missing";
        const kind = previous === "linked" ? "unlink" : "link";
        pending = { hostId, scope, kind };
        return {
          id: uuid,
          hostId,
          warnings: [],
          actions: [
            {
              kind,
              agentId: scope.agentId,
              skill: scope.skill,
              path: `~/.${scope.agentId}/skills/${scope.skill}`,
              target: `~/.agents/skills/${scope.skill}`,
              fingerprint: null,
              previousLink: kind === "unlink" ? `../../.agents/skills/${scope.skill}` : null,
            },
          ],
        };
      }
      const adopt = options?.adopt;
      return {
        id: uuid,
        hostId,
        warnings: [],
        actions: [
          {
            kind: "link",
            agentId: "claude-code",
            skill: "project-search",
            path: "~/.claude/skills/project-search",
            target: "~/.agents/skills/project-search",
            fingerprint: null,
            previousLink: null,
          },
          {
            kind: "link",
            agentId: "cursor",
            skill: "project-search",
            path: "~/.cursor/skills/project-search",
            target: "~/.agents/skills/project-search",
            fingerprint: null,
            previousLink: null,
          },
          {
            kind: adopt?.some(
              (item) => item.agentId === "claude-code" && item.skill === "design-review",
            )
              ? "adopt"
              : "conflict",
            agentId: "claude-code",
            skill: "design-review",
            path: "~/.claude/skills/design-review",
            target: "~/.agents/skills/design-review",
            fingerprint: "c".repeat(64),
            previousLink: null,
          },
          {
            kind: "remove-dangling",
            agentId: "cursor",
            skill: "old-skill",
            path: "~/.cursor/skills/old-skill",
            target: "~/.agents/skills/old-skill",
            fingerprint: null,
            previousLink: "../../.agents/skills/old-skill",
          },
        ],
      };
    },
    linkApply: async () => {
      document.body.dataset.skillsLinkApplies = String(
        Number(document.body.dataset.skillsLinkApplies) + 1,
      );
      if (pending) {
        const agent = machines
          .find((machine) => machine.hostId === pending?.hostId)
          ?.inventory?.agents.find((item) => item.id === pending?.scope.agentId);
        if (agent) {
          const previous = (agent.states[pending.scope.skill] ?? "missing") as
            "linked" | "missing" | "conflict" | "managed" | "native";
          if (previous === "linked") agent.linked = Math.max(0, agent.linked - 1);
          if (previous === "missing") agent.missing = Math.max(0, agent.missing - 1);
          if (previous === "conflict") agent.conflicts = Math.max(0, agent.conflicts - 1);
          const next = pending.kind === "unlink" ? "missing" : "linked";
          agent.states[pending.scope.skill] = next;
          if (next === "linked") agent.linked += 1;
          else agent.missing += 1;
          lastToggle = { hostId: pending.hostId, scope: pending.scope, previous };
        }
        pending = undefined;
        return { id: uuid, changed: 1 };
      }
      return { id: uuid, changed: 2 };
    },
    undo: async () => {
      if (lastToggle) {
        const agent = machines
          .find((machine) => machine.hostId === lastToggle?.hostId)
          ?.inventory?.agents.find((item) => item.id === lastToggle?.scope.agentId);
        if (agent) {
          const current = agent.states[lastToggle.scope.skill];
          if (current === "linked") agent.linked = Math.max(0, agent.linked - 1);
          if (current === "missing") agent.missing = Math.max(0, agent.missing - 1);
          agent.states[lastToggle.scope.skill] = lastToggle.previous;
          if (lastToggle.previous === "linked") agent.linked += 1;
          if (lastToggle.previous === "missing") agent.missing += 1;
        }
        lastToggle = undefined;
      }
      return { id: uuid, changed: 2 };
    },
    async exclusions(hostId, agents) {
      const inventory = machines.find((m) => m.hostId === hostId)?.inventory;
      if (inventory) {
        inventory.exclusions = agents;
        for (const agent of inventory.agents) agent.excluded = agents.includes(agent.id);
      }
    },
    async syncPlan(input) {
      const versions = machines
        .filter((m) => m.inventory?.skills.some((s) => s.key === "design-review"))
        .map((m) => ({
          hostId: m.hostId,
          name: m.name,
          entry: m.inventory!.skills.find((s) => s.key === "design-review")!,
        }));
      current = {
        id: uuid,
        actions: [],
        conflicts:
          input.choices?.["design-review"] || input.skill === "project-search"
            ? []
            : [
                {
                  skill: "design-review",
                  versions,
                  diff: "MacBook Pro → oracle-main\n- version: 1.2\n+ version: 1.3\n- 检查颜色、间距和键盘交互\n+ 检查颜色、间距、键盘交互与屏幕阅读器\n~ SKILL.md\n~ references/checklist.md",
                },
              ],
      };
      if (!current.conflicts.length)
        current.actions = input.to
          .filter(
            (host) => host !== (input.choices?.["design-review"] ?? input.sourceHost ?? "local"),
          )
          .map((targetHost) => ({
            skill: input.skill === "--all" ? "design-review" : input.skill,
            sourceHost: input.choices?.["design-review"] ?? input.sourceHost ?? "local",
            targetHost,
            fingerprint: "b".repeat(64),
            expected: null,
          }));
      return current;
    },
    async syncApply() {
      return {
        results: (current?.actions ?? []).map((a) => ({
          hostId: a.targetHost,
          skill: a.skill,
          id: uuid,
          error: null,
        })),
      };
    },
  };
}
export function mountSkillsPreview() {
  const shell = installRendererSettingsShell(
    [createSkillsSettingsPage({ createClient: fakeClient })],
    rendererSettingsMessages("zh-CN"),
  );
  shell.openSettings(undefined, "skills");
  return shell.root.shadowRoot!;
}
