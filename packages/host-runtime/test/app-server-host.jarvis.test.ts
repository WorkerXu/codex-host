import { describe, expect, it, vi } from "vitest";

import {
  createFixture,
  readJsonLine,
  requestId,
  requiredMessageId,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

import type { JarvisService } from "../src/jarvis-service.js";
import { JarvisService as LocalJarvisService, JarvisServiceError } from "../src/jarvis-service.js";

function fakeService(overrides: Partial<Record<keyof JarvisService, unknown>> = {}): JarvisService {
  return {
    status: vi.fn(async () => ({
      installed: true,
      version: "0.20.1",
      platform: "linux-arm64",
      authenticated: true,
      userName: "示例用户",
      userId: 10058,
      errorCode: null,
    })),
    searchBugs: vi.fn(async () => ({
      available: true,
      errorCode: null,
      conditions: [{ key: "scope:assigned", kind: "scope", label: "指派给我" }],
      bugs: [{ id: 9101, projectId: 9001, title: "示例：列表页加载失败" }],
      total: 1,
      capped: false,
    })),
    listProjects: vi.fn(async () => ({
      available: true,
      errorCode: null,
      projects: [{ id: 9001, name: "示例后台 · 迭代 B" }],
      complete: true,
      userId: 10058,
    })),
    previewProjectBugTitle: vi.fn(async () => ({
      available: true,
      errorCode: null,
      conditions: [],
      bugs: [{ id: 9102, projectId: 9001, title: "示例：发货失败" }],
      total: 1,
      capped: false,
    })),
    searchProjectBugs: vi.fn(async () => ({
      available: true,
      errorCode: null,
      conditions: [{ key: "status:1", kind: "status", label: "未解决" }],
      bugs: [{ id: 9102, projectId: 9001, title: "示例：发货失败" }],
      total: 1,
      capped: false,
    })),
    settings: vi.fn(async () => ({ hasKey: true, threshold: 0.5 })),
    updateSettings: vi.fn(async () => ({ hasKey: true, threshold: 0.4 })),
    testSettings: vi.fn(async () => ({ ok: true, latencyMs: 30, errorCode: null })),
    install: vi.fn(async () => ({ state: "failed" as const, errorCode: "unsupported_platform" })),
    startLogin: vi.fn(async () => {
      throw new JarvisServiceError("not_installed", "jarvis CLI is not installed");
    }),
    forwardLogin: vi.fn(async () => ({
      forwarded: false,
      authUrl: "https://auth.test/login",
      forwardId: null,
      errorCode: "peer_unavailable",
    })),
    stopForward: vi.fn(),
    expandMentions: vi.fn(async (text: string) => text),
    ...overrides,
  } as unknown as JarvisService;
}

async function initialize(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await fixture.ready;
  writeRequest(fixture.desktopInput, {
    id: 100,
    method: "initialize",
    params: {
      clientInfo: { name: "jarvis-test", version: "1" },
      capabilities: { experimentalApi: true },
    },
  });
  const initializeRequest = await readJsonLine(fixture.official.stdin);
  writeRequest(fixture.official.stdout, {
    id: requiredMessageId(initializeRequest),
    result: { userAgent: "official" },
  });
  await fixture.collector.waitFor((message) => requestId(message, 100));
  await readJsonLine(fixture.official.stdin);
}

describe("Host Jarvis RPC", () => {
  it("cancels an in-flight search through RPC without blocking later queries", async () => {
    const cancelled = {
      available: false,
      errorCode: "cancelled",
      conditions: [],
      bugs: [],
      total: 0,
      capped: false,
    };
    const search = vi.fn(
      async (_params, signal?: AbortSignal) =>
        new Promise<typeof cancelled>((resolve) => {
          signal?.addEventListener("abort", () => resolve(cancelled), { once: true });
        }),
    );
    const service = new LocalJarvisService({
      isLocalHost: true,
      searcher: {
        search,
        searchInProject: vi.fn(async () => cancelled),
        previewTitle: vi.fn(async () => cancelled),
      },
    });
    const fixture = createFixture({ jarvis: service });
    const id = "a7dcdbaa-74a0-4486-89d6-87e8aceb45be";
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "codexhost/jarvis/bug/search",
        params: { query: "旧查询", requestId: id },
      });
      await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/jarvis/bug/search/cancel",
        params: { requestId: id },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        result: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
        result: cancelled,
      });
      expect(search.mock.calls[0]?.[1]?.aborted).toBe(true);
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "codexhost/jarvis/bug/search/cancel",
        params: { requestId: "invalid" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toMatchObject({
        error: { message: "invalid_params" },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("expands a Jarvis carrier before forwarding a native Codex turn", async () => {
    const expandMentions = vi.fn(async (text: string) =>
      text.replace("[@Bug](jarvis://bug/1/2)", "@Bug\n\n[codexhost Jarvis]\n详情"),
    );
    const fixture = createFixture({ jarvis: fakeService({ expandMentions }) });
    try {
      await initialize(fixture);
      writeRequest(fixture.desktopInput, {
        id: 101,
        method: "turn/start",
        params: {
          threadId: "official-thread",
          input: [{ type: "text", text: "修复 [@Bug](jarvis://bug/1/2)" }],
        },
      });
      const forwarded = (await readJsonLine(fixture.official.stdin)) as {
        method: string;
        params: { input: { text: string }[] };
      };
      expect(forwarded.method).toBe("turn/start");
      expect(forwarded.params.input[0]?.text).toContain("[codexhost Jarvis]");
      expect(forwarded.params.input[0]?.text).not.toContain("jarvis://");
      expect(expandMentions).toHaveBeenCalledWith("修复 [@Bug](jarvis://bug/1/2)");
    } finally {
      await stopFixture(fixture);
    }
  });

  it("serves status, structured bug search and settings from the connected Host", async () => {
    const fixture = createFixture({ jarvis: fakeService() });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, { id: 1, method: "codexhost/jarvis/status", params: {} });
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
        result: { installed: true, userId: 10058 },
      });
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/jarvis/bug/search",
        params: { query: "我还没处理完成的bug" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        result: { available: true, total: 1, bugs: [{ id: 9101 }] },
      });
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "codexhost/jarvis/project/list",
        params: { query: "发货" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toMatchObject({
        result: { available: true, projects: [{ id: 9001 }], userId: 10058 },
      });
      writeRequest(fixture.desktopInput, {
        id: 5,
        method: "codexhost/jarvis/project/bug/title",
        params: { projectId: 9001, title: "发货" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 5))).toMatchObject({
        result: { available: true, bugs: [{ id: 9102 }], conditions: [] },
      });
      writeRequest(fixture.desktopInput, {
        id: 6,
        method: "codexhost/jarvis/project/bug/search",
        params: { projectId: 9001, query: "未解决的发货bug" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 6))).toMatchObject({
        result: { available: true, conditions: [{ key: "status:1" }] },
      });
      writeRequest(fixture.desktopInput, {
        id: 4,
        method: "codexhost/jarvis/settings/get",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 4))).toMatchObject({
        result: { hasKey: true, threshold: 0.5 },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("rejects invalid params and surfaces stable Jarvis error codes", async () => {
    const fixture = createFixture({ jarvis: fakeService() });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "codexhost/jarvis/bug/search",
        params: { query: 42 },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
        error: { code: -32094, message: "invalid_params" },
      });
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "codexhost/jarvis/project/bug/title",
        params: { projectId: 0, title: "发货" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toMatchObject({
        error: { code: -32094, message: "invalid_params" },
      });
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/jarvis/login/start",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        error: { code: -32094, message: "not_installed" },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("reports the method as unavailable when the Host has no Jarvis service", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, { id: 1, method: "codexhost/jarvis/status", params: {} });
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
        error: { code: -32601 },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("strips undefined optional fields from the three project RPC results", async () => {
    const bug = {
      id: 9102,
      projectId: 9001,
      title: "示例：发货失败",
      projectName: undefined,
      status: undefined,
      priority: undefined,
      severity: undefined,
      creatorId: undefined,
      assigneeId: undefined,
      createdAt: undefined,
      updatedAt: undefined,
    };
    const service = fakeService({
      listProjects: vi.fn(async () => ({
        available: true,
        errorCode: null,
        projects: [{ id: 9001, name: "示例后台", extra: undefined }],
        complete: true,
        userId: 10058,
      })),
      previewProjectBugTitle: vi.fn(async () => ({
        available: true,
        errorCode: null,
        conditions: [],
        bugs: [bug],
        total: 1,
        capped: false,
        source: undefined,
      })),
      searchProjectBugs: vi.fn(async () => ({
        available: true,
        errorCode: null,
        conditions: [],
        bugs: [bug],
        total: 1,
        capped: false,
        source: undefined,
      })),
    });
    const fixture = createFixture({ jarvis: service });
    try {
      await fixture.ready;
      const calls = [
        [10, "codexhost/jarvis/project/list", { query: "发货" }],
        [11, "codexhost/jarvis/project/bug/title", { projectId: 9001, title: "" }],
        [12, "codexhost/jarvis/project/bug/search", { projectId: 9001, query: "发货" }],
      ] as const;
      for (const [id, method, params] of calls) {
        writeRequest(fixture.desktopInput, { id, method, params });
        const message = await fixture.collector.waitFor((item) => requestId(item, id));
        expect(message).toMatchObject({ result: { available: true } });
        expect((message as { error?: unknown }).error).toBeUndefined();
      }
      const title = await fixture.collector.waitFor((item) => requestId(item, 11));
      expect(title).toMatchObject({ result: { bugs: [{ id: 9102 }] } });
      expect(JSON.stringify(title)).not.toContain("projectName");
    } finally {
      await stopFixture(fixture);
    }
  });
});
