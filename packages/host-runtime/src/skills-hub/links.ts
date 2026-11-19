import { required } from "./files.js";
import { setSource, sourceOverrides } from "./provenance.js";
import type { SkillSource } from "@codexhost/shared-contracts";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readlink,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import {
  skillKeySchema,
  type SkillLinkAction,
  type SkillLinkPlan,
} from "@codexhost/shared-contracts";
import { exists, fail, fingerprint, inside, readSkillFiles, safePath } from "./files.js";
import { inventory, library, type SkillPaths } from "./inventory.js";
import { isManagedSkill } from "./agents.js";
export interface SkillLinkPlanOptions {
  adopt?: { agentId: string; skill: string }[] | undefined;
  unlink?: { agentId: string; skill: string }[] | undefined;
  scope?: { agentId: string; skill: string } | undefined;
}
export async function planLinks(
  paths: SkillPaths,
  options: SkillLinkPlanOptions = {},
): Promise<SkillLinkPlan> {
  const { adopt = [], unlink = [], scope } = options;
  const current = await inventory(paths);
  const actions: SkillLinkAction[] = [];
  const root = library(paths);
  for (const agent of current.agents) {
    if (agent.excluded || agent.native === true) continue;
    try {
      await safePath(paths.home, agent.skillsDir);
    } catch {
      current.warnings.push(`${agent.name}: symlink_path`);
      continue;
    }
    const keys = new Set(current.skills.map((skill) => skill.key));
    if (await exists(agent.skillsDir))
      for (const entry of await readdir(agent.skillsDir))
        if (skillKeySchema.safeParse(entry).success) keys.add(entry);
    for (const key of keys) {
      if (isManagedSkill(agent.id, key)) continue;
      const file = path.join(agent.skillsDir, key),
        target = path.join(root, key);
      const base = {
        agentId: agent.id,
        skill: key,
        path: file,
        target,
        fingerprint: null,
        previousLink: null,
      };
      if (!(await exists(file))) {
        if (current.skills.some((skill) => skill.key === key))
          actions.push({ ...base, kind: "link" });
        continue;
      }
      const info = await lstat(file);
      if (info.isSymbolicLink()) {
        const link = await readlink(file),
          resolved = path.resolve(agent.skillsDir, link);
        if (inside(root, resolved) && !(await exists(resolved)))
          actions.push({ ...base, kind: "remove-dangling", previousLink: link });
        else if (resolved !== target)
          actions.push({ ...base, kind: "conflict", previousLink: link });
        continue;
      }
      if (!info.isDirectory()) {
        actions.push({ ...base, kind: "conflict" });
        continue;
      }
      try {
        const hash = fingerprint(await readSkillFiles(file));
        const selected = adopt.some((item) => item.agentId === agent.id && item.skill === key);
        actions.push({ ...base, fingerprint: hash, kind: selected ? "adopt" : "conflict" });
      } catch {
        actions.push({ ...base, kind: "conflict" });
      }
    }
  }
  for (const request of unlink) {
    const agent = current.agents.find((entry) => entry.id === request.agentId);
    if (!agent || agent.excluded || agent.native === true) continue;
    const file = path.join(agent.skillsDir, request.skill),
      target = path.join(root, request.skill);
    if (!(await exists(file))) continue;
    const info = await lstat(file);
    if (!info.isSymbolicLink()) continue;
    const previousLink = await readlink(file);
    const resolved = path.resolve(agent.skillsDir, previousLink);
    if (!inside(root, resolved)) continue;
    actions.push({
      kind: "unlink",
      agentId: request.agentId,
      skill: request.skill,
      path: file,
      target,
      fingerprint: null,
      previousLink,
    });
  }
  const filtered = scope
    ? actions.filter((action) => action.agentId === scope.agentId && action.skill === scope.skill)
    : actions;
  // Only one real directory may win for each central name in a single confirmation.
  const adopted = filtered
    .filter((action) => action.kind === "adopt")
    .map((action) => action.skill);
  if (new Set(adopted).size !== adopted.length) fail("duplicate_adoption");
  return { id: randomUUID(), hostId: "local", actions: filtered, warnings: current.warnings };
}
interface Change {
  action: SkillLinkAction;
  stage: "pending" | "backed-up" | "moved" | "done";
  backup: string | null;
  centralHash: string | null;
  sourceBefore?: SkillSource | null;
  sourceAfter?: SkillSource | null;
}
export interface Manifest {
  id: string;
  kind: "links" | "import";
  changes: Change[];
  undone: boolean;
}
export async function saveManifest(paths: SkillPaths, manifest: Manifest): Promise<void> {
  await mkdir(paths.state, { recursive: true, mode: 0o700 });
  const file = path.join(paths.state, `${manifest.id}.json`),
    temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}
export async function applyLinks(
  paths: SkillPaths,
  plan: SkillLinkPlan,
): Promise<{
  id: string;
  changed: number;
}> {
  const actions = plan.actions.filter((action) => action.kind !== "conflict");
  const current = await inventory(paths);
  const manifest: Manifest = { id: plan.id, kind: "links", undone: false, changes: [] };
  for (const [index, action] of actions.entries()) {
    await safePath(paths.home, path.dirname(action.path));
    const change: Change = { action, stage: "pending", backup: null, centralHash: null };
    if (action.kind === "adopt") {
      change.sourceBefore =
        current.skills.find((skill) => skill.key === action.skill)?.source ?? null;
      change.sourceAfter = null;
    }
    if (action.kind === "adopt" && (await exists(action.target))) {
      change.centralHash = fingerprint(await readSkillFiles(action.target));
      change.backup = path.join(paths.state, `${plan.id}-${index}.backup`);
    }
    manifest.changes.push(change);
  }
  await saveManifest(paths, manifest);
  // Persist each step so a partial failure can be inspected and undone by its preview ID.
  for (const change of manifest.changes) {
    const action = change.action;
    await mkdir(path.dirname(action.path), { recursive: true });
    if (action.kind === "remove-dangling" || action.kind === "unlink") {
      if (!(await lstat(action.path)).isSymbolicLink()) fail("stale_plan");
      if ((await readlink(action.path)) !== action.previousLink) fail("stale_plan");
      await unlink(action.path);
    } else if (action.kind === "adopt") {
      await safePath(paths.home, action.path);
      await safePath(paths.home, action.target);
      if (fingerprint(await readSkillFiles(action.path)) !== action.fingerprint) fail("stale_plan");
      await mkdir(path.dirname(action.target), { recursive: true });
      if (change.backup) {
        await rename(action.target, change.backup);
        change.stage = "backed-up";
        await saveManifest(paths, manifest);
      }
      await rename(action.path, action.target);
      change.stage = "moved";
      await saveManifest(paths, manifest);
      await symlink(path.relative(path.dirname(action.path), action.target), action.path, "dir");
    } else {
      if (await exists(action.path)) fail("stale_plan");
      await symlink(path.relative(path.dirname(action.path), action.target), action.path, "dir");
    }
    if (action.kind === "adopt") await setSource(paths, action.skill, null);
    change.stage = "done";
    await saveManifest(paths, manifest);
  }
  return { id: manifest.id, changed: manifest.changes.length };
}
export async function undoChanges(
  paths: SkillPaths,
  id: string,
): Promise<{
  id: string;
  changed: number;
}> {
  const manifest = JSON.parse(
    await readFile(path.join(paths.state, `${id}.json`), "utf8"),
  ) as Manifest;
  if (manifest.id !== id || manifest.undone) fail("unknown_change");
  // Validate the entire reversal before touching any skill.
  for (const change of manifest.changes) {
    if (change.stage === "pending") continue;
    const a = change.action;
    if (a.kind === "adopt") await safePath(paths.home, a.target);
    if (change.stage === "done" && change.sourceAfter !== undefined) {
      const current = (await sourceOverrides(paths))[a.skill] ?? null;
      if (JSON.stringify(current) !== JSON.stringify(change.sourceAfter)) fail("undo_conflict");
    }
    await safePath(paths.home, path.dirname(a.path));
    if (manifest.kind === "import") {
      await safePath(paths.home, a.path);
      if (change.stage === "done" && fingerprint(await readSkillFiles(a.path)) !== a.fingerprint)
        fail("undo_conflict");
      if (change.stage === "backed-up" && (await exists(a.path))) fail("undo_conflict");
    } else if (a.kind === "remove-dangling" || a.kind === "unlink") {
      if (await exists(a.path)) fail("undo_conflict");
    } else {
      if (
        change.stage === "done" &&
        (!(await lstat(a.path)).isSymbolicLink() ||
          (await readlink(a.path)) !== path.relative(path.dirname(a.path), a.target))
      )
        fail("undo_conflict");
      if (
        a.kind === "adopt" &&
        change.stage !== "backed-up" &&
        fingerprint(await readSkillFiles(a.target)) !== a.fingerprint
      )
        fail("undo_conflict");
    }
  }
  for (const change of [...manifest.changes].reverse()) {
    if (change.stage === "pending") continue;
    const a = change.action;
    if (manifest.kind === "import") {
      // Keep the replaced version as another backup, never discard a real skill.
      if (change.stage === "done")
        await rename(a.path, path.join(paths.state, `${id}.undone-skill`));
      if (change.backup) await rename(change.backup, a.path);
    } else if (a.kind === "remove-dangling" || a.kind === "unlink")
      await symlink(required(a.previousLink), a.path, "dir");
    else {
      if (change.stage === "done") await unlink(a.path);
      if (a.kind === "adopt") {
        if (change.stage !== "backed-up") await rename(a.target, a.path);
        if (change.backup) await rename(change.backup, a.target);
      }
    }
  }
  for (const change of manifest.changes) {
    if (change.stage !== "pending" && change.sourceBefore !== undefined)
      await setSource(paths, change.action.skill, change.sourceBefore);
  }
  manifest.undone = true;
  await saveManifest(paths, manifest);
  return { id, changed: manifest.changes.length };
}
