/**
 * Delegation mention carrier shared by the Renderer `#` picker and the Host.
 *
 * The Renderer inserts Codex Desktop's native `agentMention` node, which
 * Desktop serializes into the prompt as a Markdown link. `subagent://` is the
 * scheme Desktop already restores and renders as an agent chip; the
 * `codexhost.` prefix keeps these targets apart from native custom agent
 * roles. The Host must rewrite every carrier before the prompt reaches a
 * Harness, so the raw link never leaks into a model turn.
 */
export const DELEGATION_MENTION_PATH_PREFIX = "subagent://codexhost.";

const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const MENTION_LINK_PATTERN =
  /\[@([^\]\n]+)\]\(<?subagent:\/\/codexhost\.([a-z0-9][a-z0-9-]*)(?:\?host=([^)&\s>]+))?>?\)/gu;

export interface DelegationMention {
  harnessId: string;
  label: string;
  /** Desktop Host ID or peer name; absent for the local machine. */
  hostId?: string;
}

export function delegationMentionPath(harnessId: string, hostId?: string): string {
  if (!HARNESS_ID_PATTERN.test(harnessId)) {
    throw new Error(`Invalid delegation mention Harness id: ${harnessId}`);
  }
  return hostId
    ? `${DELEGATION_MENTION_PATH_PREFIX}${harnessId}?host=${encodeURIComponent(hostId)}`
    : `${DELEGATION_MENTION_PATH_PREFIX}${harnessId}`;
}

function sanitizeLabel(label: string): string {
  const cleaned = label
    .replace(/[[\]()\n\r]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "agent";
}

/** Markdown carrier Desktop restores into a native agent mention chip. */
export function formatDelegationMentionLink(mention: DelegationMention): string {
  return `[@${sanitizeLabel(mention.label)}](${delegationMentionPath(mention.harnessId, mention.hostId)})`;
}

export interface DelegationMentionRewrite {
  text: string;
  mentions: DelegationMention[];
}

/**
 * Replace each carrier link with its readable `@Label` form. Returns the
 * mentioned targets in first-seen order, without duplicates.
 */
export function stripDelegationMentions(text: string): DelegationMentionRewrite {
  const mentions: DelegationMention[] = [];
  const seen = new Set<string>();
  const rewritten = text.replace(
    MENTION_LINK_PATTERN,
    (_match, label: string, harnessId: string, encodedHostId?: string) => {
      const trimmed = label.trim();
      const hostId = encodedHostId ? decodeMentionHostId(encodedHostId) : undefined;
      const key = `${hostId ?? ""}\u0000${harnessId}`;
      if (!seen.has(key)) {
        seen.add(key);
        mentions.push({ harnessId, label: trimmed, ...(hostId ? { hostId } : {}) });
      }
      return `@${trimmed}`;
    },
  );
  return { text: rewritten, mentions };
}

function decodeMentionHostId(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Harness command carrier. Selecting a command in the `#` menu inserts it as a
 * native agent mention chip instead of literal `/command` text, which would
 * open Desktop's own `/` menu. The Host restores it to a leading
 * `/command arguments` before External Harness command matching.
 */
export const HARNESS_COMMAND_MENTION_PATH_PREFIX = "subagent://codexhost-command.";

const COMMAND_LINK_PATTERN =
  /([ \t]*)\[@([^\]\n]+)\]\(<?subagent:\/\/codexhost-command\.([^)\s>]+)>?\)([ \t]*)/gu;

export function harnessCommandMentionPath(invocation: string): string {
  const name = invocation.trim().replace(/^\//u, "");
  if (!name || /\s/u.test(name)) throw new Error(`Invalid Harness command: ${invocation}`);
  return `${HARNESS_COMMAND_MENTION_PATH_PREFIX}${encodeURIComponent(name).replace(
    /[()]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;
}

/**
 * Move the first command carrier to the front as `/command`, keeping the rest
 * of the text as its arguments. Other command carriers are dropped. Text
 * without a carrier is returned unchanged.
 */
export function restoreHarnessCommandMentions(text: string): string {
  let invocation: string | null = null;
  const rest = text.replace(
    COMMAND_LINK_PATTERN,
    (match, before: string, _label: string, encoded: string, after: string) => {
      if (invocation === null) {
        try {
          invocation = `/${decodeURIComponent(encoded)}`;
        } catch {
          return match;
        }
      }
      // Normalize only the separator left by this chip, not argument whitespace.
      return before || after ? " " : "";
    },
  );
  if (invocation === null) return text;
  const argumentsText = rest.trim();
  return argumentsText ? `${invocation} ${argumentsText}` : invocation;
}
