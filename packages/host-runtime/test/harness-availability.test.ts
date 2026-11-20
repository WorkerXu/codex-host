import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { HarnessAdapter, HarnessInspection } from "@codexhost/harness-adapter";
import type { ExternalHarnessId } from "@codexhost/protocol-core";
import { expect, it } from "vitest";

import { HarnessAvailability } from "../src/harness-availability.js";
import { HarnessAvailabilityStore } from "../src/harness-availability-store.js";

it("reads disk availability, refreshes it, and evicts it after a failed start", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-harness-availability-"));
  const environment = { CODEXHOST_USER_DIR: directory };
  try {
    await new HarnessAvailabilityStore(environment).set("pi", {
      status: "ready",
      checkedAt: Date.now(),
    });
    const availability = new HarnessAvailability(environment, []);
    const unavailable: HarnessInspection = {
      status: "notInstalled",
      error: { code: "notInstalled", message: "Not installed", retryable: false },
    };
    const adapters = new Map<ExternalHarnessId, HarnessAdapter>([
      ["pi", { inspect: async () => unavailable } as HarnessAdapter],
    ]);
    await expect(availability.list(adapters, false)).resolves.toMatchObject({ pi: "ready" });
    await expect(availability.list(adapters, true)).resolves.toMatchObject({ pi: "notInstalled" });
    expect(await new HarnessAvailabilityStore(environment).get("pi")).toMatchObject({
      status: "notInstalled",
    });
    await availability.invalidate("pi");
    expect(await availability.cached(adapters.keys())).toEqual({});
    await expect(new HarnessAvailabilityStore(environment).get("pi")).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
