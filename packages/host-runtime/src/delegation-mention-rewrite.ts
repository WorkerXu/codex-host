import { stripDelegationMentions, type DelegationMention } from "@codexhost/shared-contracts";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

import { DELEGATION_SKILL_NAME } from "./delegation-skill.js";

/** Native Codex `skill` UserInput pointing at the managed delegation Skill. */
export interface DelegationSkillReference {
  name: string;
  path: string;
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_.:@%+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function describeTargets(mentions: readonly DelegationMention[]): string {
  return mentions
    .map(
      ({ harnessId, label, hostId }) =>
        `@${label} (Harness \`${harnessId}\`)${hostId ? ` on ${hostId}` : ""}`,
    )
    .join(", ");
}

/**
 * Explicit, model-facing delegation request derived from `#` mention chips.
 * The target Harness is resolved by the Host, so the model does not guess it.
 */
export function delegationMentionInstruction(mentions: readonly DelegationMention[]): string {
  const plural = mentions.length > 1;
  return [
    `[codexhost delegation] The user mentioned ${describeTargets(mentions)}.`,
    `Use the ${DELEGATION_SKILL_NAME} skill to delegate this request to ${plural ? "each mentioned Harness" : "that Harness"}`,
    "through the executable in CODEXHOST_CLI_PATH.",
    "Run the command for each selected Harness directly, replacing the task and name placeholders.",
    "Skip --help and peer list. Wait for the Host's notification instead of polling thread wait.",
    ...mentions.map(({ harnessId, hostId }) => {
      const host = hostId ? ` --host ${shellArgument(hostId)}` : "";
      return `
codexhost delegate start${host} --harness ${harnessId} --task "<task>" --task-name "<short-name>" --watch true --format compact`;
    }),
    "\nRead the returned Thread link when reporting results or following up.",
  ].join(" ");
}

function appendInstruction(text: string, mentions: readonly DelegationMention[]): string {
  const instruction = delegationMentionInstruction(mentions);
  return text.trim().length === 0 ? instruction : `${text}\n\n${instruction}`;
}

/** External Harness Turns carry plain text only. */
export function rewriteDelegationMentionText(text: string): string {
  const { text: stripped, mentions } = stripDelegationMentions(text);
  return mentions.length === 0 ? text : appendInstruction(stripped, mentions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rewrite a native Codex `turn/start` / `turn/steer` input array. Returns null
 * when no delegation mention is present so the original frame is forwarded
 * untouched. When the managed Skill is available it is attached as a native
 * `skill` input item so Codex loads it deterministically.
 */
export function rewriteDelegationMentionInput(
  input: readonly JsonValue[],
  skill: DelegationSkillReference | null,
): JsonValue[] | null {
  const mentions: DelegationMention[] = [];
  const seen = new Set<string>();
  let lastTextIndex = -1;
  const rewritten = input.map((item, index): JsonValue => {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return item;
    lastTextIndex = index;
    const result = stripDelegationMentions(item.text);
    for (const mention of result.mentions) {
      const key = JSON.stringify([mention.hostId, mention.harnessId]);
      if (seen.has(key)) continue;
      seen.add(key);
      mentions.push(mention);
    }
    return result.mentions.length === 0 ? item : ({ ...item, text: result.text } as JsonObject);
  });
  if (mentions.length === 0) return null;

  const target = rewritten[lastTextIndex];
  if (isRecord(target) && typeof target.text === "string") {
    rewritten[lastTextIndex] = {
      ...target,
      text: appendInstruction(target.text, mentions),
    } as JsonObject;
  }
  const hasSkill = rewritten.some(
    (item) => isRecord(item) && item.type === "skill" && item.name === skill?.name,
  );
  if (skill && !hasSkill) rewritten.push({ type: "skill", name: skill.name, path: skill.path });
  return rewritten;
}
