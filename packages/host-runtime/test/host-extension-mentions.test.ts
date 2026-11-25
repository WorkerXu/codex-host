import {
  HOST_EXTENSION_MENTION_MAX_EXPANDED_CHARS,
  formatHostExtensionMentionToken,
  type HostExtensionMentionSource,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  HostExtensionMentions,
  type HostExtensionMentionBackend,
  type HostExtensionMentionBackendResolution,
} from "../src/host-extension-mentions.js";

const source = {
  id: "demo",
  label: { en: "Demo mentions", "zh-CN": "示例提及" },
} satisfies HostExtensionMentionSource;
const requestId = "00000000-0000-4000-8000-000000000000";

function token(itemId: string, label = itemId): string {
  return formatHostExtensionMentionToken({
    extensionId: "sample",
    sourceId: source.id,
    itemId,
    label,
  });
}

function fixture(
  invoke: HostExtensionMentionBackend["invoke"],
  resolve: () => Promise<HostExtensionMentionBackendResolution> = async () => ({
    backend: {
      id: "sample",
      sources: [source],
      invoke,
    },
  }),
) {
  return new HostExtensionMentions({
    listBackends: async () => [{ id: "sample", sources: [source], invoke }],
    resolveBackend: resolve,
    diagnose: () => undefined,
  });
}

async function searchUntilReady(mentions: HostExtensionMentions, query: string) {
  let reply = await mentions.search({ requestId, query });
  while (reply.pending) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    reply = await mentions.search({ requestId, query });
  }
  return reply;
}

describe("Host extension mentions", () => {
  it("expands every occurrence and sends one batched backend request", async () => {
    const invoke = vi.fn(async (method: string, params: unknown) => {
      expect(method).toBe("mentions/expand");
      expect(params).toEqual({
        mentions: [{ sourceId: "demo", itemId: "alpha", label: "Alpha" }],
      });
      return {
        expansions: [{ sourceId: "demo", itemId: "alpha", text: "expanded alpha" }],
      };
    });
    const mentions = fixture(invoke);
    await expect(
      mentions.expandTexts([`one ${token("alpha", "Alpha")} two ${token("alpha", "Alpha")}`]),
    ).resolves.toEqual(["one expanded alpha two expanded alpha"]);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("rejects the whole message when the extension fails", async () => {
    const mentions = fixture(async () => {
      throw new Error("synthetic lookup failure");
    });
    await expect(mentions.expandTexts([`before ${token("alpha")} after`])).rejects.toThrow(
      /synthetic lookup failure.*message was not sent/u,
    );
  });

  it("rejects an incomplete or oversized expansion", async () => {
    const incomplete = fixture(async () => ({ expansions: [] }));
    await expect(incomplete.expandTexts([token("alpha")])).rejects.toThrow(/incomplete expansion/u);
    const oversized = fixture(async (_method, params) => ({
      expansions: (params as { mentions: Array<{ itemId: string }> }).mentions.map(
        ({ itemId }) => ({
          sourceId: "demo",
          itemId,
          text: "x".repeat(HOST_EXTENSION_MENTION_MAX_EXPANDED_CHARS + 1),
        }),
      ),
    }));
    await expect(oversized.expandTexts([token("alpha")])).rejects.toThrow(
      /Too big: expected string to have <=32768 characters/u,
    );

    const totalLimit = fixture(async (_method, params) => ({
      expansions: (params as { mentions: Array<{ itemId: string }> }).mentions.map(
        ({ itemId }) => ({
          sourceId: "demo",
          itemId,
          text: "x".repeat(HOST_EXTENSION_MENTION_MAX_EXPANDED_CHARS),
        }),
      ),
    }));
    await expect(
      totalLimit.expandTexts([["a", "b", "c", "d", "e"].map((itemId) => token(itemId)).join(" ")]),
    ).rejects.toThrow(/combined expansion exceeds/u);
  });

  it("rejects mentions whose extension is unavailable", async () => {
    const unavailable = fixture(
      async () => ({ expansions: [] }),
      async () => ({
        error: 'extension "sample" is disabled',
      }),
    );
    await expect(unavailable.expandTexts([token("alpha", "Alpha")])).rejects.toThrow(
      /extension "sample" is disabled.*message was not sent/u,
    );
  });

  it("rejects malformed carriers instead of forwarding a raw token", async () => {
    const mentions = fixture(async () => ({ expansions: [] }));
    await expect(
      mentions.expandTexts(["[@Broken](codexhost-extension://mention/v1/not-base64)"]),
    ).rejects.toThrow(/malformed mention token/u);
  });

  it("groups legacy flat search results", async () => {
    const responsive = fixture(async (method) => {
      expect(method).toBe("mentions/search");
      return { items: [{ itemId: "alpha", label: "Alpha" }] };
    });
    await expect(searchUntilReady(responsive, "alp")).resolves.toEqual({
      groups: [
        {
          extensionId: "sample",
          sourceId: "demo",
          label: source.label,
          items: [{ itemId: "alpha", label: "Alpha" }],
        },
      ],
    });
  });

  it("continues through short RPCs beyond the channel deadline and cancels polling", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const started = Date.now();
      const mentions = fixture(async (method, params) => {
        if (method === "mentions/cancel") {
          cancelled = true;
          return { cancelled: true };
        }
        const cursor = (params as { cursor?: string }).cursor;
        return cursor === "ready" && Date.now() - started >= 128_000
          ? { items: [{ itemId: "alpha", label: "Alpha" }] }
          : { pending: { cursor: "ready", retryAfterMs: 4000 } };
      });
      const search = searchUntilReady(mentions, "alp");
      await vi.advanceTimersByTimeAsync(128_500);
      expect((await search).groups[0]?.items).toEqual([{ itemId: "alpha", label: "Alpha" }]);
      const abandoned = mentions.search({ requestId, query: "other" });
      await vi.advanceTimersByTimeAsync(0);
      await mentions.cancel({ requestId });
      expect(await abandoned).toEqual({ groups: [], pending: true });
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("waits without a deadline for a legacy handler and releases it on cancel", async () => {
  vi.useFakeTimers();
  try {
    const mentions = fixture(async (method) => {
      if (method === "mentions/cancel") return { cancelled: true };
      await new Promise((resolve) => setTimeout(resolve, 4000));
      return { items: [{ itemId: "legacy", label: "Legacy" }] };
    });
    const result = searchUntilReady(mentions, "");
    await vi.advanceTimersByTimeAsync(4500);
    expect((await result).groups[0]?.items[0]?.itemId).toBe("legacy");
    const pending = mentions.search({ requestId, query: "" });
    await vi.advanceTimersByTimeAsync(0);
    await mentions.cancel({ requestId });
    expect(await pending).toEqual({ groups: [], pending: true });
  } finally {
    vi.useRealTimers();
  }
});
