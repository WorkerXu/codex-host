import { describe, expect, it, vi } from "vitest";

import {
  createRendererJarvisClient,
  jarvisCodeFromError,
  jarvisErrorText,
} from "../src/renderer-jarvis-client.js";
import {
  findJarvisTrigger,
  groupJarvisSuggestions,
  jarvisStatusText,
  jarvisSuggestionLabel,
  truncateJarvisText,
} from "../src/renderer-jarvis-mention.js";

describe("Jarvis @ trigger", () => {
  it("detects a query that starts a word", () => {
    expect(findJarvisTrigger("@")).toEqual({ query: "", start: 0 });
    expect(findJarvisTrigger("hello @测试新提给我的bug")).toEqual({
      query: "测试新提给我的bug",
      start: 6,
    });
  });

  it("ignores emails, a leading digit-free rule is not applied to Jarvis queries", () => {
    expect(findJarvisTrigger("user@example.com")).toBeNull();
    expect(findJarvisTrigger("@928")).toEqual({ query: "928", start: 0 });
  });

  it("rejects an overlong query", () => {
    expect(findJarvisTrigger(`@${"x".repeat(65)}`)).toBeNull();
  });
});

describe("Jarvis suggestion presentation", () => {
  const bug = {
    kind: "bug" as const,
    id: 928,
    projectId: 4029,
    title: "填写已查码的序列号给新的查码任务，无法进行下一步",
    status: 1,
    assigneeId: 10058,
  };

  it("truncates long titles with an ellipsis", () => {
    expect(truncateJarvisText("  a   b  ", 10)).toBe("a b");
    expect(truncateJarvisText("x".repeat(30), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("builds the chip label in Chinese and English", () => {
    expect(jarvisSuggestionLabel({ ...bug, score: 1 }, "zh-CN")).toBe(
      "Bug #928 填写已查码的序列号给新的查码任务，无法进行下一步",
    );
    expect(jarvisSuggestionLabel({ ...bug, score: 1 }, "en")).toContain("Bug #928 ");
  });

  it("maps bug status and keeps unknown statuses readable", () => {
    expect(jarvisStatusText({ ...bug, score: 1 }, "zh-CN")).toBe("待处理");
    expect(jarvisStatusText({ ...bug, score: 1, status: 9 }, "zh-CN")).toBe("状态 9");
    expect(jarvisStatusText({ ...bug, score: 1, status: undefined }, "zh-CN")).toBe("");
  });

  it("groups rows in project, requirement, task, bug order", () => {
    const suggestions = [
      { ...bug, score: 1 },
      { kind: "task" as const, id: 3, title: "t", score: 1 },
      { kind: "project" as const, id: 1, title: "p", score: 1 },
    ];
    expect(groupJarvisSuggestions(suggestions).map(({ kind }) => kind)).toEqual([
      "project",
      "task",
      "bug",
    ]);
  });
});

describe("Renderer Jarvis client", () => {
  const localManager = {
    sendRequest: vi.fn(async (method: string, params: unknown) => {
      if (method === "codexhost/jarvis/classify") {
        return { available: true, isJarvis: true, kind: "bug", confidence: 0.9 };
      }
      if (method === "codexhost/jarvis/rank") {
        const input = params as { candidates: { id: number }[]; user: { id: number } };
        return {
          available: true,
          suggestions: [{ kind: "bug", id: 928, projectId: 4029, title: "序列号", score: 1.6 }].map(
            (item) => ({ ...item, ...(input.candidates.find(({ id }) => id === 928) ? {} : {}) }),
          ),
        };
      }
      return {};
    }),
  };
  const remoteManager = {
    sendRequest: vi.fn(async () => ({
      available: true,
      candidates: [{ kind: "bug", id: 928, projectId: 4029, title: "序列号", status: 1 }],
      user: { id: 10058, name: "许涛" },
      fetchedAt: "2026-11-13T00:00:00.000Z",
    })),
  };

  it("classifies on the local Host, fetches candidates on the target and ranks locally", async () => {
    const client = createRendererJarvisClient({
      forHost: (hostId) => {
        if (hostId === "local") return { hostId, manager: localManager };
        if (hostId === "remote-1") return { hostId, manager: remoteManager };
        return null;
      },
    });
    const result = await client.suggest("remote-1", "测试新提给我的bug");
    expect(result?.suggestions[0]).toMatchObject({ id: 928, kind: "bug" });
    expect(localManager.sendRequest).toHaveBeenCalledWith(
      "codexhost/jarvis/classify",
      { query: "测试新提给我的bug" },
      expect.any(Object),
    );
    expect(remoteManager.sendRequest).toHaveBeenCalledWith(
      "codexhost/jarvis/candidates",
      { kind: "bug" },
      expect.any(Object),
    );
    const rankParams = localManager.sendRequest.mock.calls.find(
      ([method]) => method === "codexhost/jarvis/rank",
    )?.[1] as { user: { id: number } };
    expect(rankParams.user).toEqual({ id: 10058, name: "许涛" });
  });

  it("returns null for ordinary text, not a Jarvis query", async () => {
    const classify = vi.fn(async () => ({
      available: true,
      isJarvis: false,
      kind: "none" as const,
      confidence: 0.1,
    }));
    const client = createRendererJarvisClient({
      forHost: () => ({ hostId: "local", manager: { sendRequest: classify } }),
    });
    expect(await client.suggest("local", "修复登录")).toBeNull();
  });

  it("keeps settings local and reports hasKey without exposing the key", async () => {
    const sendRequest = vi.fn(async (method: string, params: unknown) => {
      if (method === "codexhost/jarvis/settings/get") return { hasKey: true, threshold: 0.4 };
      if (method === "codexhost/jarvis/settings/set") {
        const input = params as { geminiApiKey?: string | null; threshold?: number };
        return {
          hasKey: input.geminiApiKey === null ? false : input.geminiApiKey ? true : true,
          threshold: input.threshold ?? 0.4,
        };
      }
      return { ok: true, latencyMs: 120, errorCode: null };
    });
    const client = createRendererJarvisClient({
      forHost: (hostId) => (hostId === "local" ? { hostId, manager: { sendRequest } } : null),
    });
    expect(await client.settings()).toEqual({ hasKey: true, threshold: 0.4 });
    expect(await client.updateSettings({ geminiApiKey: "secret" })).toEqual({
      hasKey: true,
      threshold: 0.4,
    });
    expect(await client.updateSettings({ geminiApiKey: null })).toEqual({
      hasKey: false,
      threshold: 0.4,
    });
    expect(await client.testSettings()).toEqual({ ok: true, latencyMs: 120, errorCode: null });
    expect(sendRequest).toHaveBeenCalledWith(
      "codexhost/jarvis/settings/set",
      { geminiApiKey: "secret" },
      expect.any(Object),
    );
  });

  it("localizes Host error codes", () => {
    expect(jarvisErrorText("not_installed", "zh-CN")).toBe("未安装 jarvis CLI");
    expect(jarvisErrorText("forward_failed", "zh-CN")).toBe("无法建立登录回调转发");
    expect(jarvisErrorText("unknown_code", "zh-CN")).toBe("Jarvis 操作失败");
    expect(jarvisCodeFromError({ message: "not_installed" })).toBe("not_installed");
    expect(jarvisCodeFromError(new Error("boom"))).toBe("jarvis_failed");
    expect(jarvisCodeFromError(new Error("timeout"))).toBe("timeout");
  });
});
