import type { ProjectGroup } from "@codexhost/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  effectiveModelId,
  groupProviderModels,
  isNameOnlyProject,
  mirrorDirectoryCandidates,
  planMirrorGroup,
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

describe("model provider grouping", () => {
  it("uses the model id prefix, otherwise the host default provider", () => {
    expect(effectiveModelId("eshetang", "gpt-6", "magpie")).toBe("eshetang/gpt-6");
    expect(effectiveModelId("magpie", "gpt-6", "magpie")).toBe("gpt-6");
    expect(effectiveModelId("magpie", "eshetang/gpt-6", "magpie")).toBe("eshetang/gpt-6");
  });

  it("groups, hides, and orders models", () => {
    const groups = groupProviderModels(
      [
        { id: "eshetang/gpt-b", displayName: "B", isDefault: false },
        { id: "eshetang/gpt-a", displayName: "A", isDefault: true },
        { id: "plain", displayName: "Plain" },
        { id: "eshetang/hidden", displayName: "Hidden", hidden: true },
      ],
      { eshetang: { name: "OpenAI" }, magpie: { name: "Magpie" } },
      "magpie",
    );
    expect(groups.map((entry) => entry.providerId)).toEqual(["eshetang", "magpie"]);
    expect(groups[0]?.providerLabel).toBe("OpenAI");
    expect(groups[0]?.models.map((model) => model.id)).toEqual([
      "eshetang/gpt-a",
      "eshetang/gpt-b",
    ]);
    expect(groups[1]?.models.map((model) => model.id)).toEqual(["plain"]);
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
