import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect } from "vitest";
import { codeBuddyNativeHistory, codeBuddyProjectSlug, readNativeHistory } from "../src/history.js";
import { CODEBUDDY_ID } from "../src/common.js";
describe("historical CodeBuddy workspace ownership", () => {
  it("accepts the previous cwd after an explicit working-folder change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cb-cwd-"));
    try {
      const previousCwd = path.join(root, "project");
      const cwd = path.join(previousCwd, "outer");
      const project = path.join(root, "config/projects", codeBuddyProjectSlug(previousCwd));
      await mkdir(cwd, { recursive: true });
      await mkdir(project, { recursive: true });
      await writeFile(
        path.join(project, "native.jsonl"),
        JSON.stringify({
          type: "message",
          role: "user",
          id: "u",
          sessionId: "native",
          cwd: previousCwd,
          content: "hello",
        }),
      );
      const contents = await readNativeHistory(
        cwd,
        { harnessId: CODEBUDDY_ID, nativeSessionId: "native", formatVersion: 1 },
        { CODEBUDDY_CONFIG_DIR: path.join(root, "config") },
        undefined,
        { previousCwd },
      );
      expect(contents).toContain(previousCwd);
      await expect(
        readNativeHistory(
          cwd,
          { harnessId: CODEBUDDY_ID, nativeSessionId: "native", formatVersion: 1 },
          { CODEBUDDY_CONFIG_DIR: path.join(root, "config") },
        ),
      ).rejects.toMatchObject({
        code: "invalidRequest",
        message: expect.stringContaining("different working directory"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("reports an unavailable historical cwd without calling an existing requested cwd missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cb-cwd-"));
    try {
      const project = path.join(root, "config/projects/fixture"),
        cwd = path.join(root, "current");
      await mkdir(project, { recursive: true });
      await mkdir(cwd);
      await writeFile(
        path.join(project, "native.jsonl"),
        JSON.stringify({
          type: "message",
          role: "user",
          id: "u",
          sessionId: "native",
          cwd: path.join(root, "removed"),
          content: "hello",
        }),
      );
      await expect(
        codeBuddyNativeHistory(
          cwd,
          { harnessId: CODEBUDDY_ID, nativeSessionId: "native", formatVersion: 1 },
          { CODEBUDDY_CONFIG_DIR: path.join(root, "config") },
        ),
      ).rejects.toMatchObject({
        code: "invalidRequest",
        message: expect.stringContaining("historical working directory"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
