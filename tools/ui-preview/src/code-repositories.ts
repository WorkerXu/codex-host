import type { CodeRepositoriesClient } from "../../../packages/renderer-extension/src/code-repositories-client.js";
import type {
  CodeRepository,
  RepositoryJob,
  RepositorySettings,
} from "@codexhost/shared-contracts";

/** Deterministic replies; no network, filesystem operations, or real credentials. */
export function createRepositoryPreviewClient(state = "ready"): CodeRepositoriesClient {
  let settings: RepositorySettings = {
    gitlab: {
      configured: state !== "unconfigured",
      lastFour: state !== "unconfigured" ? "demo" : null,
    },
    github: { login: "WorkerXu" },
  };
  let job: RepositoryJob = { id: "preview-clone", state: "cloning", path: "", errorCode: null };
  let polls = 0;
  return {
    async settings() {
      return structuredClone(settings);
    },
    async setToken(token) {
      settings = {
        ...settings,
        gitlab: { configured: token !== null, lastFour: token?.slice(-4) ?? null },
      };
      return structuredClone(settings);
    },
    async test() {
      return state === "error"
        ? { ok: false, errorCode: "unauthorized" }
        : { ok: true, errorCode: null };
    },
    async list(provider, search) {
      document.body.dataset.repositoryQuery = JSON.stringify({ provider, search });
      if (state === "loading") return new Promise(() => {});
      if (state === "error") throw new Error("connection_failed");
      if (state === "unconfigured" && provider === "gitlab") throw new Error("missing_token");
      const names =
        provider === "github"
          ? ["codex-host", "shared-ui", "project-notes"]
          : ["platform-console", "order-service", "shared-components"];
      if (state === "empty") return [];
      return names
        .map((name, index): CodeRepository => ({
          id: String(index + 1),
          provider,
          name,
          namespace: provider === "github" ? "WorkerXu" : "研发中心 / 基础平台",
          description: ["让不同智能体在同一个桌面协作", "共享组件与设计规范", "项目文档和使用说明"][
            index
          ]!,
          lastActivity: ["2026-11-17T02:10:00Z", "2026-11-16T06:00:00Z", "2026-11-12T01:00:00Z"][
            index
          ]!,
          cloneUrl: `https://${provider === "github" ? "github.com" : "gitlab.xianghuanji.com"}/preview/${name}.git`,
        }))
        .filter((repository) => repository.name.includes(search.trim()));
    },
    async target(hostId, parent) {
      const base =
        parent ?? (hostId === "local" ? "/Users/lin/Downloads" : "/home/ubuntu/projects");
      return {
        parent: base,
        children: ["workspace", "sandbox", "shared"].map((name) => `${base}/${name}`),
      };
    },
    async clone(input) {
      document.body.dataset.repositoryClone = JSON.stringify(input);
      polls = 0;
      job = {
        id: "preview-clone",
        state: state === "conflict" ? "conflict" : "cloning",
        path: `${input.parent}/${(input.provider === "github" ? ["codex-host", "shared-ui", "project-notes"] : ["platform-console", "order-service", "shared-components"])[Number(input.repositoryId) - 1] ?? "repository"}`,
        errorCode: null,
      };
      return { ...job };
    },
    async job() {
      polls++;
      if (state === "clone-error") return { ...job, state: "error", errorCode: "unauthorized" };
      if (state === "cloning") return { ...job, state: "cloning" };
      if (state === "transferring") return { ...job, state: "transferring" };
      return { ...job, state: polls < 2 ? "cloning" : polls < 4 ? "transferring" : "complete" };
    },
  };
}
