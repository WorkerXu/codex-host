import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DELEGATION_PEER_LIST_METHOD,
  DESKTOP_PROJECTS_CATALOG_METHOD,
} from "@codexhost/shared-contracts";
import { expect, it } from "vitest";

import { writePeerConfig } from "../src/peer-config.js";
import { createFixture, requestId, stopFixture, writeRequest } from "./app-server-host-fixture.js";

it("serves the configured peer IDs and Desktop projects on the Desktop connection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-catalogs-"));
  const codexHome = path.join(root, ".codex");
  await mkdir(codexHome);
  const environment = { CODEXHOST_USER_DIR: root, CODEX_HOME: codexHome };
  await writePeerConfig(environment, {
    formatVersion: 1,
    peers: {},
    self: { hostIds: ["remote-ssh-discovered:test"] },
  });
  await writeFile(
    path.join(codexHome, ".codex-global-state.json"),
    JSON.stringify({
      "local-projects": { workspace: { id: "workspace", name: "Workspace", rootPaths: [root] } },
      "project-order": ["workspace"],
    }),
  );
  const fixture = createFixture({ environment });
  try {
    await fixture.ready;
    writeRequest(fixture.desktopInput, {
      id: 990,
      method: DELEGATION_PEER_LIST_METHOD,
      params: { refresh: true },
    });
    writeRequest(fixture.desktopInput, {
      id: 991,
      method: DESKTOP_PROJECTS_CATALOG_METHOD,
      params: {},
    });
    const [peers, projects] = await Promise.all(
      [990, 991].map((id) => fixture.collector.waitFor((message) => requestId(message, id))),
    );
    expect(peers).toMatchObject({
      result: { peers: [], self: { hostIds: ["remote-ssh-discovered:test"] } },
    });
    expect(projects).toMatchObject({
      result: {
        localProjects: { workspace: { name: "Workspace", rootPaths: [root] } },
        projectOrder: ["workspace"],
      },
    });
  } finally {
    await stopFixture(fixture);
    await rm(root, { recursive: true, force: true });
  }
});
