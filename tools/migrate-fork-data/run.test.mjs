import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { migrateForkData } from "./run.mjs";

let root;
afterEach(async () => {
  if (root) await rm(root, { force: true, recursive: true });
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "codexhost-test-migration-"));
  const shared = join(root, "shared");
  const source = join(shared, "remote", "data");
  const backup = join(root, "backup");
  await mkdir(join(source, "mapping-store", "threads"), { recursive: true });
  await writeFile(join(source, "mapping-store", "threads", "old.json"), "old");
  await writeFile(join(source, "mapping-store", "store.lock"), "old owner");
  await writeFile(join(source, "harness-preferences-v1.json"), "preferences", { mode: 0o600 });
  await writeFile(join(source, "pricing.json"), "price overrides");
  await writeFile(join(source, "remote-update.json"), "SSH state");
  await mkdir(join(shared, "runtime"));
  await writeFile(join(shared, "runtime", "sentinel"), "runtime state");
  return { source, shared, backup };
}

it("reports without writing, snapshots every moved dataset, and applies once", async () => {
  const paths = await fixture();
  const entries = ["mapping-store", "harness-preferences-v1.json", "pricing.json"];

  await expect(migrateForkData({ mode: "dry-run", ...paths })).resolves.toMatchObject({ entries });
  await expect(access(paths.backup)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(join(paths.shared, "mapping-store"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(migrateForkData({ mode: "apply", ...paths })).resolves.toMatchObject({ entries });
  await expect(migrateForkData({ mode: "apply", ...paths })).resolves.toMatchObject({
    entries: [],
  });

  expect((await stat(paths.backup)).mode & 0o077).toBe(0);
  await expect(
    readFile(join(paths.backup, "original", "mapping-store", "store.lock"), "utf8"),
  ).resolves.toBe("old owner");
  await expect(access(join(paths.shared, "mapping-store", "store.lock"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(access(join(paths.source, "mapping-store"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(
    readFile(join(paths.shared, "mapping-store", "threads", "old.json"), "utf8"),
  ).resolves.toBe("old");
  await expect(readFile(join(paths.shared, "harness-preferences-v1.json"), "utf8")).resolves.toBe(
    "preferences",
  );
  await expect(readFile(join(paths.source, "remote-update.json"), "utf8")).resolves.toBe(
    "SSH state",
  );
  await expect(readFile(join(paths.shared, "runtime", "sentinel"), "utf8")).resolves.toBe(
    "runtime state",
  );
  for (const data of [paths.source, paths.shared]) {
    await expect(readFile(join(data, "pricing.json"), "utf8")).resolves.toBe("price overrides");
  }
});

it("restores the old data once and retains writes made after cutover on both sides", async () => {
  const paths = await fixture();
  await migrateForkData({ mode: "apply", ...paths });
  await mkdir(join(paths.source, "mapping-store"));
  await writeFile(join(paths.source, "mapping-store", "ssh-new.json"), "SSH write");
  await writeFile(
    join(paths.shared, "mapping-store", "threads", "shared-new.json"),
    "shared write",
  );

  await migrateForkData({ mode: "rollback", ...paths });
  await expect(migrateForkData({ mode: "rollback", ...paths })).resolves.toMatchObject({
    entries: [],
  });
  await expect(
    readFile(join(paths.source, "mapping-store", "threads", "old.json"), "utf8"),
  ).resolves.toBe("old");
  await expect(readFile(join(paths.source, "harness-preferences-v1.json"), "utf8")).resolves.toBe(
    "preferences",
  );
  await expect(
    readFile(join(paths.backup, "rollback", "ssh", "mapping-store", "ssh-new.json"), "utf8"),
  ).resolves.toBe("SSH write");
  await expect(
    readFile(
      join(paths.backup, "rollback", "shared", "mapping-store", "threads", "shared-new.json"),
      "utf8",
    ),
  ).resolves.toBe("shared write");
  await expect(access(join(paths.shared, "mapping-store"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(access(join(paths.shared, "pricing.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(readFile(join(paths.source, "pricing.json"), "utf8")).resolves.toBe(
    "price overrides",
  );
});

it("refuses a destination conflict before moving any dataset", async () => {
  const paths = await fixture();
  await writeFile(join(paths.shared, "harness-preferences-v1.json"), "existing");
  for (const mode of ["dry-run", "apply"]) {
    await expect(migrateForkData({ mode, ...paths })).rejects.toThrow(
      "Both data roots contain harness-preferences-v1.json",
    );
  }
  await expect(access(paths.backup)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(join(paths.shared, "mapping-store"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(readFile(join(paths.shared, "harness-preferences-v1.json"), "utf8")).resolves.toBe(
    "existing",
  );
});

it("refuses to use a dataset as the shared root", async () => {
  const paths = await fixture();
  await expect(
    migrateForkData({ mode: "dry-run", ...paths, shared: join(paths.source, "mapping-store") }),
  ).rejects.toThrow("Data roots must be outside the migrated datasets");
});

it("reuses the Mac data root in place", async () => {
  const paths = await fixture();
  await expect(
    migrateForkData({ mode: "apply", ...paths, shared: paths.source }),
  ).resolves.toMatchObject({ entries: [], inPlace: true });
  await expect(access(paths.backup)).rejects.toMatchObject({ code: "ENOENT" });
});
