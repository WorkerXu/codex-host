import { describe, expect, it } from "vitest";

import {
  DINGTALK_CHANGED_METHOD,
  DINGTALK_CONVERSATIONS_METHOD,
  DINGTALK_MESSAGES_METHOD,
  DINGTALK_STATUS_METHOD,
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
): RendererDingTalkManager & { listener?: (value: unknown) => void } {
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

    await client.conversations();
    expect(localCalls).toEqual([DINGTALK_STATUS_METHOD]);
    expect(remoteCalls).toEqual([DINGTALK_CONVERSATIONS_METHOD]);
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
    await client.conversations();
    expect(remoteCalls).toHaveLength(1);

    localStatus = status({ defaultHost: "local", defaultHostId: null });
    client.beginSession();
    await client.conversations();
    expect(remoteCalls).toHaveLength(1);
    expect(localCalls.filter((method) => method === DINGTALK_CONVERSATIONS_METHOD)).toHaveLength(1);
  });
});

describe("DingTalk change notifications", () => {
  it("uses the documented notification method", () => {
    expect(DINGTALK_CHANGED_METHOD).toBe("codexhost/dingtalk/changed");
  });
});
