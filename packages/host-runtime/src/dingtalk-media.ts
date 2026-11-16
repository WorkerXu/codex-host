import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runDwsRaw, type DwsSpawn } from "./dingtalk-cli.js";

/** Images above this size are shown as a placeholder instead of a data URL. */
export const DINGTALK_MEDIA_MAX_BYTES = 4 * 1024 * 1024;

export interface DingTalkMediaRequest {
  conversationId: string;
  messageId: string;
  resourceId: string;
  resourceIdType: string;
}

export interface DingTalkMediaResult {
  ok: boolean;
  base64: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  errorCode: string | null;
}

export function dingtalkMediaCacheDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR?.trim();
  const home = environment.HOME?.trim() || os.homedir();
  const base = dataDirectory ? path.resolve(dataDirectory) : path.join(home, ".cache", "codexhost");
  return path.join(base, "dingtalk-media");
}

export function dingtalkMediaCacheKey(request: DingTalkMediaRequest): string {
  return createHash("sha256")
    .update(`${request.conversationId}\n${request.messageId}\n${request.resourceId}`)
    .digest("hex");
}

function mimeType(buffer: Buffer): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504E470D0A1A0A", "hex"))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

async function readCached(file: string): Promise<DingTalkMediaResult | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size <= 0 || info.size > DINGTALK_MEDIA_MAX_BYTES) return null;
    const buffer = await readFile(file);
    return {
      ok: true,
      base64: buffer.toString("base64"),
      mimeType: mimeType(buffer),
      sizeBytes: buffer.length,
      errorCode: null,
    };
  } catch {
    return null;
  }
}

/**
 * Downloads one message image with `dws chat +messages-resource-download` on
 * the machine that owns the DingTalk login, then reads it from a per-runtime
 * cache. The CLI only accepts output paths relative to its working directory.
 */
export async function downloadDingTalkMedia(input: {
  environment: NodeJS.ProcessEnv;
  request: DingTalkMediaRequest;
  spawnImpl?: DwsSpawn;
  executable?: string;
  cacheDirectory?: string;
}): Promise<DingTalkMediaResult> {
  const cacheDirectory = input.cacheDirectory ?? dingtalkMediaCacheDirectory(input.environment);
  const key = dingtalkMediaCacheKey(input.request);
  const file = path.join(cacheDirectory, `${key}.bin`);
  const cached = await readCached(file);
  if (cached) return cached;
  try {
    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  } catch {
    return {
      ok: false,
      base64: null,
      mimeType: null,
      sizeBytes: null,
      errorCode: "cache_unavailable",
    };
  }
  const raw = await runDwsRaw(
    [
      "chat",
      "+messages-resource-download",
      "--resource-id",
      input.request.resourceId,
      "--message-id",
      input.request.messageId,
      "--open-conversation-id",
      input.request.conversationId,
      "--type",
      input.request.resourceIdType,
      "--output",
      `${key}.bin`,
      "--format",
      "json",
    ],
    {
      environment: input.environment,
      cwd: cacheDirectory,
      timeoutMs: 45_000,
      ...(input.executable ? { executable: input.executable } : {}),
      ...(input.spawnImpl ? { spawnImpl: input.spawnImpl } : {}),
    },
  );
  if (raw.timedOut) {
    return {
      ok: false,
      base64: null,
      mimeType: null,
      sizeBytes: null,
      errorCode: "timeout",
    };
  }
  if (raw.exitCode !== 0) {
    return {
      ok: false,
      base64: null,
      mimeType: null,
      sizeBytes: null,
      errorCode: "download_failed",
    };
  }
  const downloaded = await readCached(file);
  if (!downloaded) {
    return {
      ok: false,
      base64: null,
      mimeType: null,
      sizeBytes: null,
      errorCode: "resource_too_large",
    };
  }
  return downloaded;
}
