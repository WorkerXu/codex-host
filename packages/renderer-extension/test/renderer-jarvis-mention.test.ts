import { describe, expect, it, vi } from "vitest";

import type { JarvisBugSearchResult } from "@codexhost/shared-contracts";

import {
  createRendererJarvisClient,
  jarvisCodeFromError,
  jarvisSearchShouldFallback,
  jarvisErrorText,
} from "../src/renderer-jarvis-client.js";
import {
  findJarvisTrigger,
  jarvisBugLabel,
  jarvisEntryAction,
  jarvisPriorityText,
  jarvisQueryEntry,
  jarvisRelativeTime,
  jarvisSeverityText,
  jarvisStatusText,
  matchesJarvisEntry,
  showsJarvisEntry,
  truncateJarvisText,
} from "../src/renderer-jarvis-mention.js";

describe("Jarvis @ trigger", () => {
  it("detects the token without implying a search", () => {
    expect(findJarvisTrigger("@")).toEqual({ query: "", start: 0 });
    expect(findJarvisTrigger("hello @测试新提给我的bug")).toEqual({
      query: "测试新提给我的bug",
      start: 6,
    });
    expect(findJarvisTrigger("user@example.com")).toBeNull();
  });
});

describe("Jarvis entry gating", () => {
  it("shows the row only for its own name or an empty query", () => {
    expect(matchesJarvisEntry("")).toBe(true);
    expect(matchesJarvisEntry("jar")).toBe(true);
    expect(matchesJarvisEntry("贾")).toBe(true);
    expect(matchesJarvisEntry("示例买")).toBe(false);
  });

  it("never searches before the row is selected", () => {
    expect(jarvisEntryAction({ query: "", selectedEntry: false })).toBe("entry");
    expect(jarvisEntryAction({ query: "jarvis", selectedEntry: false })).toBe("entry");
    expect(jarvisEntryAction({ query: "示例买", selectedEntry: false })).toBe("entry");
    expect(jarvisEntryAction({ query: "示例买", selectedEntry: true })).toBe("search");
    expect(jarvisEntryAction({ query: "", selectedEntry: true })).toBe("search");
  });

  it("turns a natural-language query into a prefilled Jarvis row", () => {
    expect(jarvisQueryEntry("")).toBeNull();
    expect(jarvisQueryEntry("jar")).toBeNull();
    expect(jarvisQueryEntry("贾")).toBeNull();
    expect(jarvisQueryEntry("钉")).toBeNull();
    expect(jarvisQueryEntry("ding")).toBeNull();
    expect(jarvisQueryEntry("我还没处理完的bug")).toBe("我还没处理完的bug");
    expect(showsJarvisEntry("我还没处理完的bug")).toBe(true);
    expect(showsJarvisEntry("钉")).toBe(false);
  });
});

describe("Jarvis bug presentation", () => {
  const bug = {
    id: 9101,
    projectId: 9001,
    title: "示例：列表页加载失败",
    status: 1,
    priority: 1,
    severity: 2,
    updatedAt: "2026-11-16 09:50:00",
  };

  it("truncates long titles with an ellipsis", () => {
    expect(truncateJarvisText("  a   b  ", 10)).toBe("a b");
    expect(truncateJarvisText("x".repeat(30), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("builds the chip label", () => {
    expect(jarvisBugLabel(bug)).toBe("Bug #9101 示例：列表页加载失败");
  });

  it("maps status, priority and severity in both locales", () => {
    expect(jarvisStatusText(1, "zh-CN")).toBe("未解决");
    expect(jarvisStatusText(9, "zh-CN")).toBe("状态 9");
    expect(jarvisStatusText(undefined, "zh-CN")).toBe("");
    expect(jarvisPriorityText(1, "zh-CN")).toBe("高优先级");
    expect(jarvisSeverityText(2, "zh-CN")).toBe("严重");
    expect(jarvisPriorityText(2, "en")).toBe("Medium priority");
  });

  it("renders a relative update time", () => {
    const now = Date.parse("2026-11-16T10:00:00");
    expect(jarvisRelativeTime("2026-11-16 09:59:30", "zh-CN", now)).toBe("刚刚");
    expect(jarvisRelativeTime("2026-11-16 09:30:00", "zh-CN", now)).toBe("30 分钟前");
    expect(jarvisRelativeTime("2026-11-15 10:00:00", "zh-CN", now)).toBe("1 天前");
    expect(jarvisRelativeTime("2026-01-02 10:00:00", "zh-CN", now)).toBe("01-02");
    expect(jarvisRelativeTime(undefined, "zh-CN", now)).toBe("");
  });
});

describe("Renderer Jarvis client", () => {
  it("cancels only the superseded Host request and skips already cancelled requests", async () => {
    let finish!: (value: unknown) => void;
    const sendRequest = vi.fn((method: string) =>
      method.endsWith("/cancel")
        ? Promise.resolve({})
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const client = createRendererJarvisClient({
      forHost: (hostId) => ({ hostId, manager: { sendRequest } }),
    });
    const controller = new AbortController();
    const pending = client.searchBugs("local", { query: "旧查询" }, controller.signal);
    const params = (sendRequest.mock.calls as unknown as [string, { requestId: string }][])[0]?.[1];
    expect(params?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    controller.abort();
    expect(sendRequest).toHaveBeenLastCalledWith(
      "codexhost/jarvis/bug/search/cancel",
      params && { requestId: params.requestId },
      expect.any(Object),
    );
    finish({
      available: false,
      errorCode: "cancelled",
      conditions: [],
      bugs: [],
      total: 0,
      capped: false,
    });
    await pending;
    await client.searchBugs("local", { query: "已取消" }, controller.signal);
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  const result: JarvisBugSearchResult = {
    available: true,
    errorCode: null,
    conditions: [{ key: "scope:assigned", kind: "scope", label: "指派给我" }],
    bugs: [
      {
        id: 9101,
        projectId: 9001,
        projectName: "示例后台 · 迭代 B",
        title: "示例：列表页加载失败",
        status: 1,
      },
    ],
    total: 1,
    capped: false,
  };

  it("sends the structured search to the thread Host", async () => {
    const sendRequest = vi.fn(async () => result);
    const client = createRendererJarvisClient({
      forHost: (hostId) => ({ hostId, manager: { sendRequest } }),
    });
    expect(await client.searchBugs("remote-1", { query: "未解决的bug", omit: ["time"] })).toEqual(
      result,
    );
    expect(sendRequest).toHaveBeenCalledWith(
      "codexhost/jarvis/bug/search",
      { query: "未解决的bug", omit: ["time"] },
      expect.any(Object),
    );
  });

  it("returns an unavailable result when the Host route is missing", async () => {
    const client = createRendererJarvisClient({ forHost: () => null });
    expect(await client.searchBugs("remote-1", { query: "bug" })).toMatchObject({
      available: false,
      errorCode: "jarvis_failed",
      bugs: [],
    });
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

  it("falls back to the thread Host only when local Jarvis is unusable", () => {
    const result = (errorCode: JarvisBugSearchResult["errorCode"]) => ({
      available: errorCode === null,
      errorCode,
      conditions: [],
      bugs: [],
      total: 0,
      capped: false,
    });
    expect(jarvisSearchShouldFallback(result("not_installed"))).toBe(true);
    expect(jarvisSearchShouldFallback(result("not_logged_in"))).toBe(true);
    expect(jarvisSearchShouldFallback(result("unreachable"))).toBe(true);
    expect(jarvisSearchShouldFallback(result(null))).toBe(false);
    expect(jarvisSearchShouldFallback(result("cli_failed"))).toBe(false);
    for (const code of [
      "missing_key",
      "quota_exhausted",
      "unauthorized",
      "timeout",
      "network",
      "invalid_response",
      "gemini_failed",
    ]) {
      expect(jarvisSearchShouldFallback(result(code))).toBe(false);
    }
  });

  it("localizes Host error codes", () => {
    expect(jarvisErrorText("not_installed", "zh-CN")).toBe("未安装 jarvis CLI");
    expect(jarvisErrorText("forward_failed", "zh-CN")).toBe("无法建立登录回调转发");
    expect(jarvisErrorText("unknown_code", "zh-CN")).toBe("Jarvis 操作失败");
    expect(jarvisErrorText("missing_key", "zh-CN")).toBe("未配置 Gemini Key");
    expect(jarvisErrorText("quota_exhausted", "zh-CN")).toBe("Gemini 额度不足");
    expect(jarvisErrorText("unauthorized", "zh-CN")).toBe("Gemini Key 无效");
    expect(jarvisErrorText("network", "zh-CN")).toBe("网络连接失败");
    expect(jarvisCodeFromError(new Error("quota_exhausted"))).toBe("quota_exhausted");
    expect(jarvisErrorText("prepayment credits are depleted", "zh-CN")).toBe("Jarvis 操作失败");
    expect(jarvisErrorText("invalid_response", "zh-CN")).toContain("解析结果无效");
    expect(jarvisErrorText("gemini_failed", "zh-CN")).toContain("Gemini 查询理解失败");
    expect(jarvisCodeFromError({ message: "not_installed" })).toBe("not_installed");
    expect(jarvisCodeFromError(new Error("boom"))).toBe("jarvis_failed");
    expect(jarvisCodeFromError(new Error("timeout"))).toBe("timeout");
  });
});
