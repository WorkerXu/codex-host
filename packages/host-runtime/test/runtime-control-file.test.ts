import { readFile, readdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  publishRuntimeControl,
  readRuntimeControl,
  runtimeControlDirectory,
} from "../src/runtime-control-file.js";

const roots: string[] = [];

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "cx-runtime-control-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Host Runtime control file", () => {
  it("publishes an atomic, owner-only record and removes it on close", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_USER_DIR: root };
    const handle = await publishRuntimeControl({
      environment,
      endpoint: "http://127.0.0.1:4321",
      token: "synthetic-token",
      pid: 1234,
      startedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(handle.filePath).toBe(
      path.join(runtimeControlDirectory(environment), "control-1234.json"),
    );
    expect(JSON.parse(await readFile(handle.filePath, "utf8"))).toEqual({
      formatVersion: 1,
      endpoint: "http://127.0.0.1:4321",
      token: "synthetic-token",
      pid: 1234,
      startedAt: "2026-01-02T03:04:05.000Z",
    });
    if (process.platform !== "win32") {
      expect((await stat(runtimeControlDirectory(environment))).mode & 0o777).toBe(0o700);
      expect((await stat(handle.filePath)).mode & 0o777).toBe(0o600);
    }
    await expect(readRuntimeControl(environment, { isProcessAlive: () => true })).resolves.toEqual({
      filePath: handle.filePath,
      record: {
        formatVersion: 1,
        endpoint: "http://127.0.0.1:4321",
        token: "synthetic-token",
        pid: 1234,
        startedAt: "2026-01-02T03:04:05.000Z",
      },
    });
    await handle.close();
    await expect(
      readRuntimeControl(environment, { isProcessAlive: () => true }),
    ).resolves.toBeUndefined();
    await expect(readdir(runtimeControlDirectory(environment))).resolves.toEqual([]);
  });

  it("keeps concurrent Runtime records and reads the newest live one", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_USER_DIR: root };
    const older = await publishRuntimeControl({
      environment,
      endpoint: "http://127.0.0.1:1111",
      token: "older",
      pid: 111,
      startedAt: "2026-01-02T03:04:05.000Z",
    });
    const newer = await publishRuntimeControl({
      environment,
      endpoint: "http://127.0.0.1:2222",
      token: "newer",
      pid: 222,
      startedAt: "2026-01-02T03:05:05.000Z",
    });
    try {
      await expect(
        readRuntimeControl(environment, { isProcessAlive: () => true }),
      ).resolves.toMatchObject({ filePath: newer.filePath, record: { pid: 222 } });
      await expect(
        readRuntimeControl(environment, {
          isProcessAlive: (pid) => pid !== 222,
        }),
      ).resolves.toMatchObject({ filePath: older.filePath, record: { pid: 111 } });
      expect((await readdir(runtimeControlDirectory(environment))).sort()).toEqual([
        "control-111.json",
        "control-222.json",
      ]);
    } finally {
      await older.close();
      await newer.close();
    }
  });

  it("ignores stale PIDs, malformed records, and non-loopback endpoints", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_USER_DIR: root };
    const stale = await publishRuntimeControl({
      environment,
      endpoint: "http://127.0.0.1:1111",
      token: "stale",
      pid: 111,
      startedAt: "2026-01-02T03:04:05.000Z",
    });
    const directory = runtimeControlDirectory(environment);
    await writeFile(path.join(directory, "control-333.json"), "{not json");
    await writeFile(
      path.join(directory, "control-444.json"),
      JSON.stringify({
        formatVersion: 1,
        endpoint: "http://example.com:4444",
        token: "leaked",
        pid: 444,
        startedAt: "2026-01-02T03:06:05.000Z",
      }),
    );
    await writeFile(
      path.join(directory, "control-555.json"),
      JSON.stringify({
        formatVersion: 2,
        endpoint: "http://127.0.0.1:5555",
        token: "future",
        pid: 555,
        startedAt: "2026-01-02T03:07:05.000Z",
      }),
    );
    try {
      await expect(
        readRuntimeControl(environment, { isProcessAlive: (pid) => pid !== 111 }),
      ).resolves.toBeUndefined();
      await expect(
        readRuntimeControl(environment, { isProcessAlive: () => true }),
      ).resolves.toMatchObject({ filePath: stale.filePath });
    } finally {
      await stale.close();
    }
  });

  it("ignores CODEXHOST_DATA_DIR and honors a dedicated control directory override", async () => {
    const root = await dataDirectory();
    const data = await dataDirectory();
    const environment = { CODEXHOST_DATA_DIR: data, CODEXHOST_USER_DIR: root };
    const handle = await publishRuntimeControl({
      environment,
      endpoint: "http://127.0.0.1:4321",
      token: "synthetic-token",
      pid: 1234,
    });
    try {
      expect(handle.filePath).toBe(path.join(root, "runtime", "control-1234.json"));
      await expect(readdir(data)).resolves.toEqual([]);
    } finally {
      await handle.close();
    }

    const override = await dataDirectory();
    const overridden = await publishRuntimeControl({
      environment: {
        CODEXHOST_DATA_DIR: data,
        CODEXHOST_USER_DIR: root,
        CODEXHOST_RUNTIME_CONTROL_DIR: override,
      },
      endpoint: "http://127.0.0.1:4322",
      token: "synthetic-token",
      pid: 1235,
    });
    try {
      expect(overridden.filePath).toBe(path.join(override, "control-1235.json"));
    } finally {
      await overridden.close();
    }
  });

  it("does not read or write the real home from an unisolated test process", async () => {
    const handle = await publishRuntimeControl({
      environment: { VITEST: "true" },
      endpoint: "http://127.0.0.1:4321",
      token: "synthetic-token",
    });
    expect(handle.filePath).toBe("");
    await expect(handle.close()).resolves.toBeUndefined();
    await expect(readRuntimeControl({ VITEST: "true" })).resolves.toBeUndefined();
  });

  it("does not remove a record that another process replaced at the same path", async () => {
    const root = await dataDirectory();
    const environment = { CODEXHOST_USER_DIR: root };
    const handle = await publishRuntimeControl({
      environment,
      endpoint: "http://127.0.0.1:1111",
      token: "first",
      pid: 777,
      startedAt: "2026-01-02T03:04:05.000Z",
    });
    await writeFile(
      handle.filePath,
      `${JSON.stringify({ ...handle.record, token: "replacement" })}\n`,
    );
    await handle.close();
    await expect(
      readRuntimeControl(environment, { isProcessAlive: () => true }),
    ).resolves.toMatchObject({ record: { token: "replacement" } });
  });

  it("returns no record when the data directory does not exist", async () => {
    const root = await dataDirectory();
    await expect(
      readRuntimeControl({ CODEXHOST_USER_DIR: path.join(root, "missing") }),
    ).resolves.toBeUndefined();
  });
});
