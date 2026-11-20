import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DELEGATION_PEER_LIST_METHOD,
  DESKTOP_PROJECTS_CATALOG_METHOD,
  PROJECT_MIRROR_LIST_METHOD,
  PROJECT_MIRROR_UPSERT_METHOD,
  type JsonObject,
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

it("persists mirror updates through the local Desktop RPC and rejects stale revisions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codexhost-mirror-rpc-"));
  const fixture = createFixture({ environment: { CODEXHOST_DATA_DIR: root } });
  let nextId = 1000;
  const request = async (method: string, params: JsonObject) => {
    const id = nextId++;
    writeRequest(fixture.desktopInput, { id, method, params });
    return fixture.collector.waitFor((message) => requestId(message, id));
  };
  try {
    await fixture.ready;
    const record = {
      hostId: "remote-ssh-discovered:test",
      remoteProjectId: "remote-workspace",
      remotePath: "/home/test/Documents/ChatGPT/Workspace",
      label: "Workspace",
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z",
    };
    await expect(request(PROJECT_MIRROR_LIST_METHOD, {})).resolves.toMatchObject({
      result: { revision: 0, projects: {} },
    });
    const update = { revision: 0, sourceProjectId: "workspace", record };
    await expect(request(PROJECT_MIRROR_UPSERT_METHOD, update)).resolves.toMatchObject({
      result: { revision: 1, projects: { workspace: { remoteProjectId: "remote-workspace" } } },
    });
    await expect(request(PROJECT_MIRROR_UPSERT_METHOD, update)).resolves.toMatchObject({
      error: { code: -32082 },
    });
    await expect(request(PROJECT_MIRROR_LIST_METHOD, {})).resolves.toMatchObject({
      result: { revision: 1, projects: { workspace: { remotePath: record.remotePath } } },
    });
  } finally {
    await stopFixture(fixture);
    await rm(root, { recursive: true, force: true });
  }
});
