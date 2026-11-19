import { describe, expect, it, vi } from "vitest";
import type { SkillsHubRequest } from "@codexhost/shared-contracts";
import { createRendererSkillsClient } from "../src/renderer-skills-client.js";

function machine(hostId: string) {
  return {
    hostId,
    name: hostId,
    inventory: { skills: [], agents: [], warnings: [] },
    error: null,
  };
}

describe("Renderer skills routing", () => {
  it("asks each machine's own Host for its status and keeps the configured machine id", async () => {
    const request = vi.fn(async (machineId: string, params: SkillsHubRequest) => {
      if (params.op === "status") return { machines: [machine(params.hostId ?? "local")] };
      if (params.op === "link-plan")
        return {
          id: "00000000-0000-4000-8000-000000000001",
          hostId: machineId,
          actions: [],
          warnings: [],
        };
      if (params.op === "sync-plan")
        return { id: "00000000-0000-4000-8000-000000000001", actions: [], conflicts: [] };
      throw new Error("unexpected_request");
    });
    const client = createRendererSkillsClient({ request });

    const remote = await client.status("oracle-main");
    expect(remote.hostId).toBe("oracle-main");
    expect(request).toHaveBeenCalledWith("oracle-main", { op: "status", hostId: "local" });

    await client.linkPlan("oracle-main");
    expect(request).toHaveBeenLastCalledWith("oracle-main", {
      op: "link-plan",
      hostId: "oracle-main",
    });

    await client.syncPlan({ op: "sync-plan", mode: "fill", skill: "--all", to: ["oracle-main"] });
    expect(request).toHaveBeenLastCalledWith("local", {
      op: "sync-plan",
      mode: "fill",
      skill: "--all",
      to: ["oracle-main"],
    });
  });

  it("lists configured machines through the local Host", async () => {
    const request = vi.fn(async () => ({
      hosts: [
        { hostId: "local", name: "Mac" },
        { hostId: "oracle-main", name: "oracle-main" },
      ],
    }));
    const client = createRendererSkillsClient({ request });
    expect(await client.hosts()).toEqual([
      { hostId: "local", name: "Mac" },
      { hostId: "oracle-main", name: "oracle-main" },
    ]);
    expect(request).toHaveBeenCalledWith("local", { op: "hosts" });
  });
});
