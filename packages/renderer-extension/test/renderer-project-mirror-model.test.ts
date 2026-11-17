import { describe, expect, it } from "vitest";

import {
  chooseMirrorDestination,
  isNameOnlyProject,
  mirrorDirectoryCandidates,
  readComposerProject,
  sanitizeMirrorDirectoryName,
} from "../src/renderer-project-mirror-model.js";

const parent = "/Users/test/Documents/ChatGPT";

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
