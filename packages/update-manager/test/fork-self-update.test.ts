import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  FORK_SELF_UPDATE_DISABLED_MESSAGE,
  FORK_SELF_UPDATE_ENABLED,
} from "@codexhost/shared-contracts/fork-self-update";
import {
  createBackgroundUpdateManager,
  fetchGitHubReleaseAnnouncement,
  fetchLatestGitHubRelease,
  fetchLatestGitHubReleaseWithGitHubCli,
} from "../src/index.js";

it.skipIf(FORK_SELF_UPDATE_ENABLED)(
  "blocks latest release checks while looking up the announcement for the running version",
  async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 404 }));
    const run = vi.fn();
    await expect(fetchLatestGitHubRelease({ fetch })).rejects.toThrow(
      FORK_SELF_UPDATE_DISABLED_MESSAGE,
    );
    await expect(
      fetchLatestGitHubReleaseWithGitHubCli({ run, executableCandidates: ["gh"] }),
    ).rejects.toThrow(FORK_SELF_UPDATE_DISABLED_MESSAGE);
    expect(fetch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    await expect(fetchGitHubReleaseAnnouncement("0.25.1", { fetch })).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/releases\/tags\/v0\.25\.1$/u),
      expect.anything(),
    );
  },
);

it.skipIf(FORK_SELF_UPDATE_ENABLED)(
  "rejects preparing and starting updates before creating staging files or downloading",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "codexhost-self-update-"));
    try {
      const updater = join(root, "updater");
      await writeFile(updater, "fixture");
      const common = {
        version: "1.2.3",
        launcherPid: process.pid,
        launcherExecutable: updater,
        runtimeDescriptorPath: join(root, "descriptor.json"),
        updaterExecutable: updater,
        stateDirectory: join(root, "updates"),
      };
      const download = vi.fn();
      const spawnUpdater = vi.fn();
      const manager = createBackgroundUpdateManager({ platform: "darwin", download, spawnUpdater });
      await expect(
        manager.prepareNpm({
          ...common,
          nodePath: process.execPath,
          npmCliPath: updater,
          npmLauncherPath: updater,
          packageRoot: root,
        }),
      ).rejects.toThrow(FORK_SELF_UPDATE_DISABLED_MESSAGE);
      await expect(
        manager.prepareMacOsDmg({
          ...common,
          appPath: join(root, "CodexHost.app"),
          artifact: { url: "https://example.invalid/codexhost.dmg", sha256: "a".repeat(64) },
        }),
      ).rejects.toThrow(FORK_SELF_UPDATE_DISABLED_MESSAGE);
      const linuxManager = createBackgroundUpdateManager({
        platform: "linux",
        download,
        spawnUpdater,
      });
      await expect(
        linuxManager.prepareLinuxArchive({
          ...common,
          artifact: {
            url: "https://example.invalid/codexhost.tar.gz",
            sha256: "a".repeat(64),
          },
          installRoot: join(root, "codexhost"),
        }),
      ).rejects.toThrow(FORK_SELF_UPDATE_DISABLED_MESSAGE);
      await expect(
        manager.start({
          version: common.version,
          installation: "npm",
          requestPath: join(root, "request"),
          statusPath: join(root, "status"),
          helperPath: updater,
        }),
      ).rejects.toThrow(FORK_SELF_UPDATE_DISABLED_MESSAGE);
      expect(await readdir(root)).toEqual(["updater"]);
      expect(download).not.toHaveBeenCalled();
      expect(spawnUpdater).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
