import { createHash } from "node:crypto";
import { required } from "./files.js";
import { createInterface } from "node:readline/promises";
import type { Writable } from "node:stream";
import {
  skillLinkPlanSchema,
  skillSyncPlanSchema,
  type SkillsHubRequest,
} from "@codexhost/shared-contracts";
import { getSkillsHub, skillsError, type SkillsHubService } from "./service.js";
export const SKILLS_HELP = `codexhost skills list [--host <machine>]
codexhost skills sync <skill|--all> --to <machine,machine> [--host <source>] [--dry-run]
codexhost skills link [--host <machine>] [--dry-run]
codexhost skills undo <change-id> [--host <machine>]

先显示预览，再交互确认执行。非交互环境先取得 confirmation，再以 --confirm <confirmation> 执行。
冲突还需 --choose skill=machine,skill=machine；每次预览单独选择来源。
`;
export async function runSkillsCli(input: {
  arguments: string[];
  environment: NodeJS.ProcessEnv;
  output: Writable;
  service?: Pick<SkillsHubService, "request">;
  ask?: (question: string) => Promise<string>;
}): Promise<number> {
  const output = input.output;
  let prompt: ReturnType<typeof createInterface> | undefined;
  const ask =
    input.ask ??
    (process.stdin.isTTY && process.stderr.isTTY
      ? async (question: string) => {
          prompt ??= createInterface({ input: process.stdin, output: process.stderr });
          return prompt.question(question);
        }
      : undefined);
  try {
    if (input.arguments.includes("--help") || !input.arguments.length) {
      output.write(SKILLS_HELP);
      return 0;
    }
    const [command, ...args] = input.arguments;
    const options = new Map<string, string>();
    const positional: string[] = [];
    let dryRun = false,
      all = false;
    for (let index = 0; index < args.length; index++) {
      const argument = required(args[index]);
      if (argument === "--dry-run") {
        dryRun = true;
        continue;
      }
      if (argument === "--all") {
        all = true;
        continue;
      }
      if (argument.startsWith("--")) {
        if (
          !["--host", "--to", "--confirm", "--choose"].includes(argument) ||
          !args[index + 1] ||
          required(args[index + 1]).startsWith("--") ||
          options.has(argument)
        )
          throw new Error("invalid_arguments");
        options.set(argument, required(args[++index]));
      } else positional.push(argument);
    }
    const service = input.service ?? getSkillsHub(input.environment);
    const request = (value: SkillsHubRequest) => service.request(value);
    const write = (value: unknown) => output.write(`${JSON.stringify(value, null, 2)}\n`);
    const hostId = options.get("--host") ?? "local";
    const preview = (plan: { id: string }) => {
      const { id, ...content } = plan;
      const confirmation = createHash("sha256").update(JSON.stringify(content)).digest("hex");
      write({ id, ...content, confirmation });
      if (options.has("--confirm") && options.get("--confirm") !== confirmation)
        throw new Error("stale_plan");
      return options.has("--confirm");
    };
    if (options.has("--choose") && command !== "sync") throw new Error("invalid_arguments");
    if (options.has("--confirm") && !["link", "sync"].includes(command ?? ""))
      throw new Error("invalid_arguments");
    if (command === "list" && !positional.length && !all && !options.has("--to")) {
      write(await request({ op: "status", ...(options.has("--host") ? { hostId } : {}) }));
      return 0;
    }
    if (command === "undo" && positional.length === 1 && !all && !options.has("--to")) {
      if (!dryRun && ask && (await ask("确认撤销这批更改？[y/N] ")).toLowerCase() === "y")
        write(await request({ op: "undo", hostId, id: required(positional[0]) }));
      else write({ dryRun: true, hostId, undo: positional[0] });
      return 0;
    }
    if (command === "link" && !positional.length && !all && !options.has("--to")) {
      const plan = skillLinkPlanSchema.parse(await request({ op: "link-plan", hostId }));
      const confirmed = preview(plan);
      if (
        !dryRun &&
        (confirmed ||
          (ask && (await ask("按以上预览创建链接？现有目录将保留。[y/N] ")).toLowerCase() === "y"))
      )
        write(await request({ op: "link-apply", hostId, id: plan.id }));
      return 0;
    }
    if (
      command === "sync" &&
      (all ? !positional.length : positional.length === 1) &&
      options.has("--to")
    ) {
      const parameters = {
        op: "sync-plan" as const,
        mode: "sync" as const,
        skill: all ? "--all" : required(positional[0]),
        sourceHost: hostId,
        to: required(options.get("--to")).split(",").filter(Boolean),
      };
      let plan = skillSyncPlanSchema.parse(await request(parameters));
      const confirmed = preview(plan);
      if (dryRun || (!ask && !confirmed)) return 0;
      const choices: Record<string, string> = {};
      for (const selection of options.get("--choose")?.split(",") ?? []) {
        const [skill, winner] = selection.split("=");
        if (!skill || !winner) throw new Error("invalid_arguments");
        choices[skill] = winner;
      }
      for (const conflict of plan.conflicts) {
        const selected =
          choices[conflict.skill] ??
          (ask
            ? await ask(
                `${conflict.skill} 版本不同，选择保留来源 (${conflict.versions.map((v) => v.hostId).join(" / ")})，留空取消：`,
              )
            : "");
        if (!conflict.versions.some((version) => version.hostId === selected)) return 0;
        choices[conflict.skill] = selected;
      }
      if (plan.conflicts.length) {
        plan = skillSyncPlanSchema.parse(
          await request({ ...parameters, choices, basedOn: plan.id }),
        );
        write(plan);
      }
      if (confirmed || (ask && (await ask("确认按以上预览同步？[y/N] ")).toLowerCase() === "y")) {
        const result = await request({ op: "sync-apply", id: plan.id });
        write(result);
        if (
          (
            result as {
              results: {
                error: string | null;
              }[];
            }
          ).results.some((row) => row.error)
        )
          return 1;
      }
      return 0;
    }
    throw new Error("invalid_arguments");
  } catch (error) {
    output.write(
      `${JSON.stringify({ error: { code: skillsError(error), message: "技能操作失败；请检查参数、连接或重新预览。" } })}\n`,
    );
    return 1;
  } finally {
    prompt?.close();
  }
}
