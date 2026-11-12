import type { ProjectGroup } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  chooseMirrorDestination,
  isNameOnlyProject,
  mirrorDirectoryCandidates,
  planMirrorGroup,
  readComposerProject,
  sanitizeMirrorDirectoryName,
} from "../src/renderer-project-mirror-model.js";

const parent = "/Users/test/Documents/ChatGPT";

function group(name: string, members: ProjectGroup["members"]): ProjectGroup {
  return {
    id: `group-${name}`,
    name,
    order: 0,
    collapsed: false,
    members,
    createdAt: "2026-11-12T03:00:00.000Z",
    updatedAt: "2026-11-12T03:00:00.000Z",
  };
}

describe("name-only project classification", () => {
  it("accepts one root directly under the default parent", () => {
    expect(
      isNameOnlyProject({ id: "p", name: "alpha", rootPaths: [`${parent}/alpha`] }, parent),
    ).toBe(true);
    expect(
      isNameOnlyProject({ id: "p", name: "alpha", rootPaths: [`${parent}/alpha 2`] }, parent),
    ).toBe(true);
  });

  it("rejects multi-root, other parents, and renamed folders", () => {
    expect(
      isNameOnlyProject(
        { id: "p", name: "alpha", rootPaths: [`${parent}/alpha`, "/tmp/beta"] },
        parent,
      ),
    ).toBe(false);
    expect(isNameOnlyProject({ id: "p", name: "alpha", rootPaths: ["/tmp/alpha"] }, parent)).toBe(
      false,
    );
    expect(
      isNameOnlyProject({ id: "p", name: "renamed", rootPaths: [`${parent}/alpha`] }, parent),
    ).toBe(false);
    expect(isNameOnlyProject({ id: "p", name: "alpha", rootPaths: [] }, parent)).toBe(false);
  });

  it("sanitizes invalid characters and keeps Desktop's numbering shape", () => {
    expect(sanitizeMirrorDirectoryName("a/b:c*?")).toBe("a_b_c__");
    expect(sanitizeMirrorDirectoryName("  spaced.  ")).toBe("spaced");
    expect(sanitizeMirrorDirectoryName("")).toBe("New project");
    expect(mirrorDirectoryCandidates(parent, "alpha").slice(0, 3)).toEqual([
      `${parent}/alpha`,
      `${parent}/alpha 2`,
      `${parent}/alpha 3`,
    ]);
  });
});

describe("composer project context", () => {
  it("reads selectedProject from the nearest React fiber", () => {
    const composer = {} as Element;
    Object.defineProperty(composer, "__reactFiber$test", {
      value: {
        memoizedProps: { selectedProject: null },
        return: {
          memoizedProps: {
            selectedProject: { type: "local", projectId: "local-alpha" },
          },
          return: null,
        },
      },
    });
    expect(readComposerProject(composer)).toEqual({
      type: "local",
      projectId: "local-alpha",
    });
  });

  it("returns null without a usable fiber value", () => {
    expect(readComposerProject({} as Element)).toBeNull();
    const composer = {} as Element;
    Object.defineProperty(composer, "__reactFiber$test", {
      value: { memoizedProps: { selectedProject: { type: "local" } }, return: null },
    });
    expect(readComposerProject(composer)).toBeNull();
  });
});

describe("project group planning", () => {
  const source = {
    projectKind: "local" as const,
    projectId: "local-alpha",
    rootPaths: [`${parent}/alpha`],
    label: "alpha",
  };
  const mirror = {
    projectKind: "remote" as const,
    projectId: "remote-alpha",
    hostId: "remote-ssh-discovered:colab",
    remotePath: "/root/Documents/ChatGPT/alpha",
    label: "alpha",
  };

  it("creates a group named after the project", () => {
    const plan = planMirrorGroup({
      groups: [],
      name: "alpha",
      source,
      mirror,
      createId: () => "new-group",
      now: "2026-11-12T03:00:00.000Z",
    });
    expect(plan.action).toBe("created");
    expect(plan.groups[0]).toMatchObject({
      id: "new-group",
      name: "alpha",
      members: [source, mirror],
    });
  });

  it("appends only missing members to an existing same-name group", () => {
    const plan = planMirrorGroup({
      groups: [group("alpha", [source])],
      name: "alpha",
      source,
      mirror,
      createId: () => "unused",
      now: "2026-11-12T03:00:00.000Z",
    });
    expect(plan.action).toBe("appended");
    expect(plan.groups[0]?.members).toEqual([source, mirror]);
  });

  it("skips when either project already belongs to another group", () => {
    const plan = planMirrorGroup({
      groups: [group("other", [mirror])],
      name: "alpha",
      source,
      mirror,
      createId: () => "unused",
      now: "2026-11-12T03:00:00.000Z",
    });
    expect(plan.action).toBe("skipped-other-group");
    expect(plan.groups).toHaveLength(1);
  });
});

describe("mirror destination choice", () => {
  const directoryState =
    (states: Record<string, "directory" | "missing" | "other">) =>
    async (path: string): Promise<"directory" | "missing" | "other"> =>
      states[path] ?? "missing";

  it("reuses a registered mirror project", async () => {
    await expect(
      chooseMirrorDestination({
        name: "alpha",
        hostId: "remote-ssh-discovered:colab",
        candidates: [`${parent}/alpha`],
        known: {
          hostId: "remote-ssh-discovered:colab",
          remotePath: `${parent}/alpha`,
          remoteProjectId: "remote-alpha",
        },
        desktopProjects: [{ id: "remote-alpha", label: "alpha", remotePath: `${parent}/alpha` }],
        appProjects: [],
        directoryState: directoryState({}),
      }),
    ).resolves.toEqual({ path: `${parent}/alpha`, projectId: "remote-alpha" });
  });

  it("skips a path owned by a differently named project", async () => {
    await expect(
      chooseMirrorDestination({
        name: "alpha",
        hostId: "remote-ssh-discovered:colab",
        candidates: [`${parent}/alpha`, `${parent}/alpha 2`],
        known: null,
        desktopProjects: [{ id: "other", label: "other", remotePath: `${parent}/alpha` }],
        appProjects: [],
        directoryState: directoryState({ [`${parent}/alpha`]: "directory" }),
      }),
    ).resolves.toEqual({ path: `${parent}/alpha 2`, projectId: null });
  });

  it("reuses an existing directory without a project", async () => {
    await expect(
      chooseMirrorDestination({
        name: "alpha",
        hostId: "remote-ssh-discovered:colab",
        candidates: [`${parent}/alpha`],
        known: null,
        desktopProjects: [],
        appProjects: [],
        directoryState: directoryState({ [`${parent}/alpha`]: "directory" }),
      }),
    ).resolves.toEqual({ path: `${parent}/alpha`, projectId: null });
  });

  it("skips a file and uses the next numbered directory", async () => {
    await expect(
      chooseMirrorDestination({
        name: "alpha",
        hostId: "remote-ssh-discovered:colab",
        candidates: [`${parent}/alpha`, `${parent}/alpha 2`],
        known: null,
        desktopProjects: [],
        appProjects: [],
        directoryState: directoryState({ [`${parent}/alpha`]: "other" }),
      }),
    ).resolves.toEqual({ path: `${parent}/alpha 2`, projectId: null });
  });
});
