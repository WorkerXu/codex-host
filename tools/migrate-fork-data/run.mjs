import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// The shared Host takes over Thread data. The SSH Host still has its own official
// Codex path, so both Hosts retain the user's existing model price overrides.
const priceOverrides = "pricing.json";
const datasets = new Map([
  ["mapping-store", "directory"],
  ["thread-folders", "directory"],
  ["usage-measurements-v1", "directory"],
  ["harness-preferences-v1.json", "file"],
  ["harness-display-settings-v1.json", "file"],
  [priceOverrides, "file"],
]);

async function metadata(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== "..");
}

async function roots(source, shared, backup) {
  const from = await realpath(source);
  const to = await realpath(shared);
  const sourceStat = await stat(from);
  const targetStat = await stat(to);
  if (!sourceStat.isDirectory() || !targetStat.isDirectory())
    throw new Error("Source and shared paths must be directories");
  for (const name of datasets.keys()) {
    if (contains(path.join(from, name), to) || contains(path.join(to, name), from))
      throw new Error("Data roots must be outside the migrated datasets");
  }
  if (!backup) return { from, to };
  const resolved = path.resolve(backup);
  const parent = await realpath(path.dirname(resolved));
  const destination = path.join(parent, path.basename(resolved));
  if ([from, to].some((root) => contains(root, destination) || contains(destination, root)))
    throw new Error("Backup must be outside both data roots");
  if (from !== to && (await stat(parent)).dev !== sourceStat.dev)
    throw new Error("Backup and source must be on the same filesystem");
  if (sourceStat.dev !== targetStat.dev)
    throw new Error("Data roots must be on the same filesystem");
  return { from, to, backup: destination };
}

async function planMoves({ from, to }) {
  const entries = [];
  for (const [name, kind] of datasets) {
    const source = await metadata(path.join(from, name));
    if (!source) continue;
    if (kind === "directory" ? !source.isDirectory() : !source.isFile())
      throw new Error(`Unexpected source type for ${name}`);
    if (await metadata(path.join(to, name)))
      throw new Error(`Both data roots contain ${name}; resolve the destination conflict first`);
    entries.push(name);
  }
  return entries;
}

const snapshotOptions = {
  recursive: true,
  errorOnExist: true,
  force: false,
  mode: constants.COPYFILE_FICLONE,
  preserveTimestamps: true,
  async filter(file) {
    const entry = await lstat(file);
    if (!entry.isFile() && !entry.isDirectory())
      throw new Error("Migration datasets must contain only regular files and directories");
    return true;
  },
};

async function prepareBackup({ from, to, backup }, entries) {
  const pending = await mkdtemp(path.join(path.dirname(backup), ".fork-data-backup-"));
  try {
    for (const directory of ["original", "ready", "retired"]) {
      await mkdir(path.join(pending, directory), { mode: 0o700 });
    }
    for (const name of entries) {
      const original = path.join(pending, "original", name);
      await cp(path.join(from, name), original, snapshotOptions);
      await cp(original, path.join(pending, "ready", name), snapshotOptions);
    }
    if (entries.includes("mapping-store")) {
      await rm(path.join(pending, "ready", "mapping-store", "store.lock"), { force: true });
    }
    await writeFile(
      path.join(pending, "migration.json"),
      `${JSON.stringify({ version: 1, from, to, entries })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    await rename(pending, backup);
  } finally {
    await rm(pending, { recursive: true, force: true });
  }
}

async function readBackup({ from, to, backup }) {
  if (!backup) return undefined;
  const entry = await metadata(backup);
  if (!entry) return undefined;
  if (!entry.isDirectory() || (entry.mode & 0o077) !== 0)
    throw new Error("Backup must be a private directory");
  const manifest = JSON.parse(await readFile(path.join(backup, "migration.json"), "utf8"));
  if (
    manifest.version !== 1 ||
    manifest.from !== from ||
    manifest.to !== to ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.some((name) => !datasets.has(name)) ||
    new Set(manifest.entries).size !== manifest.entries.length
  )
    throw new Error("Backup does not match these data roots");
  return manifest.entries;
}

async function install({ from, to, backup }, entries) {
  if (await metadata(path.join(backup, "rollback")))
    throw new Error("This backup has been rolled back; use a new backup for another apply");

  // Check every destination before publishing any remaining staged dataset.
  for (const name of entries) {
    const ready = await metadata(path.join(backup, "ready", name));
    const committed = await metadata(path.join(to, name));
    if (Boolean(ready) === Boolean(committed))
      throw new Error(`Unexpected shared state for ${name}; inspect the backup before retrying`);
  }

  const moved = [];
  for (const name of entries) {
    const ready = path.join(backup, "ready", name);
    const retired = path.join(backup, "retired", name);
    const staged = await metadata(ready);
    const retire = name !== priceOverrides && !(await metadata(retired));
    if (staged) await rename(ready, path.join(to, name));
    if (retire) await rename(path.join(from, name), retired);
    if (staged || retire) moved.push(name);
  }
  return moved;
}

async function restore({ from, to, backup }, entries) {
  const rollback = path.join(backup, "rollback");
  const complete = path.join(rollback, "complete");
  if (await metadata(complete)) return [];
  await mkdir(rollback, { recursive: true, mode: 0o700 });
  for (const area of ["shared", "ssh"]) {
    await mkdir(path.join(rollback, area), { recursive: true, mode: 0o700 });
  }
  const restored = [];
  for (const name of entries) {
    const ready = path.join(backup, "ready", name);
    const shared = path.join(to, name);
    const archivedShared = path.join(rollback, "shared", name);
    // A remaining staging copy means apply never installed this dataset.
    if (!(await metadata(ready)) && !(await metadata(archivedShared)) && (await metadata(shared))) {
      await rename(shared, archivedShared);
      restored.push(name);
    }

    const retired = path.join(backup, "retired", name);
    if (!(await metadata(retired))) continue;
    const ssh = path.join(from, name);
    if (await metadata(ssh)) {
      const archivedSsh = path.join(rollback, "ssh", name);
      if (await metadata(archivedSsh))
        throw new Error(`SSH data reappeared during rollback: ${name}`);
      await rename(ssh, archivedSsh);
    }
    await rename(retired, ssh);
    if (!restored.includes(name)) restored.push(name);
  }
  await writeFile(complete, "", { mode: 0o600, flag: "wx" });
  return restored;
}

export async function migrateForkData({ mode, source, shared, backup }) {
  if (
    !["dry-run", "apply", "rollback"].includes(mode) ||
    !source ||
    !shared ||
    (mode !== "dry-run" && !backup)
  ) {
    throw new Error(
      "Usage: run.mjs dry-run|apply|rollback --source DIR --shared DIR [--backup DIR]",
    );
  }
  const locations = await roots(source, shared, backup);
  if (locations.from === locations.to) return { mode, inPlace: true, entries: [] };
  if (mode === "dry-run") {
    const saved = await readBackup(locations);
    const entries = saved ?? (await planMoves(locations));
    return { mode, entries, existingBackup: saved !== undefined };
  }

  const lock = path.join(locations.to, ".fork-data-migration.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST")
      throw new Error("Migration lock exists; check for an interrupted or active migration", {
        cause: error,
      });
    throw error;
  }
  try {
    let entries = await readBackup(locations);
    if (mode === "rollback") {
      if (!entries) throw new Error("Backup does not exist");
      return { mode, entries: await restore(locations, entries) };
    }
    if (!entries) {
      entries = await planMoves(locations);
      if (entries.length === 0) return { mode, entries };
      await prepareBackup(locations, entries);
    }
    return { mode, entries: await install(locations, entries) };
  } finally {
    await rmdir(lock);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [, , mode, ...args] = process.argv;
    const { values } = parseArgs({
      args,
      options: {
        source: { type: "string" },
        shared: { type: "string" },
        backup: { type: "string" },
      },
    });
    console.log(JSON.stringify(await migrateForkData({ mode, ...values })));
  } catch (error) {
    console.error(`Migration stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
