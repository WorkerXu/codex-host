import { describe, expect, it, vi } from "vitest";

import { joinMirroredProjectSection } from "../src/renderer-project-mirror-section.js";

function transition() {
  return {
    createSection: vi.fn(async ({ hostId }: { hostId: string }) => ({
      id: `native-${hostId}`,
    })),
    saveReplica: vi.fn(async () => "applied" as const),
    complete: vi.fn(async () => undefined),
    [Symbol.dispose]: vi.fn(),
  };
}

function savedSections(sections: unknown[]) {
  return {
    "sidebar-custom-sections-v3": {
      "account-1": {
        sections,
        collapsedSectionIds: [],
        sectionOrder: sections.map((section) => `custom:${(section as { id: string }).id}`),
      },
    },
  };
}

describe("mirrored project sections", () => {
  it("moves the remote project into the section that already holds the source", async () => {
    const next = transition();
    const apply = vi.fn(async () => ({ status: "applied", transition: next }));
    const outcome = await joinMirroredProjectSection({
      services: {
        applicationState: {
          read: async () => ({
            value: savedSections([
              {
                id: "section-1",
                name: "AI工作台",
                hostSectionIds: { local: "native-local", "remote-host": "native-remote" },
                itemKeys: ["codex:project:source"],
              },
            ]),
          }),
        },
        savedCustomSections: { applySavedCustomSectionCommand: apply },
      },
      sourceProjectId: "source",
      remoteProjectId: "remote",
      projectName: "项目验收",
      targetHostId: "remote-host",
    });
    expect(outcome).toBe("joined");
    expect(apply).toHaveBeenCalledWith({
      accountId: "account-1",
      operationId: expect.any(String),
      command: { type: "move", sectionId: "section-1", itemKey: "codex:project:remote" },
      requiresServerWork: true,
    });
    expect(next.createSection).not.toHaveBeenCalled();
    expect(next.complete).toHaveBeenCalledTimes(1);
  });

  it("creates a section named after the project and materialises both replicas", async () => {
    const next = transition();
    const apply = vi.fn(async () => ({ status: "applied", transition: next }));
    const outcome = await joinMirroredProjectSection({
      services: {
        applicationState: { read: async () => ({ value: savedSections([]) }) },
        savedCustomSections: { applySavedCustomSectionCommand: apply },
      },
      sourceProjectId: "source",
      remoteProjectId: "remote",
      projectName: "项目验收",
      targetHostId: "remote-host",
    });
    expect(outcome).toBe("created");
    expect((apply.mock.calls[0]?.[0] as { accountId: string }).accountId).toBe("account-1");
    const command = (apply.mock.calls[0]?.[0] as { command: Record<string, unknown> }).command;
    expect(command).toMatchObject({
      type: "create",
      name: "项目验收",
      itemKeys: ["codex:project:source", "codex:project:remote"],
      legacy: false,
    });
    expect(typeof command.sectionId).toBe("string");
    expect(next.createSection.mock.calls.map(([input]) => input.hostId)).toEqual([
      "local",
      "remote-host",
    ]);
    expect(next.saveReplica).toHaveBeenCalledTimes(2);
    expect(next.complete).toHaveBeenCalledTimes(1);
  });

  it("adds the missing replica while reusing the source section", async () => {
    const next = transition();
    const outcome = await joinMirroredProjectSection({
      services: {
        applicationState: {
          read: async () => ({
            value: savedSections([
              {
                id: "section-1",
                name: "AI工作台",
                hostSectionIds: { local: "native-local" },
                itemKeys: ["codex:project:source"],
              },
            ]),
          }),
        },
        savedCustomSections: {
          applySavedCustomSectionCommand: async () => ({ status: "applied", transition: next }),
        },
      },
      sourceProjectId: "source",
      remoteProjectId: "remote",
      projectName: "项目验收",
      targetHostId: "remote-host",
    });
    expect(outcome).toBe("joined");
    expect(next.createSection).toHaveBeenCalledWith({
      hostId: "remote-host",
      logicalSectionId: "section-1",
      name: "AI工作台",
    });
    expect(next.saveReplica).toHaveBeenCalledWith({
      sectionId: "section-1",
      hostId: "remote-host",
      replicaId: "native-remote-host",
    });
  });

  it("reports an unchanged placement without a transition", async () => {
    await expect(
      joinMirroredProjectSection({
        services: {
          applicationState: { read: async () => ({ value: savedSections([]) }) },
          savedCustomSections: {
            applySavedCustomSectionCommand: async () => ({ status: "unchanged" }),
          },
        },
        sourceProjectId: "source",
        remoteProjectId: "remote",
        projectName: "项目验收",
        targetHostId: "remote-host",
      }),
    ).resolves.toBe("unchanged");
  });

  it("fails closed without an account to write the section into", async () => {
    await expect(
      joinMirroredProjectSection({
        services: {
          applicationState: { read: async () => ({ value: {} }) },
          savedCustomSections: { applySavedCustomSectionCommand: async () => ({}) },
        },
        sourceProjectId: "source",
        remoteProjectId: "remote",
        projectName: "项目验收",
        targetHostId: "remote-host",
      }),
    ).rejects.toThrow("无法确定当前账号");
  });

  it("fails closed when Desktop exposes no section service", async () => {
    await expect(
      joinMirroredProjectSection({
        services: {},
        sourceProjectId: "source",
        remoteProjectId: "remote",
        projectName: "项目验收",
        targetHostId: "remote-host",
      }),
    ).rejects.toThrow("分区服务不可用");
  });
});
