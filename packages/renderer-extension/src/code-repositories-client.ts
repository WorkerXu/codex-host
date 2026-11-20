import {
  CODE_REPOSITORIES_PREFIX,
  codeRepositorySchema,
  repositorySettingsSchema,
  repositoryTargetSchema,
  repositoryJobSchema,
  repositoryTestSchema,
  type CodeRepository,
  type RepositoryProvider,
  type RepositorySettings,
  type RepositoryTarget,
  type RepositoryJob,
  type RepositoryCloneParams,
} from "@codexhost/shared-contracts";
import type { RendererRequestOptions } from "./renderer-request-sender.js";

export interface CodeRepositoriesClient {
  settings(): Promise<RepositorySettings>;
  setToken(token: string | null): Promise<RepositorySettings>;
  test(): Promise<{ ok: boolean; errorCode: string | null }>;
  list(provider: RepositoryProvider, search: string): Promise<CodeRepository[]>;
  target(hostId: string, parent?: string): Promise<RepositoryTarget>;
  clone(input: RepositoryCloneParams): Promise<RepositoryJob>;
  job(id: string): Promise<RepositoryJob>;
}
export function createCodeRepositoriesClient(
  manager: () => {
    sendRequest(method: string, params: unknown, options?: RendererRequestOptions): unknown;
  } | null,
): CodeRepositoriesClient {
  const request = async (method: string, params: unknown = {}) => {
    const local = manager();
    if (!local) throw new Error("local_only");
    return local.sendRequest(CODE_REPOSITORIES_PREFIX + method, params, {
      priority: "interactive",
      timeoutMs: 35_000,
    });
  };
  return {
    settings: async () => repositorySettingsSchema.parse(await request("settings")),
    setToken: async (token) =>
      repositorySettingsSchema.parse(await request("set-token", { token })),
    test: async () => repositoryTestSchema.parse(await request("test")),
    list: async (provider, search) =>
      codeRepositorySchema.array().parse(await request("list", { provider, search })),
    target: async (hostId, parent) =>
      repositoryTargetSchema.parse(
        await request("target", { hostId, ...(parent ? { parent } : {}) }),
      ),
    clone: async (input) => repositoryJobSchema.parse(await request("clone", input)),
    job: async (id) => repositoryJobSchema.parse(await request("job", { id })),
  };
}
export function repositoryErrorText(error: unknown): string {
  const value = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const messages: Record<string, string> = {
    missing_token: "请先在通用设置的「代码仓库」中添加 GitLab 访问令牌",
    unauthorized: "仓库没有权限，请检查账号或访问令牌",
    github_not_logged_in: "GitHub 未登录，请先在本机使用 gh 登录",
    target_exists: "目标目录已存在，请选择其他位置",
    invalid_path: "请选择有效的绝对路径",
    timeout: "连接超时，请稍后重试",
    connection_failed: "连接失败，请检查本机网络与远程连接",
    unknown_host: "这台机器尚未配置 SSH 连接",
    refresh_list: "仓库列表已更新，请重新选择仓库",
    busy: "已有仓库正在添加，请稍后重试",
    clone_failed: "克隆失败，请检查仓库权限后重试",
    missing_job: "无法读取克隆进度，请重新打开工作文件夹确认结果",
  };
  return (
    Object.entries(messages).find(([code]) => value === code || value.endsWith(`: ${code}`))?.[1] ??
    "无法读取代码仓库，请稍后重试"
  );
}
