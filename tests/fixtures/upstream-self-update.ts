import { vi } from "vitest";

vi.mock(import("@codexhost/shared-contracts/fork-self-update"), async (importOriginal) => ({
  ...(await importOriginal()),
  FORK_SELF_UPDATE_ENABLED: true,
  requireForkSelfUpdate() {},
}));
