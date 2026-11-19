import {
  SKILLS_HUB_METHOD,
  skillMachineSchema,
  skillLinkPlanSchema,
  skillSyncPlanSchema,
  skillChangeResultSchema,
  skillSyncResultSchema,
  type SkillsHubRequest,
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
export interface RendererSkillsClient {
  status(hostId?: string): Promise<SkillMachine[]>;
  linkPlan(hostId: string, options?: RendererLinkPlanOptions): Promise<SkillLinkPlan>;
  linkApply(hostId: string, id: string): Promise<{ id: string; changed: number }>;
  undo(hostId: string, id: string): Promise<{ id: string; changed: number }>;
  exclusions(hostId: string, agents: string[]): Promise<void>;
  syncPlan(input: Extract<SkillsHubRequest, { op: "sync-plan" }>): Promise<SkillSyncPlan>;
  syncApply(id: string): Promise<z.infer<typeof skillSyncResultSchema>>;
}
export function createRendererSkillsClient(
  request: (params: SkillsHubRequest) => Promise<unknown>,
): RendererSkillsClient {
  return {
    async status(hostId) {
      return z
        .object({ machines: z.array(skillMachineSchema) })
        .parse(await request({ op: "status", ...(hostId ? { hostId } : {}) })).machines;
    },
    async linkPlan(hostId, options) {
      return skillLinkPlanSchema.parse(
        await request({ op: "link-plan", hostId, ...(options ?? {}) }),
      );
    },
    async linkApply(hostId, id) {
      return skillChangeResultSchema.parse(await request({ op: "link-apply", hostId, id }));
    },
    async undo(hostId, id) {
      return skillChangeResultSchema.parse(await request({ op: "undo", hostId, id }));
    },
    async exclusions(hostId, agents) {
      await request({ op: "exclusions", hostId, agents });
    },
    async syncPlan(input) {
      return skillSyncPlanSchema.parse(await request(input));
    },
    async syncApply(id) {
      return skillSyncResultSchema.parse(await request({ op: "sync-apply", id }));
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
