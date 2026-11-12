import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installRendererProjectMirror } from "../src/renderer-project-mirror.js";

const fakeWindow = {} as Window & typeof globalThis;

beforeEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("project mirror diagnostics", () => {
  it("starts with an explicit status shape", () => {
    const api = installRendererProjectMirror();
    expect(api.status()).toEqual({
      pickerDetected: false,
      projectEligible: false,
      peersLoaded: 0,
      lastError: null,
      projectSource: null,
      projectReason: "unknown",
      machineCount: 0,
    });
    expect(
      api.consumePending({
        composer: {} as Element,
        hostId: "remote-ssh-discovered:unknown",
        applyHarness: async () => false,
      }),
    ).toBe(false);
    api.dispose();
    expect(fakeWindow.__codexhostProjectMirrorV1).toBeUndefined();
  });
});
