import { describe, expect, it, vi } from "vitest";
import { prepareDingTalkProject } from "../src/renderer-dingtalk-dispatch-project.js";

it("creates the dedicated project through native Desktop services without activating it", async () => {
  const createLocal = vi.fn(async () => ({
    projectId: "local-project",
    rootPaths: ["/Users/test/Documents/ChatGPT/钉钉智能体"],
  }));
  const createDirectory = vi.fn(async () => undefined);
  const services = {
    projects: { createLocal, createRemote: async () => null },
    workspaceFiles: { createDirectory },
    executionPaths: { readHomeDirectory: async () => ({ homeDirectory: "/Users/test" }) },
  };
  const window = { document: { querySelectorAll: () => [] } } as unknown as Window;
  await prepareDingTalkProject(
    window,
    { cwd: "/Users/test/Documents/ChatGPT/钉钉智能体" },
    async () => services,
  );
  expect(createDirectory).toHaveBeenCalledWith({
    hostId: "local",
    path: "/Users/test/Documents/ChatGPT/钉钉智能体",
  });
  expect(createLocal).toHaveBeenCalledWith({
    appearance: null,
    initializeDefaultWorkspaceGitRepository: false,
    name: "钉钉智能体",
    setActive: false,
    sources: ["/Users/test/Documents/ChatGPT/钉钉智能体"],
  });
});

describe("DingTalk native project preparation", () => {
  it("fails closed when Desktop no longer exposes the reviewed API", async () => {
    await expect(
      prepareDingTalkProject({} as Window, { cwd: "/tmp/test" }, async () => null),
    ).rejects.toThrow("native local project service is unavailable");
  });
});
