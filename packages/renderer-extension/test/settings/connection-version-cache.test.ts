import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readCachedHarnessVersion,
  writeCachedHarnessVersion,
} from "../../src/settings/connection-version-cache.js";

const state = {
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  updateAvailable: true,
  canUpdate: true,
};

let values = new Map<string, string>();

beforeEach(() => {
  values = new Map();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connection version cache", () => {
  it("round-trips a check per Host and expires after several hours", () => {
    writeCachedHarnessVersion("local", "pi", state, 1_000);
    expect(readCachedHarnessVersion("local", "pi", 1_000 + 60_000)).toEqual({
      state,
      checkedAt: 1_000,
      fresh: true,
    });
    expect(readCachedHarnessVersion("local", "pi", 1_000 + 6 * 60 * 60_000 + 1)?.fresh).toBe(false);
    expect(readCachedHarnessVersion("remote", "pi", 1_000)).toBeUndefined();
  });

  it("ignores a tampered state and bounds the oldest entries", () => {
    values.set(
      "codexhost.connection.versions.v1",
      JSON.stringify({
        version: 1,
        entries: { pi: { checkedAt: 1, state: { currentVersion: "1" } } },
      }),
    );
    expect(readCachedHarnessVersion("local", "pi")).toBeUndefined();

    for (let index = 0; index < 40; index += 1) {
      writeCachedHarnessVersion("local", `agent-${index}`, state, 1_000 + index);
    }
    expect(readCachedHarnessVersion("local", "agent-0", 2_000)).toBeUndefined();
    expect(readCachedHarnessVersion("local", "agent-39", 2_000)?.state).toEqual(state);
  });
});
