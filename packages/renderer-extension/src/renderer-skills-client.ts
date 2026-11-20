import {
  SKILLS_HUB_METHOD,
  skillHostSchema,
  skillMachineSchema,
  skillLinkPlanSchema,
  skillSyncPlanSchema,
  skillChangeResultSchema,
  skillSyncResultSchema,
  type SkillsHubRequest,
  type SkillHost,
  type SkillMachine,
  type SkillLinkPlan,
  type SkillSyncPlan,
} from "@codexhost/shared-contracts";
import { z } from "zod";
export interface RendererLinkPlanOptions {
  adopt?: { agentId: string; skill: string }[];
  unlink?: { agentId: string; skill: string }[];
  scope?: { agentId: string; skill: string };
}
/** Machine ids are peer names; each request goes to that machine's own Host. */
export interface RendererSkillsTransport {
  request(machineId: string, params: SkillsHubRequest): Promise<unknown>;
}
export interface RendererSkillsClient {
  hosts(): Promise<SkillHost[]>;
  status(hostId: string): Promise<SkillMachine>;
  linkPlan(hostId: string, options?: RendererLinkPlanOptions): Promise<SkillLinkPlan>;
  linkApply(hostId: string, id: string): Promise<{ id: string; changed: number }>;
  undo(hostId: string, id: string): Promise<{ id: string; changed: number }>;
  syncPlan(input: Extract<SkillsHubRequest, { op: "sync-plan" }>): Promise<SkillSyncPlan>;
  syncApply(id: string): Promise<z.infer<typeof skillSyncResultSchema>>;
}
export function createRendererSkillsClient(
  transport: RendererSkillsTransport,
): RendererSkillsClient {
  return {
    async hosts() {
      return z
        .object({ hosts: z.array(skillHostSchema) })
        .parse(await transport.request("local", { op: "hosts" })).hosts;
    },
    async status(hostId) {
      const machines = z
        .object({ machines: z.array(skillMachineSchema) })
        .parse(await transport.request(hostId, { op: "status", hostId: "local" })).machines;
      const machine = machines[0];
      if (!machine) throw new Error("connection_failed");
      return { ...machine, hostId };
    },
    async linkPlan(hostId, options) {
      const plan = skillLinkPlanSchema.parse(
        await transport.request(hostId, { op: "link-plan", hostId: "local", ...(options ?? {}) }),
      );
      return { ...plan, hostId };
    },
    async linkApply(hostId, id) {
      return skillChangeResultSchema.parse(
        await transport.request(hostId, { op: "link-apply", hostId: "local", id }),
      );
    },
    async undo(hostId, id) {
      return skillChangeResultSchema.parse(
        await transport.request(hostId, { op: "undo", hostId: "local", id }),
      );
    },
    async syncPlan(input) {
      return skillSyncPlanSchema.parse(await transport.request("local", input));
    },
    async syncApply(id) {
      return skillSyncResultSchema.parse(
        await transport.request("local", { op: "sync-apply", id }),
      );
    },
  };
}
export { SKILLS_HUB_METHOD };
export function skillsErrorText(error: unknown): string {
  const code =
    typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : "";
  if (/connection_timeout|peer_timeout|timeout/iu.test(code)) return "连接超时";
  if (/permission_denied|EACCES|EPERM/u.test(code)) return "权限不足";
  if (/connection_failed|RUNTIME_UNREACHABLE/u.test(code)) return "连接失败";
  if (/stale_plan|expired_plan/u.test(code)) return "内容已变化，请重新预览";
  if (/undo_conflict/u.test(code)) return "文件已变化，无法撤销";
  if (/skill_too_large/u.test(code)) return "技能文件过大";
  if (/symlink_path/u.test(code)) return "目录指向其他位置，请先检查目录";
  return "操作失败，请重试";
}
