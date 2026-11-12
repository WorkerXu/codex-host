import { stripDelegationMentions, type DelegationMention } from "@codexhost/shared-contracts";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

/** Native Codex `skill` UserInput pointing at the managed delegation Skill. */
export interface DelegationSkillReference {
  name: string;
  path: string;
}

function code(value: string): string {
  return `\`${value.replace(/[`\n\r]/gu, "")}\``;
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9._:/@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function delegationCommand(mention: DelegationMention): string {
  const host = mention.hostId ? ` --host ${shellArgument(mention.hostId)}` : "";
  return `codexhost delegate start --harness ${shellArgument(mention.harnessId)}${host} --task-name "<short-name>" --task "<task>" --watch true --format compact`;
}

function describeTargets(mentions: readonly DelegationMention[]): string {
  return mentions
    .map(({ harnessId, label, hostId }) =>
      hostId
        ? `@${label} on machine ${code(hostId)} (Harness ${code(harnessId)}, pass \`--host ${hostId.replace(/[`\n\r]/gu, "")}\`)`
        : `@${label} (Harness ${code(harnessId)})`,
    )
    .join(", ");
}

/**
 * Explicit, model-facing delegation request derived from `#` mention chips.
 * The target Harness and optional machine are resolved by the Host, so the
 * model does not guess them, and the exact command avoids a help/discovery
 * round trip before the delegation starts.
 */
export function delegationMentionInstruction(mentions: readonly DelegationMention[]): string {
  const lines = mentions.map((mention) => delegationCommand(mention));
  return [
    `[codexhost delegation] The user mentioned ${describeTargets(mentions)}.`,
    "Execute the matching command below directly; do not run `--help` or `peer list` first.",
    "Replace `<task>` with the user's request and `<short-name>` with a 1-120 character task name.",
    "Keep `--watch true`: the Host notifies this Thread once when the child stops, so do not poll or loop on `thread wait`.",
    "Do not do the task yourself.",
    "```sh",
    ...lines,
    "```",
  ].join("\n");
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
      if (seen.has(mention.harnessId)) continue;
      seen.add(mention.harnessId);
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
