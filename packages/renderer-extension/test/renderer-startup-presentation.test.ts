import {
  harnessModelRefSchema,
  harnessPluginDescriptorSchema,
  harnessThinkingOptionIdSchema,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  compactModelCatalog,
  readCachedThreadPresentation,
  writeCachedThreadPresentation,
} from "../src/renderer-thread-presentation-cache.js";
import {
  harnessArtworkKey,
  readCachedHarnessDirectory,
  writeCachedHarnessDirectory,
} from "../src/renderer-harness-directory-cache.js";
import { createSidebarOwnershipStore } from "../src/renderer-sidebar-ownership-cache.js";
import { createRendererStartupTrace } from "../src/renderer-startup-trace.js";

const modelA = harnessModelRefSchema.parse({ id: "model-a" });
const modelB = harnessModelRefSchema.parse({ id: "model-b" });
const modelC = harnessModelRefSchema.parse({ id: "model-c" });
const high = harnessThinkingOptionIdSchema.parse("high");

function catalog() {
  return {
    models: [
      { ref: modelA, label: "Model A" },
      { ref: modelB, label: "Model B", supportedThinkingOptionIds: [high] },
      { ref: modelC, label: "Model C" },
    ],
    defaultModel: modelA,
    thinkingOptions: [
      { id: harnessThinkingOptionIdSchema.parse("off"), label: "Off" },
      { id: high, label: "High" },
    ],
  };
}

let storedValues = new Map<string, string>();

function installStorage(): Map<string, string> {
  const values = new Map<string, string>();
  storedValues = values;
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  return values;
}

beforeEach(() => installStorage());

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cached Thread footer presentation", () => {
  it("names a Model and Thinking from a compact Catalog", () => {
    const compact = compactModelCatalog(catalog(), modelB, high);
    expect(compact).toEqual({
      models: [{ ref: modelB, label: "Model B", supportedThinkingOptionIds: [high] }],
      defaultModel: modelB,
      thinkingOptions: [{ id: high, label: "High" }],
    });
  });

  it("round-trips the last presentation per Host and Thread", () => {
    writeCachedThreadPresentation("local", "thread-a", {
      agent: "claude-code",
      model: modelB,
      thinkingOptionId: high,
      catalog: catalog(),
    });
    expect(readCachedThreadPresentation("local", "thread-a")).toEqual({
      agent: "claude-code",
      model: modelB,
      thinkingOptionId: high,
      catalog: {
        models: [{ ref: modelB, label: "Model B", supportedThinkingOptionIds: [high] }],
        defaultModel: modelB,
        thinkingOptions: [{ id: high, label: "High" }],
      },
    });
    expect(readCachedThreadPresentation("local", "thread-b")).toBeUndefined();
    expect(readCachedThreadPresentation("remote", "thread-a")).toBeUndefined();
  });

  it("ignores a Model that the stored Catalog cannot name", () => {
    expect(compactModelCatalog({ models: [], thinkingOptions: [] }, modelA)).toBeUndefined();
  });

  it("keeps the newest Threads within its bound", () => {
    for (let index = 0; index < 70; index += 1) {
      writeCachedThreadPresentation("local", `thread-${index}`, {
        agent: "pi",
        model: modelA,
        catalog: catalog(),
      });
    }
    expect(readCachedThreadPresentation("local", "thread-0")).toBeUndefined();
    expect(readCachedThreadPresentation("local", "thread-69")).toBeDefined();
  });
});

describe("Cached Harness directory", () => {
  const plugin = harnessPluginDescriptorSchema.parse({
    id: "claude-code",
    name: "Claude Code",
    version: "1",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    iconStyle: {
      vector: { viewBox: "0 0 24 24", color: "currentColor", paths: [{ d: "M0 0h4v4z" }] },
    },
  });

  it("keys artwork by plugin id, version and image identity", () => {
    const changedIcon = { ...plugin, icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" };
    const changedVersion = { ...plugin, version: "2" };
    expect(harnessArtworkKey(changedIcon)).not.toBe(harnessArtworkKey(plugin));
    expect(harnessArtworkKey(changedVersion)).not.toBe(harnessArtworkKey(plugin));
    expect(harnessArtworkKey({ ...plugin })).toBe(harnessArtworkKey(plugin));
  });

  it("round-trips the directory, availability and fingerprint per Host", () => {
    writeCachedHarnessDirectory("local", {
      fingerprint: "fingerprint-1",
      plugins: [plugin],
      availability: {
        "claude-code": "ready",
        removed: "unavailable",
      },
      webUi: { "claude-code": true },
    });
    expect(readCachedHarnessDirectory("local")).toEqual({
      fingerprint: "fingerprint-1",
      plugins: [plugin],
      availability: { "claude-code": "ready" },
      webUi: { "claude-code": true },
    });
    expect(readCachedHarnessDirectory("remote")).toBeUndefined();
  });

  it("drops a tampered artwork key", () => {
    writeCachedHarnessDirectory("local", {
      fingerprint: "fingerprint-1",
      plugins: [plugin],
      availability: {},
      webUi: {},
    });
    const stored = JSON.parse(storedValues.get("codexhost.harness-directory.v1") ?? "{}") as {
      plugins: Array<{ key: string }>;
    };
    const first = stored.plugins[0];
    if (first) first.key = "claude-code@1#wrong";
    storedValues.set("codexhost.harness-directory.v1", JSON.stringify(stored));
    expect(readCachedHarnessDirectory("local")).toBeUndefined();
  });

  it("keeps the name but not an oversized image", () => {
    const oversized = {
      ...plugin,
      icon: `data:image/png;base64,${"A".repeat(70 * 1024)}`,
    };
    writeCachedHarnessDirectory("local", {
      fingerprint: null,
      plugins: [oversized],
      availability: {},
      webUi: {},
    });
    expect(readCachedHarnessDirectory("local")?.plugins).toEqual([
      { id: plugin.id, name: plugin.name, version: plugin.version, iconStyle: plugin.iconStyle },
    ]);
  });
});

describe("Cached sidebar ownership", () => {
  it("round-trips per Host and bounds the oldest entries", () => {
    const store = createSidebarOwnershipStore();
    store.write("local", [
      ["thread-a", "claude-code"],
      ["thread-b", "codex"],
    ]);
    expect(store.read("local")).toEqual(
      new Map([
        ["thread-a", "claude-code"],
        ["thread-b", "codex"],
      ]),
    );
    expect(store.read("remote").size).toBe(0);

    const entries: Array<[string, string]> = [];
    for (let index = 0; index < 401; index += 1) entries.push([`bulk-${index}`, "pi"]);
    store.write("local", entries);
    const stored = store.read("local");
    expect(stored.size).toBe(400);
    expect(stored.has("thread-a")).toBe(false);
    expect(stored.has("bulk-0")).toBe(false);
    expect(stored.has("bulk-1")).toBe(true);
    expect(stored.has("bulk-400")).toBe(true);
  });
});

describe("Renderer startup trace", () => {
  it("records each milestone once and bounds request samples", async () => {
    let now = 100;
    const trace = createRendererStartupTrace(() => now);
    trace.routingReady("local");
    now = 250;
    trace.routingReady("local");
    trace.firstRows(19);
    now = 300;
    trace.firstRows(19);
    trace.iconsRendered(13, 19);
    trace.modelControl("composer-1", "claude-code", "cache");
    now = 400;
    trace.iconsRendered(19, 19);
    trace.modelControl("composer-1", "claude-code", "inspect");

    for (let index = 0; index < 30; index += 1) {
      now = 500 + index * 10;
      await trace.measureRequest(
        { method: "thread/inspect", hostId: "local", priority: "interactive" },
        async () => undefined,
      );
    }

    const status = trace.snapshot();
    expect(status.startedAtMs).toBe(100);
    expect(status.routingReadyMs).toEqual({ local: 100 });
    expect(status.firstRowsMs).toBe(250);
    expect(status.allIconsMs).toBe(400);
    expect(status.composers).toEqual({
      "composer-1": { agent: "claude-code", namedAtMs: 300, readyAtMs: 400 },
    });
    expect(status.requests).toHaveLength(24);
    expect(status.requests.at(-1)).toMatchObject({
      method: "thread/inspect",
      hostId: "local",
      priority: "interactive",
      ok: true,
      durationMs: 0,
    });
  });

  it("records a failed critical request without hiding the error", async () => {
    const trace = createRendererStartupTrace(() => 10);
    await expect(
      trace.measureRequest(
        { method: "harness/inspect", hostId: "remote", priority: "interactive" },
        async () => {
          throw new Error("unavailable");
        },
      ),
    ).rejects.toThrow("unavailable");
    expect(trace.snapshot().requests).toEqual([
      expect.objectContaining({ method: "harness/inspect", hostId: "remote", ok: false }),
    ]);
  });
});
