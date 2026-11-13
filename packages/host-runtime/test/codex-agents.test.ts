import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "smol-toml";

import { CodexAgentError, CodexAgentStore } from "../src/codex-agents.js";

const directories: string[] = [];

async function createStore(): Promise<{ store: CodexAgentStore; home: string }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "codexhost-codex-agents-"));
  directories.push(home);
  await mkdir(path.join(home, "agents"), { recursive: true });
  return { store: new CodexAgentStore({ codexHome: home }), home };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const FIXTURE = `name = "terra_worker"
description = "High-effort worker for bounded delegated subtasks."
model = "gpt-5.6-terra"
model_reasoning_effort = "xhigh"

developer_instructions = """
Do the bounded task and verify the result.
"""

sandbox_mode = "read-only"

[features]
shell_tool = false

[[skills.config]]
path = "/Users/me/.agents/skills/docs-editor/SKILL.md"
enabled = false
`;

async function writeFixture(home: string): Promise<void> {
  const agents = path.join(home, "agents");
  await writeFile(path.join(agents, "terra-worker.toml"), FIXTURE, { encoding: "utf8" });
}

async function storeWithFixture(): Promise<{ store: CodexAgentStore; home: string }> {
  const created = await createStore();
  await created.store.list();
  await writeFixture(created.home);
  return created;
}

describe("CodexAgentStore", () => {
  it("lists and reads an agent without requiring known optional keys", async () => {
    const { store } = await storeWithFixture();
    const listed = await store.list();
    expect(listed.directory).toBe(store.directory);
    expect(listed.issues).toEqual([]);
    expect(listed.agents).toHaveLength(1);
    expect(listed.agents[0]).toMatchObject({
      fileName: "terra-worker.toml",
      name: "terra_worker",
      model: "gpt-5.6-terra",
      reasoningEffort: "xhigh",
    });
    expect(listed.agents[0]?.revision).toMatch(/^[0-9]+-[0-9]+$/u);

    const record = await store.read("terra-worker.toml");
    expect(record.developerInstructions).toContain("Do the bounded task");
    expect(record.revision).toBe(listed.agents[0]?.revision);
  });

  it("round-trips unknown TOML keys and keeps the existing file name", async () => {
    const { store, home } = await storeWithFixture();
    const current = await store.read("terra-worker.toml");
    const saved = await store.save({
      fileName: "terra-worker.toml",
      expectedRevision: current.revision,
      name: "terra_worker",
      description: "Updated description.",
      model: null,
      reasoningEffort: "high",
      developerInstructions: "Updated instructions.\n",
    });
    expect(saved.fileName).toBe("terra-worker.toml");
    expect(saved.description).toBe("Updated description.");
    expect(saved.model).toBeNull();
    expect(saved.reasoningEffort).toBe("high");

    const raw = await readFile(path.join(home, "agents", "terra-worker.toml"), "utf8");
    const parsed = parse(raw) as Record<string, unknown>;
    expect(parsed.name).toBe("terra_worker");
    expect(parsed.description).toBe("Updated description.");
    expect(parsed.developer_instructions).toBe("Updated instructions.\n");
    expect(parsed.model).toBeUndefined();
    expect(parsed.model_reasoning_effort).toBe("high");
    expect(parsed.sandbox_mode).toBe("read-only");
    expect(parsed.features).toEqual({ shell_tool: false });
    expect(parsed.skills).toEqual({
      config: [{ path: "/Users/me/.agents/skills/docs-editor/SKILL.md", enabled: false }],
    });
  });

  it("creates a new agent atomically with mode 0600", async () => {
    const { store, home } = await createStore();
    const record = await store.save({
      fileName: null,
      expectedRevision: null,
      name: "new_worker",
      description: "A new worker.",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      developerInstructions: "Do the work.",
    });
    expect(record.fileName).toBe("new_worker.toml");
    const file = path.join(home, "agents", "new_worker.toml");
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect((await readdir(path.join(home, "agents"))).sort()).toEqual(["new_worker.toml"]);
    await expect(
      store.save({
        fileName: null,
        expectedRevision: null,
        name: "new_worker",
        description: "Another worker.",
        model: null,
        reasoningEffort: null,
        developerInstructions: "Do other work.",
      }),
    ).rejects.toMatchObject({ code: "name_taken" });
  });

  it("preserves an existing file mode on update", async () => {
    const { store, home } = await storeWithFixture();
    const file = path.join(home, "agents", "terra-worker.toml");
    if (process.platform === "win32") return;
    await chmod(file, 0o640);
    const current = await store.read("terra-worker.toml");
    await store.save({
      fileName: "terra-worker.toml",
      expectedRevision: current.revision,
      name: "terra_worker",
      description: current.description,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      developerInstructions: current.developerInstructions,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o640);
  });

  it("rejects a stale revision instead of overwriting a concurrent edit", async () => {
    const { store, home } = await storeWithFixture();
    const current = await store.read("terra-worker.toml");
    await writeFile(path.join(home, "agents", "terra-worker.toml"), `${FIXTURE}\n# edited\n`);
    await expect(
      store.save({
        fileName: "terra-worker.toml",
        expectedRevision: current.revision,
        name: "terra_worker",
        description: current.description,
        model: current.model,
        reasoningEffort: current.reasoningEffort,
        developerInstructions: current.developerInstructions,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("deletes only the selected regular file and checks its revision", async () => {
    const { store, home } = await storeWithFixture();
    const current = await store.read("terra-worker.toml");
    await expect(store.delete("terra-worker.toml", "0-0")).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await writeFile(path.join(home, "agents", "terra-worker.toml"), `${FIXTURE}\n# edited\n`);
    const edited = await store.read("terra-worker.toml");
    await store.delete("terra-worker.toml", edited.revision);
    expect((await store.list()).agents).toEqual([]);
    expect(current.fileName).toBe("terra-worker.toml");
  });

  it("rejects traversal and names Codex cannot address", async () => {
    const { store } = await storeWithFixture();
    for (const fileName of [
      "../escape.toml",
      "/tmp/escape.toml",
      "nested/agent.toml",
      ".hidden.toml",
    ]) {
      await expect(store.read(fileName)).rejects.toMatchObject({ code: "invalid_file_name" });
    }
    await expect(
      store.save({
        fileName: "../escape.toml",
        expectedRevision: null,
        name: "safe_name",
        description: "Description.",
        model: null,
        reasoningEffort: null,
        developerInstructions: "Instructions.",
      }),
    ).rejects.toMatchObject({ code: "invalid_file_name" });
    for (const name of ["", "has space", "../evil", "-leading", "x".repeat(65)]) {
      await expect(
        store.save({
          fileName: null,
          expectedRevision: null,
          name,
          description: "Description.",
          model: null,
          reasoningEffort: null,
          developerInstructions: "Instructions.",
        }),
      ).rejects.toMatchObject({ code: "invalid_name" });
    }
  });

  it("rejects blank required fields", async () => {
    const { store } = await createStore();
    await expect(
      store.save({
        fileName: null,
        expectedRevision: null,
        name: "blank_agent",
        description: "   ",
        model: null,
        reasoningEffort: null,
        developerInstructions: "Instructions.",
      }),
    ).rejects.toMatchObject({ code: "invalid_field" });
    await expect(
      store.save({
        fileName: null,
        expectedRevision: null,
        name: "blank_agent",
        description: "Description.",
        model: null,
        reasoningEffort: null,
        developerInstructions: "\n",
      }),
    ).rejects.toMatchObject({ code: "invalid_field" });
  });

  it("reports unreadable files instead of hiding them", async () => {
    const { store, home } = await storeWithFixture();
    const agents = path.join(home, "agents");
    await writeFile(path.join(agents, "broken.toml"), "name = [");
    await writeFile(path.join(agents, "missing.toml"), 'name = "missing"\n');
    const listed = await store.list();
    expect(listed.agents.map((agent) => agent.name)).toEqual(["terra_worker"]);
    expect(
      listed.issues.sort((left, right) => left.fileName.localeCompare(right.fileName)),
    ).toEqual([
      { fileName: "broken.toml", reason: "invalid_toml" },
      { fileName: "missing.toml", reason: "missing_fields" },
    ]);
  });

  it("refuses to follow a symlink out of the agents directory", async () => {
    if (process.platform === "win32") return;
    const { store, home } = await createStore();
    const outside = path.join(home, "outside.toml");
    await writeFile(outside, FIXTURE);
    await store.list();
    await symlink(outside, path.join(home, "agents", "linked.toml"));
    await expect(store.read("linked.toml")).rejects.toMatchObject({
      code: "invalid_file_name",
    });
    expect((await store.list()).agents).toEqual([]);
  });

  it("uses invalid_toml for a direct read of a broken file", async () => {
    const { store, home } = await createStore();
    await store.list();
    await writeFile(path.join(home, "agents", "broken.toml"), "not = [valid");
    await expect(store.read("broken.toml")).rejects.toBeInstanceOf(CodexAgentError);
    await expect(store.read("broken.toml")).rejects.toMatchObject({ code: "invalid_toml" });
  });
});
