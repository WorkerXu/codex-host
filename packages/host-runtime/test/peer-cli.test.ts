import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { runPeerCli } from "../src/peer-cli.js";
import { runDelegationCli } from "../src/delegation-cli.js";
import { peerConfigPath } from "../src/peer-config.js";
import { PEER_HELP } from "../src/delegation-cli-help.js";
import type { PeerProcess, PeerSpawn } from "../src/peer-transport.js";

const roots: string[] = [];

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cx-peer-cli-"));
  roots.push(root);
  return root;
}

function outputText(stream: PassThrough): string {
  return stream.read()?.toString() ?? "";
}

class FakeProcess implements PeerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #listeners = new Map<string, ((...arguments_: never[]) => void)[]>();

  kill(): boolean {
    return true;
  }

  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: string, listener: (...arguments_: never[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...arguments_: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...(arguments_ as never[]));
    }
  }
}

function successfulSpawn(response: unknown): { spawnImpl: PeerSpawn; inputs: string[] } {
  const inputs: string[] = [];
  const spawnImpl: PeerSpawn = () => {
    const child = new FakeProcess();
    let input = "";
    child.stdin.on("data", (chunk) => {
      input += chunk.toString();
    });
    child.stdin.on("end", () => {
      inputs.push(input);
      setImmediate(() => {
        child.stdout.write(JSON.stringify(response));
        child.emit("close", 0, null);
      });
    });
    return child;
  };
  return { spawnImpl, inputs };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("peer CLI", () => {
  it("prints peer help", async () => {
    const output = new PassThrough();
    await expect(runPeerCli({ arguments: ["--help"], output })).resolves.toBe(0);
    expect(outputText(output)).toBe(PEER_HELP);
  });

  it("adds, lists, and removes peers", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_DATA_DIR: root };
    const added = new PassThrough();
    await expect(
      runPeerCli({
        arguments: [
          "add",
          "--name",
          "oracle",
          "--ssh",
          "ubuntu@oracle-main",
          "--host-id",
          "remote-ssh-discovered:oracle-main",
          "--host-id",
          "local",
          "--command",
          "/opt/codexhost/bin/codexhost",
        ],
        environment,
        output: added,
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(outputText(added))).toEqual({
      peer: {
        name: "oracle",
        ssh: "ubuntu@oracle-main",
        hostIds: ["remote-ssh-discovered:oracle-main", "local"],
        command: "/opt/codexhost/bin/codexhost",
      },
    });

    const listed = new PassThrough();
    await expect(runPeerCli({ arguments: ["list"], environment, output: listed })).resolves.toBe(0);
    expect(JSON.parse(outputText(listed))).toEqual({
      peers: [
        {
          name: "oracle",
          ssh: "ubuntu@oracle-main",
          hostIds: ["remote-ssh-discovered:oracle-main", "local"],
          command: "/opt/codexhost/bin/codexhost",
        },
      ],
    });

    await expect(
      runPeerCli({
        arguments: ["add", "--name", "oracle", "--ssh", "oracle"],
        environment,
        output: new PassThrough(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      runPeerCli({
        arguments: ["add", "--name", "mac", "--ssh", "mac", "--host-id", "local"],
        environment,
        output: new PassThrough(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const removed = new PassThrough();
    await expect(
      runPeerCli({ arguments: ["remove", "oracle"], environment, output: removed }),
    ).resolves.toBe(0);
    expect(JSON.parse(outputText(removed))).toEqual({ removed: "oracle" });
    expect(JSON.parse(await readFile(peerConfigPath(environment), "utf8"))).toEqual({
      formatVersion: 1,
      peers: {},
    });
  });

  it("rejects duplicate option values and shell syntax", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_DATA_DIR: root };
    for (const arguments_ of [
      ["add", "--name", "mac", "--name", "other", "--ssh", "mac"],
      ["add", "--name", "mac", "--ssh", "mac", "--command", "codexhost; rm -rf /"],
      ["add", "--name", "local", "--ssh", "mac"],
      ["add", "--name", "mac"],
    ]) {
      await expect(
        runPeerCli({ arguments: arguments_, environment, output: new PassThrough() }),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
  });

  it("tests connectivity with one remote harness list", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_DATA_DIR: root };
    await runPeerCli({
      arguments: ["add", "--name", "mac", "--ssh", "mac"],
      environment,
      output: new PassThrough(),
    });
    const { spawnImpl, inputs } = successfulSpawn({ harnesses: ["codex", "pi"] });
    const output = new PassThrough();
    await expect(
      runPeerCli({ arguments: ["test", "mac"], environment, output, spawnImpl }),
    ).resolves.toBe(0);
    expect(JSON.parse(outputText(output))).toEqual({ peer: "mac", harnesses: ["codex", "pi"] });
    expect(JSON.parse(inputs[0] ?? "{}")).toEqual({ route: "/v1/harness/list", body: {} });
  });

  it("rejects an unknown peer and an unknown command", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_DATA_DIR: root };
    await expect(
      runPeerCli({ arguments: ["test", "mac"], environment, output: new PassThrough() }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      runPeerCli({ arguments: ["wat"], environment, output: new PassThrough() }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("dispatches peer commands through the delegation CLI entry point", async () => {
    const root = await dataDirectory();
    const diagnostics = new PassThrough();
    await expect(
      runDelegationCli({
        arguments: ["peer", "remove", "missing"],
        environment: { CODEXHOST_DATA_DIR: root },
        output: new PassThrough(),
        diagnosticOutput: diagnostics,
      }),
    ).resolves.toBe(1);
    expect(JSON.parse(outputText(diagnostics))).toMatchObject({
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it("reports a malformed peer list instead of inventing Harnesses", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_DATA_DIR: root };
    await runPeerCli({
      arguments: ["add", "--name", "mac", "--ssh", "mac"],
      environment,
      output: new PassThrough(),
    });
    const { spawnImpl } = successfulSpawn({ harnesses: "codex" });
    await expect(
      runPeerCli({
        arguments: ["test", "mac"],
        environment,
        output: new PassThrough(),
        spawnImpl,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
