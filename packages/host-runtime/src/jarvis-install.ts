import { createHash } from "node:crypto";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jarvisReleaseSchema, type JarvisRelease } from "@codexhost/shared-contracts";

export const JARVIS_CLI_APP_ID = "jarvis-cli";
export const JARVIS_RELEASES_ENDPOINT =
  "https://jarvis.eshetang.com/jarvis.v1.AppUpgradePublicService/ListPublishedReleases";
export const JARVIS_DOWNLOAD_BASE = "https://jarvis.eshetang.com/api/public/app-upgrade/releases";
const MIN_DOWNLOAD_BYTES_PER_SECOND = 128 * 1024;
const SLOW_PROBE_MS = 3_000;

export class JarvisInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JarvisInstallError";
  }
}

export function detectJarvisPlatform(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  const osName =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : null;
  const arch =
    architecture === "x64" || architecture === "amd64"
      ? "amd64"
      : architecture === "arm64" || architecture === "aarch64"
        ? "arm64"
        : null;
  if (!osName || !arch) {
    throw new JarvisInstallError("unsupported_platform", "Unsupported Jarvis CLI platform");
  }
  return `${osName}-${arch}`;
}

function installationDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(environment.HOME || os.homedir(), ".local", "bin");
}

export function jarvisInstallPath(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(
    installationDirectory(environment),
    process.platform === "win32" ? "jarvis.exe" : "jarvis",
  );
}

export function jarvisReleaseDownloadUrl(releaseId: number): string {
  return `${JARVIS_DOWNLOAD_BASE}/${releaseId}/download?appId=${JARVIS_CLI_APP_ID}`;
}

function number(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^[0-9]+$/u.test(value)) return Number(value);
  return Number.NaN;
}

/** Public release listing; no authentication is required. */
export async function fetchLatestJarvisRelease(input: {
  platform: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}): Promise<JarvisRelease> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(input.endpoint ?? JARVIS_RELEASES_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: JARVIS_CLI_APP_ID,
        platform: input.platform,
        channel: "stable",
      }),
    });
  } catch {
    throw new JarvisInstallError("network", "Jarvis release listing is unreachable");
  }
  if (!response.ok) {
    throw new JarvisInstallError(`http_${response.status}`, "Jarvis release listing failed");
  }
  const value: unknown = await response.json().catch(() => null);
  const first =
    typeof value === "object" && value !== null && Array.isArray((value as { list?: unknown }).list)
      ? ((value as { list: unknown[] }).list[0] as Record<string, unknown> | undefined)
      : undefined;
  if (!first) throw new JarvisInstallError("no_release", "No stable Jarvis CLI release was found");
  const id = number(first.id);
  const release = jarvisReleaseSchema.safeParse({
    id,
    version: typeof first.versionName === "string" ? first.versionName : "",
    build: number(first.buildNumber),
    platform: typeof first.platform === "string" ? first.platform : input.platform,
    sha256: typeof first.sha256 === "string" ? first.sha256.toLowerCase() : "",
    size: number(first.artifactSize),
    downloadUrl: jarvisReleaseDownloadUrl(id),
  });
  if (!release.success) {
    throw new JarvisInstallError("invalid_release", "Jarvis release metadata is invalid");
  }
  return release.data;
}

export async function sha256File(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export async function verifyJarvisArtifact(file: string, release: JarvisRelease): Promise<void> {
  const info = await stat(file);
  if (info.size !== release.size) {
    throw new JarvisInstallError("size_mismatch", "Downloaded Jarvis CLI size does not match");
  }
  if ((await sha256File(file)) !== release.sha256) {
    throw new JarvisInstallError(
      "sha256_mismatch",
      "Downloaded Jarvis CLI checksum does not match",
    );
  }
}

export async function createJarvisArtifactPath(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const directory = installationDirectory(environment);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  return path.join(
    directory,
    `.jarvis-download-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`,
  );
}

/** Streams one release to a temporary file and rejects transfers that stay below the probe speed. */
export async function downloadJarvisRelease(input: {
  release: JarvisRelease;
  destination: string;
  fetchImpl?: typeof fetch;
  onProgress?: (received: number, total: number) => void;
  timeoutMs?: number;
  minBytesPerSecond?: number;
  probeMs?: number;
  now?: () => number;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10 * 60_000);
  const handle = await open(input.destination, "w", 0o600);
  try {
    let response: Response;
    try {
      response = await fetchImpl(input.release.downloadUrl, {
        redirect: "follow",
        signal: controller.signal,
      });
    } catch {
      throw new JarvisInstallError(
        controller.signal.aborted ? "timeout" : "network",
        "Jarvis CLI download failed",
      );
    }
    if (!response.ok) {
      throw new JarvisInstallError(`http_${response.status}`, "Jarvis CLI download failed");
    }
    const body = response.body;
    if (!body) throw new JarvisInstallError("empty_download", "Jarvis CLI download was empty");
    const reader = body.getReader();
    const started = now();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await handle.write(value);
      received += value.byteLength;
      input.onProgress?.(received, input.release.size);
      const elapsed = now() - started;
      const minimum = input.minBytesPerSecond ?? MIN_DOWNLOAD_BYTES_PER_SECOND;
      if (elapsed >= (input.probeMs ?? SLOW_PROBE_MS) && received / (elapsed / 1000) < minimum) {
        await reader.cancel().catch(() => undefined);
        throw new JarvisInstallError("slow_download", "Jarvis CLI download is too slow");
      }
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof JarvisInstallError) throw error;
    throw new JarvisInstallError(
      controller.signal.aborted ? "timeout" : "network",
      "Jarvis CLI download was interrupted",
    );
  } finally {
    clearTimeout(timer);
    await handle.close();
    if (controller.signal.aborted)
      await rm(input.destination, { force: true }).catch(() => undefined);
  }
}

/** Replace the installed CLI only after the artifact has been verified. */
export async function installJarvisArtifact(input: {
  artifact: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<string> {
  const target = jarvisInstallPath(input.environment);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  await chmod(input.artifact, 0o755).catch(() => undefined);
  await rm(target, { force: true }).catch(() => undefined);
  try {
    await rename(input.artifact, target);
  } catch {
    throw new JarvisInstallError(
      "install_failed",
      "Jarvis CLI could not replace the installed file",
    );
  }
  await chmod(target, 0o755).catch(() => undefined);
  return target;
}
