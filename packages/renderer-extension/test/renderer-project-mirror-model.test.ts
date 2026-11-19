import { describe, expect, it } from "vitest";

import type { DesktopProjectsCatalog } from "@codexhost/shared-contracts";

import {
  chooseMirrorDestination,
  findNameOnlyLocalProject,
  isNameOnlyProject,
  isNameOnlyRemoteProject,
  mirrorDirectoryCandidates,
  readComposerProject,
  resolveMirrorSource,
  sanitizeMirrorDirectoryName,
} from "../src/renderer-project-mirror-model.js";

const parent = "/Users/test/Documents/ChatGPT";
const remoteParent = "/home/oracle/Documents/ChatGPT";

function catalog(overrides: Partial<DesktopProjectsCatalog> = {}): DesktopProjectsCatalog {
  return {
    localProjects: {},
    remoteProjects: [],
    threadProjectAssignments: {},
    codexManagedRemoteConnections: [],
    projectOrder: [],
    selectedProject: null,
    homeDirectory: "/Users/test",
    defaultProjectParent: parent,
    readAt: "2026-11-17T03:00:00.000Z",
    ...overrides,
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

describe("remote name-only projects", () => {
  it("accepts the same name-only shape under another machine's home", () => {
    expect(
      isNameOnlyRemoteProject({ label: "codex验收", remotePath: `${remoteParent}/codex验收` }),
    ).toBe(true);
    expect(
      isNameOnlyRemoteProject({ label: "codex验收", remotePath: `${remoteParent}/codex验收 2` }),
    ).toBe(true);
  });

  it("rejects other parents, renamed folders, and nested roots", () => {
    expect(isNameOnlyRemoteProject({ label: "root", remotePath: "/root" })).toBe(false);
    expect(isNameOnlyRemoteProject({ label: "repo", remotePath: "/home/oracle/repo" })).toBe(false);
    expect(
      isNameOnlyRemoteProject({ label: "other", remotePath: `${remoteParent}/codex验收` }),
    ).toBe(false);
    expect(isNameOnlyRemoteProject({ label: "app", remotePath: `${remoteParent}/app/src` })).toBe(
      false,
    );
  });

  it("reuses a same-name local project instead of creating a numbered duplicate", () => {
    const projects = [
      { id: "one", name: "codex验收", rootPaths: [`${parent}/codex验收`] },
      { id: "two", name: "codex验收", rootPaths: ["/work/codex验收"] },
    ];
    expect(findNameOnlyLocalProject(projects, "codex验收", parent)?.id).toBe("one");
    expect(findNameOnlyLocalProject(projects, "missing", parent)).toBeUndefined();
  });
});

describe("mirror source resolution", () => {
  it("accepts a local name-only project", () => {
    const resolved = resolveMirrorSource(
      catalog({
        localProjects: {
          "local-alpha": { id: "local-alpha", name: "alpha", rootPaths: [`${parent}/alpha`] },
        },
      }),
      { type: "local", projectId: "local-alpha" },
    );
    expect(resolved).toMatchObject({
      reason: "eligible",
      source: { id: "local-alpha", name: "alpha", hostId: "local", kind: "local" },
    });
  });

  it("accepts a name-only project that lives on another machine", () => {
    const resolved = resolveMirrorSource(
      catalog({
        remoteProjects: [
          {
            id: "remote-codex",
            hostId: "remote-ssh-discovered:oracle-main",
            remotePath: `${remoteParent}/codex验收`,
            label: "codex验收",
          },
        ],
      }),
      { type: "remote", projectId: "remote-codex" },
    );
    expect(resolved).toMatchObject({
      reason: "eligible",
      source: {
        id: "remote-codex",
        name: "codex验收",
        hostId: "remote-ssh-discovered:oracle-main",
        kind: "remote",
        rootPaths: [`${remoteParent}/codex验收`],
      },
    });
  });

  it("keeps a remote project that is not name-only out of the picker", () => {
    expect(
      resolveMirrorSource(
        catalog({
          remoteProjects: [
            {
              id: "root-project",
              hostId: "remote-ssh-codex-managed:root",
              remotePath: "/root",
              label: "root",
            },
          ],
        }),
        { type: "remote", projectId: "root-project" },
      ),
    ).toEqual({ source: null, reason: "not-name-only", error: null });
  });

  it("reports a project that disappeared from the catalog", () => {
    expect(resolveMirrorSource(catalog(), { type: "remote", projectId: "gone" })).toMatchObject({
      source: null,
      reason: "missing-project",
    });
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
