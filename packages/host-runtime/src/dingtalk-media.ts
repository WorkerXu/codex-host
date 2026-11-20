import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
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

async function readDownloaded(file: string): Promise<DingTalkMediaResult | null> {
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

/** The CLI needs a relative output file; remove the temporary download after each read. */
export async function downloadDingTalkMedia(input: {
  environment: NodeJS.ProcessEnv;
  request: DingTalkMediaRequest;
  spawnImpl?: DwsSpawn;
  executable?: string;
  temporaryRoot?: string;
}): Promise<DingTalkMediaResult> {
  let directory: string;
  try {
    directory = await mkdtemp(
      path.join(input.temporaryRoot ?? os.tmpdir(), "codexhost-dingtalk-media-"),
    );
  } catch {
    return {
      ok: false,
      base64: null,
      mimeType: null,
      sizeBytes: null,
      errorCode: "download_failed",
    };
  }
  const file = path.join(directory, "media.bin");
  try {
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
        "media.bin",
        "--format",
        "json",
      ],
      {
        environment: input.environment,
        cwd: directory,
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
    const downloaded = await readDownloaded(file);
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
