import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  detectJarvisPlatform,
  fetchLatestJarvisRelease,
  installJarvisArtifact,
  JarvisInstallError,
  jarvisInstallPath,
  sha256File,
  verifyJarvisArtifact,
} from "../src/jarvis-install.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-jarvis-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Jarvis platform detection", () => {
  it("maps Node platforms and architectures to release platform names", () => {
    expect(detectJarvisPlatform("linux", "x64")).toBe("linux-amd64");
    expect(detectJarvisPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(detectJarvisPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(detectJarvisPlatform("win32", "x64")).toBe("windows-amd64");
  });

  it("rejects unsupported combinations", () => {
    expect(() => detectJarvisPlatform("freebsd", "x64")).toThrow(JarvisInstallError);
    expect(() => detectJarvisPlatform("linux", "ia32")).toThrow(JarvisInstallError);
  });
});

describe("Jarvis release lookup", () => {
  it("maps the public listing's first stable release", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          list: [
            {
              id: 179,
              platform: "linux-arm64",
              versionName: "0.20.1",
              buildNumber: 20,
              sha256: "a".repeat(64),
              artifactSize: "14693511",
            },
          ],
        }),
        { status: 200 },
      );
    const release = await fetchLatestJarvisRelease({
      platform: "linux-arm64",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(release).toEqual({
      id: 179,
      version: "0.20.1",
      build: 20,
      platform: "linux-arm64",
      sha256: "a".repeat(64),
      size: 14693511,
      downloadUrl:
        "https://jarvis.eshetang.com/api/public/app-upgrade/releases/179/download?appId=jarvis-cli",
    });
  });

  it("rejects an empty listing", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ list: [] }), { status: 200 });
    await expect(
      fetchLatestJarvisRelease({
        platform: "linux-arm64",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "no_release" });
  });
});

describe("Jarvis artifact verification and installation", () => {
  it("verifies size and SHA256 and rejects a mismatch", async () => {
    const directory = await temporaryDirectory();
    const artifact = path.join(directory, "jarvis.tmp");
    await writeFile(artifact, "binary");
    const sha256 = createHash("sha256").update("binary").digest("hex");
    const release = {
      id: 1,
      version: "1.0.0",
      build: 1,
      platform: "linux-amd64",
      sha256,
      size: 6,
      downloadUrl: "https://example.test/jarvis",
    };
    expect(await sha256File(artifact)).toBe(sha256);
    await expect(verifyJarvisArtifact(artifact, release)).resolves.toBeUndefined();
    await expect(
      verifyJarvisArtifact(artifact, { ...release, sha256: "b".repeat(64) }),
    ).rejects.toMatchObject({ code: "sha256_mismatch" });
    await expect(verifyJarvisArtifact(artifact, { ...release, size: 7 })).rejects.toMatchObject({
      code: "size_mismatch",
    });
  });

  it("installs with executable permissions under ~/.local/bin", async () => {
    const home = await temporaryDirectory();
    const artifact = path.join(home, "artifact");
    await writeFile(artifact, "binary");
    await chmod(artifact, 0o600);
    const target = await installJarvisArtifact({ artifact, environment: { HOME: home } });
    expect(target).toBe(
      path.join(home, ".local", "bin", process.platform === "win32" ? "jarvis.exe" : "jarvis"),
    );
    expect(await readFile(target, "utf8")).toBe("binary");
    if (process.platform !== "win32") expect((await stat(target)).mode & 0o111).not.toBe(0);
    expect(jarvisInstallPath({ HOME: home })).toBe(target);
  });
});
