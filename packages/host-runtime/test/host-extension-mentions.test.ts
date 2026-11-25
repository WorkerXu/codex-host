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

  it("groups search results and hides a non-responsive backend", async () => {
    const responsive = fixture(async (method) => {
      expect(method).toBe("mentions/search");
      return { items: [{ itemId: "alpha", label: "Alpha" }] };
    });
    await expect(responsive.search({ requestId, query: "alp", limit: 20 })).resolves.toEqual({
      groups: [
        {
          extensionId: "sample",
          sourceId: "demo",
          label: source.label,
          items: [{ itemId: "alpha", label: "Alpha" }],
        },
      ],
    });

    const silent = new HostExtensionMentions({
      listBackends: async () => [
        { id: "sample", sources: [source], invoke: () => new Promise(() => undefined) },
      ],
      resolveBackend: async () => {
        throw new Error("unused");
      },
      diagnose: () => undefined,
      searchTimeoutMs: 5,
    });
    await expect(silent.search({ requestId, query: "alp" })).resolves.toEqual({ groups: [] });
  });
});
