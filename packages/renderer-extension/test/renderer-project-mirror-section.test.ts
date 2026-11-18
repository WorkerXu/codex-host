import { describe, expect, it, vi } from "vitest";

import { joinMirroredProjectSection } from "../src/renderer-project-mirror-section.js";
import type { MirrorSectionServices } from "../src/renderer-project-mirror-section.js";
import type { NativeSectionApi, NativeSectionScope } from "../src/codex-native-sections.js";

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
    const apply = vi.fn(async (input: unknown) => {
      void input;
      return { status: "applied", transition: next };
    });
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
    const apply = vi.fn(async (input: unknown) => {
      void input;
      return { status: "applied", transition: next };
    });
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

/**
 * Builds the shape the real Desktop exposes: a plain `appServices` registry whose services are
 * callable stubs and no `savedCustomSections`. Sections live only in the native sidebar atom,
 * which the injected scope reads and the injected commands write.
 */
function nativeSidebar(initial: Array<{ id: string; name: string; itemKeys: string[] }>) {
  const state = { sections: initial.map((section) => ({ ...section, hostSectionIds: {} })) };
  const api = {
    QV: { atom: "sections" },
    Jn: vi.fn((_scope: NativeSectionScope, name: string, itemKeys: string[]) => {
      const id = `section-${state.sections.length + 1}`;
      state.sections = state.sections.map((section) => ({
        ...section,
        itemKeys: section.itemKeys.filter((key) => !itemKeys.includes(key)),
      }));
      state.sections.push({ id, name, itemKeys: [...itemKeys], hostSectionIds: {} });
      return id;
    }),
    f2: vi.fn((_scope: NativeSectionScope, sectionId: string, itemKey: string) => {
      state.sections = state.sections.map((section) => ({
        ...section,
        itemKeys: section.itemKeys.filter((key) => key !== itemKey),
      }));
      const target = state.sections.find((section) => section.id === sectionId);
      target?.itemKeys.unshift(itemKey);
    }),
  } satisfies NativeSectionApi;
  const scope: NativeSectionScope = {
    get: (atom) => (atom === api.QV ? state.sections : undefined),
  };
  const services = {
    applicationState: Object.assign(
      () => {
        throw new Error("The native branch must not read the persisted atom itself");
      },
      {
        read: vi.fn(async () => {
          throw new Error("The native branch must not read the persisted atom itself");
        }),
      },
    ),
  };
  return { state, api, scope, services };
}

const nativeInput = (services: MirrorSectionServices) => ({
  services,
  ownerWindow: {} as Window,
  sourceProjectId: "source",
  remoteProjectId: "remote",
  projectName: "项目验收",
  targetHostId: "remote-host",
});

describe("native sidebar section placement", () => {
  it("creates one section containing both projects through the native create command", async () => {
    const sidebar = nativeSidebar([]);
    const outcome = await joinMirroredProjectSection(nativeInput(sidebar.services), {
      loadSections: async () => sidebar.api,
      findScope: () => sidebar.scope,
    });
    expect(outcome).toBe("created");
    expect(sidebar.api.Jn).toHaveBeenCalledExactlyOnceWith(sidebar.scope, "项目验收", [
      "codex:project:source",
      "codex:project:remote",
    ]);
    expect(sidebar.api.f2).not.toHaveBeenCalled();
    expect(sidebar.state.sections).toEqual([
      {
        id: "section-1",
        name: "项目验收",
        itemKeys: ["codex:project:source", "codex:project:remote"],
        hostSectionIds: {},
      },
    ]);
  });

  it("moves the remote project into the section that holds the source", async () => {
    const sidebar = nativeSidebar([
      { id: "section-1", name: "AI工作台", itemKeys: ["codex:project:source"] },
    ]);
    const outcome = await joinMirroredProjectSection(nativeInput(sidebar.services), {
      loadSections: async () => sidebar.api,
      findScope: () => sidebar.scope,
    });
    expect(outcome).toBe("joined");
    expect(sidebar.api.f2).toHaveBeenCalledExactlyOnceWith(
      sidebar.scope,
      "section-1",
      "codex:project:remote",
    );
    expect(sidebar.api.Jn).not.toHaveBeenCalled();
    expect(sidebar.state.sections[0]?.itemKeys).toEqual([
      "codex:project:remote",
      "codex:project:source",
    ]);
  });

  it("reports an unchanged placement when the section already holds both projects", async () => {
    const sidebar = nativeSidebar([
      {
        id: "section-1",
        name: "AI工作台",
        itemKeys: ["codex:project:source", "codex:project:remote"],
      },
    ]);
    await expect(
      joinMirroredProjectSection(nativeInput(sidebar.services), {
        loadSections: async () => sidebar.api,
        findScope: () => sidebar.scope,
      }),
    ).resolves.toBe("unchanged");
    expect(sidebar.api.Jn).not.toHaveBeenCalled();
    expect(sidebar.api.f2).not.toHaveBeenCalled();
  });

  it("fails closed without inventing state when the native command changes nothing", async () => {
    const sidebar = nativeSidebar([
      { id: "section-1", name: "AI工作台", itemKeys: ["codex:project:source"] },
    ]);
    sidebar.api.f2.mockImplementation(() => undefined);
    await expect(
      joinMirroredProjectSection(nativeInput(sidebar.services), {
        loadSections: async () => sidebar.api,
        findScope: () => sidebar.scope,
      }),
    ).rejects.toThrow("分区服务不可用");
    expect(sidebar.state.sections[0]?.itemKeys).toEqual(["codex:project:source"]);
  });

  it("fails closed when the native section module or AppScope is unavailable", async () => {
    const sidebar = nativeSidebar([]);
    await expect(
      joinMirroredProjectSection(nativeInput(sidebar.services), {
        loadSections: async () => null,
        findScope: () => sidebar.scope,
      }),
    ).rejects.toThrow("分区服务不可用");
    await expect(
      joinMirroredProjectSection(nativeInput(sidebar.services), {
        loadSections: async () => sidebar.api,
        findScope: () => null,
      }),
    ).rejects.toThrow("分区服务不可用");
    expect(sidebar.api.Jn).not.toHaveBeenCalled();
  });

  it("fails closed when the sections atom cannot be read", async () => {
    const sidebar = nativeSidebar([]);
    const scope: NativeSectionScope = { get: () => undefined };
    await expect(
      joinMirroredProjectSection(nativeInput(sidebar.services), {
        loadSections: async () => sidebar.api,
        findScope: () => scope,
      }),
    ).rejects.toThrow("无法读取侧栏分区");
    expect(sidebar.api.Jn).not.toHaveBeenCalled();
  });
});
