import { required } from "./files.js";
import { randomUUID } from "node:crypto";
import type { SkillMachine, SkillSyncPlan } from "@codexhost/shared-contracts";
import { fail } from "./files.js";
export interface SyncInput {
  skill: string;
  mode: "sync" | "fill";
  sourceHost?: string | undefined;
  to: string[];
  choices?: Record<string, string> | undefined;
}
/** Plans contain exact expected fingerprints; choosing a winner never authorizes a later version. */
export function planSync(machines: SkillMachine[], input: SyncInput): SkillSyncPlan {
  const plan: SkillSyncPlan = { id: randomUUID(), actions: [], conflicts: [] };
  for (const target of input.to)
    if (!machines.find((m) => m.hostId === target)?.inventory) fail("connection_failed");
  const sourceMachine = input.sourceHost
    ? machines.find((machine) => machine.hostId === input.sourceHost)
    : undefined;
  if (input.sourceHost && !sourceMachine?.inventory) fail("connection_failed");
  const keys =
    input.skill === "--all"
      ? [
          ...new Set(
            (sourceMachine ? [sourceMachine] : machines).flatMap(
              (m) => m.inventory?.skills.map((s) => s.key) ?? [],
            ),
          ),
        ].sort()
      : [input.skill];
  for (const skill of keys) {
    const versions = machines.flatMap((machine) => {
      const entry = machine.inventory?.skills.find((s) => s.key === skill);
      return entry ? [{ hostId: machine.hostId, name: machine.name, entry }] : [];
    });
    if (versions.length === 0) fail("skill_missing");
    let source =
      versions.find((v) => v.hostId === (input.choices?.[skill] ?? input.sourceHost)) ??
      required(versions[0]);
    if (input.choices?.[skill] && !versions.some((v) => v.hostId === input.choices?.[skill]))
      fail("invalid_choice");
    if (input.sourceHost && !versions.some((v) => v.hostId === input.sourceHost))
      fail("skill_missing");
    const targets = input.to.filter((target) => {
      const current = versions.find((v) => v.hostId === target);
      return input.mode === "sync" || !current;
    });
    const relevant =
      input.mode === "fill"
        ? versions
        : versions.filter((v) => targets.includes(v.hostId) || v.hostId === source.hostId);
    if (
      targets.length &&
      new Set(relevant.map((v) => v.entry.fingerprint)).size > 1 &&
      !input.choices?.[skill]
    ) {
      plan.conflicts.push({ skill, versions: relevant, diff: shortDiff(relevant) });
      continue;
    }
    if (input.choices?.[skill])
      source = required(versions.find((v) => v.hostId === input.choices?.[skill]));
    for (const targetHost of targets) {
      const expected = versions.find((v) => v.hostId === targetHost)?.entry.fingerprint ?? null;
      if (expected === source.entry.fingerprint) continue;
      plan.actions.push({
        skill,
        sourceHost: source.hostId,
        targetHost,
        fingerprint: source.entry.fingerprint,
        expected,
      });
    }
  }
  return plan;
}
function shortDiff(versions: SkillSyncPlan["conflicts"][number]["versions"]): string {
  const base = required(versions[0]);
  return versions
    .slice(1)
    .map((other) => {
      const lines = [`${base.name} → ${other.name}`];
      const left = base.entry.skillMd.split("\n"),
        right = other.entry.skillMd.split("\n");
      for (
        let index = 0;
        index < Math.max(left.length, right.length) && lines.length < 25;
        index++
      ) {
        if (left[index] === right[index]) continue;
        if (left[index] !== undefined) lines.push(`- ${required(left[index]).slice(0, 200)}`);
        if (right[index] !== undefined) lines.push(`+ ${required(right[index]).slice(0, 200)}`);
      }
      const names = new Set([...base.entry.files, ...other.entry.files].map((file) => file.path));
      for (const name of names) {
        const a = base.entry.files.find((file) => file.path === name),
          b = other.entry.files.find((file) => file.path === name);
        if (a?.hash !== b?.hash || a?.executable !== b?.executable)
          lines.push(`${!a ? "+" : !b ? "-" : "~"} ${name}`);
      }
      return lines.slice(0, 60).join("\n");
    })
    .join("\n\n");
}
