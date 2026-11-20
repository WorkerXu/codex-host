import { harnessIdSchema } from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readCachedAccountPresentation,
  writeCachedAccountPresentation,
} from "../../src/settings/account-presentation-cache.js";

const credits = {
  usedPercent: 42,
  periodType: "weekly" as const,
};
const harnessAccount = {
  harnessId: harnessIdSchema.parse("claude-code"),
  harnessName: "Claude Code",
  email: "person@example.com",
  credits,
};
const codex = {
  version: 2 as const,
  currentAccountId: "account-1",
  phase: "ready" as const,
  revision: 3,
  accounts: [{ accountId: "account-1", label: "Main" }],
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

describe("account presentation cache", () => {
  it("round-trips the last account list, Harness rows and quotas per Host", () => {
    writeCachedAccountPresentation("local", {
      codex,
      harness: { accounts: [harnessAccount], observedAt: 1_000 },
      usage: {
        "account-1": { credits, observedAt: "2026-11-19T03:00:00.000Z" },
      },
    });
    expect(readCachedAccountPresentation("local")).toEqual({
      codex,
      harness: { accounts: [harnessAccount], observedAt: 1_000 },
      usage: {
        "account-1": { credits, observedAt: "2026-11-19T03:00:00.000Z" },
      },
    });
    expect(readCachedAccountPresentation("remote")).toEqual({
      codex: null,
      harness: null,
      usage: {},
    });
  });

  it("drops malformed rows without discarding the rest", () => {
    values.set(
      "codexhost.accounts.presentation.v1",
      JSON.stringify({
        version: 1,
        codex: { version: 2, accounts: [{ accountId: "bad" }] },
        harness: { accounts: [harnessAccount, { harnessId: "broken" }], observedAt: 5 },
        usage: { good: { credits }, bad: { credits: { usedPercent: 500 } } },
      }),
    );
    expect(readCachedAccountPresentation("local")).toMatchObject({
      codex: null,
      harness: null,
      usage: { good: { credits, observedAt: null } },
    });
  });
});
