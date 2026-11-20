import { describe, expect, it, vi } from "vitest";

import { deleteCodexAgent } from "../../src/settings/agent-delete.js";

describe("Deleting a Codex agent", () => {
  it("removes the exact revision and refreshes cards and DingTalk", async () => {
    const remove = vi.fn(async () => undefined);
    const reload = vi.fn(async () => undefined);

    await expect(
      deleteCodexAgent({
        fileName: "writer.toml",
        revision: "1760000001000-380",
        remove,
        reload,
        isStale: () => false,
      }),
    ).resolves.toEqual({ ok: true, refreshed: true });

    expect(remove).toHaveBeenCalledWith("writer.toml", "1760000001000-380");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the list as-is after an ordinary failure", async () => {
    const reload = vi.fn(async () => undefined);

    await expect(
      deleteCodexAgent({
        fileName: "writer.toml",
        revision: "1-1",
        remove: async () => {
          throw new Error("io_failed");
        },
        reload,
        isStale: () => false,
      }),
    ).resolves.toEqual({ ok: false, refreshed: false });
    expect(reload).not.toHaveBeenCalled();
  });

  it("refreshes when the file changed outside the page", async () => {
    const reload = vi.fn(async () => undefined);

    await expect(
      deleteCodexAgent({
        fileName: "writer.toml",
        revision: "1-1",
        remove: async () => {
          throw new Error("revision_conflict");
        },
        reload,
        isStale: (error) => String(error).includes("revision_conflict"),
      }),
    ).resolves.toEqual({ ok: false, refreshed: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
