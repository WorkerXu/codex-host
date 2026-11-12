import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectMirrorRevisionConflictError,
  ProjectMirrorService,
} from "../src/project-mirror-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-project-mirror-service-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Project mirror service", () => {
  it("lists acknowledgements and records", async () => {
    const directory = await temporaryDirectory();
    const service = new ProjectMirrorService({
      directory,
      now: () => new Date("2026-11-12T03:00:05.000Z"),
    });
    await service.upsert({ revision: 0, sourceProjectId: "local-alpha", acknowledge: true });
    const result = await service.upsert({
      revision: 1,
      sourceProjectId: "local-alpha",
      record: {
        hostId: "remote-ssh-discovered:colab",
        remoteProjectId: "project-1",
        remotePath: "/root/Documents/ChatGPT/alpha",
        label: "alpha",
        createdAt: "2026-11-12T03:00:00.000Z",
        updatedAt: "2026-11-12T03:00:00.000Z",
      },
    });

    expect(result.revision).toBe(2);
    expect(result.acknowledged).toEqual(["local-alpha"]);
    expect(result.projects["local-alpha"]).toMatchObject({
      remotePath: "/root/Documents/ChatGPT/alpha",
      updatedAt: "2026-11-12T03:00:05.000Z",
    });
  });

  it("reports revision conflicts", async () => {
    const directory = await temporaryDirectory();
    const service = new ProjectMirrorService({ directory });
    await service.upsert({ revision: 0, sourceProjectId: "local-alpha", acknowledge: true });
    await expect(
      service.upsert({ revision: 0, sourceProjectId: "local-alpha", acknowledge: true }),
    ).rejects.toBeInstanceOf(ProjectMirrorRevisionConflictError);
  });
});
