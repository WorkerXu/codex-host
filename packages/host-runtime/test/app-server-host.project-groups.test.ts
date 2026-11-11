import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ProjectGroup } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectGroupsService } from "../src/project-groups-service.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-host-groups-"));
  temporaryDirectories.push(directory);
  return directory;
}

function group(): ProjectGroup {
  return {
    id: "5e5f0a4d-24bd-4af8-9e8e-2e7f2f8d4a1b",
    name: "Cross-host",
    order: 0,
    collapsed: false,
    members: [
      {
        projectKind: "local",
        projectId: "local-alpha",
        rootPaths: ["/Users/test/alpha"],
        label: "alpha",
      },
    ],
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z",
  };
}

describe("Host project group RPC", () => {
  it("lists, replaces, and reads the Desktop project catalog on the local Host", async () => {
    const directory = await temporaryDirectory();
    const codexHome = await temporaryDirectory();
    await writeFile(
      path.join(codexHome, ".codex-global-state.json"),
      JSON.stringify({
        "local-projects": {
          "local-alpha": { id: "local-alpha", name: "alpha", rootPaths: ["/Users/test/alpha"] },
        },
        "remote-projects": [],
        "thread-project-assignments": {},
        "codex-managed-remote-connections": [],
        "project-order": ["local-alpha"],
      }),
      "utf8",
    );
    const service = new ProjectGroupsService({ directory, codexHome, catalogCacheTtlMs: 0 });
    const fixture = createFixture({ projectGroups: service });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "codexhost/project-groups/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
        result: { revision: 0, groups: [] },
      });

      writeRequest(fixture.desktopInput, {
        id: 2,
        method: "codexhost/project-groups/replace",
        params: { revision: 0, groups: [group()] },
      });
      const replaced = await fixture.collector.waitFor((message) => requestId(message, 2));
      expect(replaced).toMatchObject({ result: { revision: 1, groups: [{ name: "Cross-host" }] } });

      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "codexhost/project-groups/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 3))).toMatchObject({
        result: { revision: 1, groups: [{ name: "Cross-host" }] },
      });

      writeRequest(fixture.desktopInput, {
        id: 4,
        method: "codexhost/desktop-projects/catalog",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 4))).toMatchObject({
        result: { projectOrder: ["local-alpha"] },
      });

      writeRequest(fixture.desktopInput, {
        id: 5,
        method: "codexhost/project-groups/replace",
        params: { revision: 0, groups: [group()] },
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 5))).toMatchObject({
        error: { code: -32082 },
      });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("reports the methods as unavailable when the local service is absent", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: "codexhost/project-groups/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((message) => requestId(message, 1))).toMatchObject({
        error: { code: -32601 },
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
