import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodeRepositories } from "../src/code-repositories.js";
import { RepositoryCredentials } from "../src/code-repository-credentials.js";
import { RepositoryCatalog } from "../src/code-repository-catalog.js";
import { createFixture, closeFixture, writeRequest, requestId } from "./app-server-host-fixture.js";

it("keeps credential RPCs local and never returns the credential in protocol replies or diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-host-test-"));
  const credentials = new RepositoryCredentials({ HOME: root });
  const run = vi.fn(async () => "WorkerXu");
  const service = new CodeRepositories({ catalog: new RepositoryCatalog(credentials, run) });
  const fixture = createFixture({ codeRepositories: service });
  const diagnostics: string[] = [];
  fixture.diagnosticOutput.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString()));
  const token = "synthetic-credential-1234";
  try {
    writeRequest(fixture.desktopInput, {
      id: 10,
      method: "codexhost/code-repositories/set-token",
      params: { token },
    });
    const response = await fixture.collector.waitFor((m) => requestId(m, 10));
    expect(response).toMatchObject({
      result: { gitlab: { configured: true, lastFour: "1234" }, github: { login: "WorkerXu" } },
    });
    expect(JSON.stringify(fixture.collector.messages)).not.toContain(token);
    expect(diagnostics.join("")).not.toContain(token);
  } finally {
    await closeFixture(fixture);
    await rm(root, { recursive: true, force: true });
  }
  const remote = createFixture();
  try {
    writeRequest(remote.desktopInput, {
      id: 11,
      method: "codexhost/code-repositories/settings",
      params: {},
    });
    expect(await remote.collector.waitFor((m) => requestId(m, 11))).toMatchObject({
      error: { code: -32601, message: "local_only" },
    });
  } finally {
    await closeFixture(remote);
  }
});
