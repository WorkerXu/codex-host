import { describe, expect, it } from "vitest";

import {
  DINGTALK_CHANGED_METHOD,
  DINGTALK_CONVERSATIONS_METHOD,
  DINGTALK_MEMBERS_METHOD,
  DINGTALK_MESSAGES_METHOD,
  DINGTALK_PREVIEW_METHOD,
  DINGTALK_STATUS_METHOD,
  DINGTALK_VIEWED_METHOD,
  type DingTalkStatus,
} from "@codexhost/shared-contracts";

import {
  createRendererDingTalkClient,
  type RendererDingTalkManager,
  type RendererDingTalkRoute,
} from "../src/renderer-dingtalk-client.js";

function status(overrides: Partial<DingTalkStatus> = {}): DingTalkStatus {
  return {
    installed: true,
    authenticated: true,
    userName: "我",
    userId: "me",
    corpName: "测试公司",
    defaultHost: "tencent",
    defaultHostId: "host-tencent",
    errorCode: null,
    ...overrides,
  };
}

function conversationsResult() {
  return {
    available: true,
    source: "unread" as const,
    conversations: [],
    cachedAt: null,
    refreshing: false,
    errorCode: null,
  };
}

function manager(
  calls: string[],
  options: { status?: DingTalkStatus | (() => DingTalkStatus) } = {},
): RendererDingTalkManager & { listener?: ((value: unknown) => void) | undefined } {
  const readStatus = (): DingTalkStatus =>
    typeof options.status === "function" ? options.status() : (options.status ?? status());
  const value = {
    calls,
    listener: undefined as ((value: unknown) => void) | undefined,
    async sendRequest(method: string) {
      calls.push(method);
      if (method === DINGTALK_STATUS_METHOD) return readStatus();
      if (method === DINGTALK_CONVERSATIONS_METHOD) return conversationsResult();
      if (method === DINGTALK_MESSAGES_METHOD) {
        return {
          available: true,
          conversation: null,
          messages: [],
          hasMore: false,
          nextCursor: null,
          cachedAt: null,
          errorCode: null,
        };
      }
      return {};
    },
    addNotificationCallback(
      _methods: string | readonly string[],
      listener: (value: unknown) => void,
    ) {
      value.listener = listener;
      return () => {
        value.listener = undefined;
      };
    },
  };
  return value;
}

function route(hostId: string, target: RendererDingTalkManager): RendererDingTalkRoute {
  return { hostId, manager: target };
}

describe("DingTalk renderer routing", () => {
  it("prioritizes the open transcript over list previews", async () => {
    const priorities: [string, string | undefined][] = [];
    const target = manager([], { status: status({ defaultHost: "local", defaultHostId: null }) });
    const original = target.sendRequest.bind(target);
    target.sendRequest = async (method, params, options) => {
      priorities.push([method, options?.priority]);
      if (method === DINGTALK_PREVIEW_METHOD)
        return { available: true, preview: null, cachedAt: null, errorCode: null };
      return original(method, params, options);
    };
    const client = createRendererDingTalkClient({ forHost: () => route("local", target) });
    await client.messages({ conversationId: "cid" });
    await client.preview("cid");
    expect(priorities).toContainEqual([DINGTALK_MESSAGES_METHOD, "interactive"]);
    expect(priorities).toContainEqual([DINGTALK_PREVIEW_METHOD, "background"]);
  });
  it("sends data requests to the Host that owns the DingTalk login", async () => {
    const localCalls: string[] = [];
    const remoteCalls: string[] = [];
    const local = manager(localCalls, { status: status() });
    const remote = manager(remoteCalls);
    const client = createRendererDingTalkClient({
      forHost: (hostId) =>
        hostId === "local"
          ? route("local", local)
          : hostId === "host-tencent"
            ? route("host-tencent", remote)
            : null,
    });

    await client.status();
    await client.conversations();
    expect(localCalls).toEqual([DINGTALK_STATUS_METHOD]);
    // The route is probed once before data requests use it.
    expect(remoteCalls).toEqual([DINGTALK_STATUS_METHOD, DINGTALK_CONVERSATIONS_METHOD]);
  });

  it("keeps local forwarding when the DingTalk Host cannot serve DingTalk", async () => {
    const localCalls: string[] = [];
    const remoteCalls: string[] = [];
    const local = manager(localCalls, { status: status() });
    const remote: RendererDingTalkManager = {
      async sendRequest(method: string) {
        remoteCalls.push(method);
        throw new Error("DingTalk is unavailable on this Host");
      },
    };
    const client = createRendererDingTalkClient({
      forHost: (hostId) =>
        hostId === "local"
          ? route("local", local)
          : hostId === "host-tencent"
            ? route("host-tencent", remote)
            : null,
    });

    await client.status();
    await client.conversations();
    expect(remoteCalls).toEqual([DINGTALK_STATUS_METHOD]);
    expect(localCalls).toEqual([DINGTALK_STATUS_METHOD, DINGTALK_CONVERSATIONS_METHOD]);
  });

  it("falls back to the local Host when the DingTalk route is absent", async () => {
    const localCalls: string[] = [];
    const local = manager(localCalls, { status: status() });
    const client = createRendererDingTalkClient({
      forHost: (hostId) => (hostId === "local" ? route("local", local) : null),
    });

    await client.messages({ conversationId: "cid", limit: 30 });
    expect(localCalls).toEqual([DINGTALK_STATUS_METHOD, DINGTALK_MESSAGES_METHOD]);
  });

  it("subscribes to change notifications on the routed Host only", async () => {
    const local = manager([], { status: status() });
    const remote = manager([]);
    const client = createRendererDingTalkClient({
      forHost: (hostId) =>
        hostId === "local"
          ? route("local", local)
          : hostId === "host-tencent"
            ? route("host-tencent", remote)
            : null,
      notificationTarget: new EventTarget(),
    });
    const seen: (string | null)[] = [];
    client.subscribe((conversationId) => seen.push(conversationId));
    await client.status();
    await client.conversations();

    local.listener?.({ params: { conversationId: "local-only" } });
    remote.listener?.({ params: { conversationId: "remote" } });
    expect(seen).toEqual(["remote"]);
  });

  it("re-resolves the data Host for a new page session", async () => {
    const localCalls: string[] = [];
    const remoteCalls: string[] = [];
    let localStatus = status();
    const local = manager(localCalls, { status: () => localStatus });
    const remote = manager(remoteCalls);
    const client = createRendererDingTalkClient({
      forHost: (hostId) =>
        hostId === "local"
          ? route("local", local)
          : hostId === "host-tencent"
            ? route("host-tencent", remote)
            : null,
    });
    await client.status();
    await client.conversations();
    expect(remoteCalls).toEqual([DINGTALK_STATUS_METHOD, DINGTALK_CONVERSATIONS_METHOD]);

    localStatus = status({ defaultHost: "local", defaultHostId: null });
    client.beginSession();
    await client.status();
    await client.conversations();
    expect(remoteCalls).toHaveLength(2);
    expect(localCalls.filter((method) => method === DINGTALK_CONVERSATIONS_METHOD)).toHaveLength(1);
  });

  it("sends members and the active view state to the routed Host", async () => {
    const local = manager([], { status: status() });
    const requests: { method: string; params: unknown }[] = [];
    const remote: RendererDingTalkManager = {
      async sendRequest(method, params) {
        requests.push({ method, params });
        if (method === DINGTALK_STATUS_METHOD) return status();
        if (method === DINGTALK_MEMBERS_METHOD) {
          return {
            available: true,
            members: [{ openDingTalkId: "open-1", name: "王鹏远" }],
            errorCode: null,
          };
        }
        return {};
      },
    };
    const client = createRendererDingTalkClient({
      forHost: (hostId) =>
        hostId === "local"
          ? route("local", local)
          : hostId === "host-tencent"
            ? route("host-tencent", remote)
            : null,
    });
    await client.status();
    expect(await client.members("cidA==")).toMatchObject({
      members: [{ openDingTalkId: "open-1", name: "王鹏远" }],
    });
    await client.markViewed("cidA==", 1_700_000_000_000, false);
    expect(requests.map(({ method }) => method)).toEqual([
      DINGTALK_STATUS_METHOD,
      DINGTALK_MEMBERS_METHOD,
      DINGTALK_VIEWED_METHOD,
    ]);
    expect(requests[1]?.params).toEqual({ conversationId: "cidA==" });
    expect(requests[2]?.params).toEqual({
      conversationId: "cidA==",
      lastMessageAt: 1_700_000_000_000,
      active: false,
    });
  });
});

describe("DingTalk change notifications", () => {
  it("uses the documented notification method", () => {
    expect(DINGTALK_CHANGED_METHOD).toBe("codexhost/dingtalk/changed");
  });
});

it("does not gate the first unread read on a pending auth status", async () => {
  const calls: string[] = [];
  const local = manager(calls);
  const original = local.sendRequest.bind(local);
  local.sendRequest = async (method, params, options) =>
    method === DINGTALK_STATUS_METHOD ? new Promise(() => {}) : original(method, params, options);
  const client = createRendererDingTalkClient({ forHost: () => route("local", local) });
  expect((await client.conversations()).available).toBe(true);
  expect(calls).toEqual([DINGTALK_CONVERSATIONS_METHOD]);
});
