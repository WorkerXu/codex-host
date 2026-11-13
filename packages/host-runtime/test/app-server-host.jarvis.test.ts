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
import { JarvisServiceError } from "../src/jarvis-service.js";

function fakeService(overrides: Partial<Record<keyof JarvisService, unknown>> = {}): JarvisService {
  return {
    status: vi.fn(async () => ({
      installed: true,
      version: "0.20.1",
      platform: "linux-arm64",
      authenticated: true,
      userName: "许涛",
      userId: 10058,
      errorCode: null,
    })),
    classify: vi.fn(async () => ({
      available: true,
      isJarvis: true,
      kind: "bug",
      confidence: 0.9,
    })),
    candidates: vi.fn(async () => ({
      available: true,
      candidates: [{ kind: "bug", id: 928, projectId: 4029, title: "序列号" }],
      user: { id: 10058, name: "许涛" },
      fetchedAt: "2026-11-13T00:00:00.000Z",
    })),
    rank: vi.fn(async () => ({ available: true, suggestions: [] })),
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

  it("serves status, classify, candidates and settings from the connected Host", async () => {
    const fixture = createFixture({ jarvis: fakeService() });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, { id: 1, method: "codexhost/jarvis/status", params: {} });
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
        result: { installed: true, userId: 10058 },
      });
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/jarvis/classify",
        params: { query: "测试新提给我的bug" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 2))).toMatchObject({
        result: { isJarvis: true, kind: "bug" },
      });
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "codexhost/jarvis/candidates",
        params: { kind: "bug" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toMatchObject({
        result: { available: true, candidates: [{ id: 928 }] },
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
        method: "codexhost/jarvis/candidates",
        params: { kind: "epic" },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
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
});
