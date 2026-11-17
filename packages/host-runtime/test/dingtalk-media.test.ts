import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DINGTALK_MEDIA_MAX_BYTES,
  downloadDingTalkMedia,
  type DingTalkMediaRequest,
} from "../src/dingtalk-media.js";

const request: DingTalkMediaRequest = {
  conversationId: "cidA==",
  messageId: "m1",
  resourceId: "@media-1",
  resourceIdType: "mediaId",
};

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function mediaChild(cwd: string, args: readonly string[], bytes: Buffer, exitCode = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  const outputIndex = args.indexOf("--output");
  const output = args[outputIndex + 1] ?? "media.bin";
  queueMicrotask(async () => {
    await writeFile(path.join(cwd, output), bytes);
    child.emit("close", exitCode);
  });
  return child;
}

const directories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-dingtalk-media-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("DingTalk live media reads", () => {
  it("downloads fresh on every read and removes temporary files", async () => {
    const directory = await temporaryRoot();
    const spawnImpl = vi.fn((_command, args: readonly string[], options: { cwd: string }) =>
      mediaChild(options.cwd, args, png),
    );
    const result = await downloadDingTalkMedia({
      environment: process.env,
      request,
      executable: "/fake/dws",
      spawnImpl: spawnImpl as never,
      temporaryRoot: directory,
    });
    expect(result).toMatchObject({ ok: true, mimeType: "image/png", sizeBytes: png.length });
    expect(result.base64).toBe(png.toString("base64"));
    const second = await downloadDingTalkMedia({
      environment: process.env,
      request,
      executable: "/fake/dws",
      spawnImpl: spawnImpl as never,
      temporaryRoot: directory,
    });
    expect(second.base64).toBe(result.base64);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects an oversized image", async () => {
    const directory = await temporaryRoot();
    const spawnImpl = vi.fn((_command, args: readonly string[], options: { cwd: string }) =>
      mediaChild(options.cwd, args, Buffer.alloc(DINGTALK_MEDIA_MAX_BYTES + 1, 1)),
    );
    const result = await downloadDingTalkMedia({
      environment: process.env,
      request,
      executable: "/fake/dws",
      spawnImpl: spawnImpl as never,
      temporaryRoot: directory,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("resource_too_large");
    expect(await readdir(directory)).toEqual([]);
  });

  it("reports a failed download", async () => {
    const directory = await temporaryRoot();
    const spawnImpl = vi.fn((_command, args: readonly string[], options: { cwd: string }) =>
      mediaChild(options.cwd, args, Buffer.alloc(0), 1),
    );
    const result = await downloadDingTalkMedia({
      environment: process.env,
      request,
      executable: "/fake/dws",
      spawnImpl: spawnImpl as never,
      temporaryRoot: directory,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("download_failed");
    expect(await readdir(directory)).toEqual([]);
  });
});
