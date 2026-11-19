import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { JsonObject, JsonValue } from "@codexhost/protocol-core";

/**
 * Moving a conversation to another Agent on the same Host. The next Agent gets
 * the visible history (user and Agent text) in the form it can take natively:
 * Codex through its official external-session import, every other Harness as a
 * `<codexhost_handoff>` block before the person's next request. MemHub skips
 * both forms, since the history is already imported from the Agent that wrote it.
 */

/** One visible message of the conversation being handed over. */
export interface HandoffMessage {
  role: "user" | "assistant";
  text: string;
  /** Unix milliseconds, when the source recorded it. */
  createdAtMs: number | null;
}

/**
 * How much history an Agent receives in its first request, as UTF-8 bytes
 * (about 16k tokens). The most recent messages are kept; the person's new
 * request is never cut.
 */
export const HANDOFF_BUDGET_BYTES = 64 * 1024;

/** The Agent message Codex appends to a session it imported; not part of the conversation. */
const CODEX_IMPORT_MARKER = "<EXTERNAL SESSION IMPORTED>";

/** Where Codex's import accepts a session: under the Claude home's `projects`. */
export const CLAUDE_HANDOFF_DIRECTORY = "codexhost-handoff";

const HANDOFF_ATTRIBUTES = String.raw`(?:\s+[\w:-]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*\s*`;
const HANDOFF_OPEN = new RegExp(String.raw`^<codexhost_handoff${HANDOFF_ATTRIBUTES}>`, "u");
const HANDOFF_TOKEN = String.raw`<\/codexhost_handoff\s*>|<codexhost_handoff${HANDOFF_ATTRIBUTES}>`;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closingEnd(value: string, from: number): number | null {
  const tokens = new RegExp(HANDOFF_TOKEN, "gu");
  tokens.lastIndex = from;
  let depth = 1;
  for (let token = tokens.exec(value); token; token = tokens.exec(value)) {
    depth += token[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return token.index + token[0].length;
  }
  return null;
}

/** The text after leading handoff blocks; unclosed markup is left untouched. */
export function stripHandoffBlock(text: string): string {
  let remaining = text.trimStart();
  let stripped = false;
  for (
    let opening = HANDOFF_OPEN.exec(remaining);
    opening;
    opening = HANDOFF_OPEN.exec(remaining)
  ) {
    const end = closingEnd(remaining, opening[0].length);
    if (end === null) return text;
    remaining = remaining.slice(end).trimStart();
    stripped = true;
  }
  return stripped ? remaining : text;
}

/** A quoted block inside the history must not close or open the outer one. */
function escapeHandoffText(text: string): string {
  return text.replace(/<(\/?)codexhost_handoff/gu, "&lt;$1codexhost_handoff");
}

function attributeValue(value: string): string {
  return value.replace(/["'<>\s]/gu, "");
}

function seconds(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000)
    : null;
}

function userText(content: JsonValue | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

/** User and Agent text of Desktop-protocol Turns, in order; tool activity is left out. */
export function handoffMessagesFromTurns(turns: readonly JsonValue[]): HandoffMessage[] {
  const messages: HandoffMessage[] = [];
  for (const turn of turns) {
    if (!isRecord(turn) || !Array.isArray(turn.items)) continue;
    const startedAtMs = seconds(turn.startedAt);
    const completedAtMs = seconds(turn.completedAt) ?? startedAtMs;
    for (const item of turn.items) {
      if (!isRecord(item)) continue;
      if (item.type === "userMessage") {
        const text = stripHandoffBlock(userText(item.content)).trim();
        if (text) messages.push({ role: "user", text, createdAtMs: startedAtMs });
      } else if (item.type === "agentMessage" && typeof item.text === "string") {
        const text = item.text.trim();
        if (text && text !== CODEX_IMPORT_MARKER) {
          messages.push({ role: "assistant", text, createdAtMs: completedAtMs });
        }
      }
    }
  }
  return messages;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function tailWithinBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const characters = [...text];
  let size = 0;
  let start = characters.length;
  while (start > 0) {
    const next = byteLength(characters[start - 1] as string);
    if (size + next > maxBytes) break;
    size += next;
    start -= 1;
  }
  return characters.slice(start).join("");
}

/** The history an external Harness reads before the person's next request. */
export function handoffBlock(input: {
  fromAgent: string;
  fromLabel: string;
  threadId: string;
  messages: readonly HandoffMessage[];
  budgetBytes?: number;
}): string {
  const budget = input.budgetBytes ?? HANDOFF_BUDGET_BYTES;
  const sections: string[] = [];
  let used = 0;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index] as HandoffMessage;
    const heading = message.role === "user" ? "### 用户" : "### 助手";
    let section = `${heading}\n${escapeHandoffText(message.text)}`;
    const size = byteLength(section) + 2;
    if (used + size > budget) {
      if (sections.length > 0) break;
      // The latest message alone is over the budget: keep its end.
      const marker = `${heading}\n…（前文省略）\n`;
      section =
        marker + tailWithinBytes(escapeHandoffText(message.text), budget - byteLength(marker));
    }
    sections.unshift(section);
    used += size;
  }
  const omitted = input.messages.length - sections.length;
  const intro = [
    `这段对话此前在 ${input.fromLabel} 中进行，用户把它切换给你继续。下面是此前的对话记录，只供你了解上下文；请直接接续本块之后用户的请求。`,
    ...(omitted > 0 ? [`更早的 ${omitted} 条消息未包含。`] : []),
  ].join("\n");
  const attributes = [
    `from="${attributeValue(input.fromAgent)}"`,
    `thread="${attributeValue(input.threadId)}"`,
    `messages="${sections.length}"`,
    `omitted="${omitted}"`,
  ].join(" ");
  return `<codexhost_handoff ${attributes}>\n${intro}\n\n${sections.join("\n\n")}\n</codexhost_handoff>`;
}

/**
 * The history as a Claude Code session file, the format Codex's external-session
 * import reads. Only user and Agent text is written.
 */
export function claudeSessionJsonl(input: {
  sessionId: string;
  cwd: string;
  title: string;
  messages: readonly HandoffMessage[];
  nowMs: number;
}): string {
  const lines: JsonObject[] = [];
  if (input.title.trim()) {
    lines.push({
      type: "custom-title",
      customTitle: input.title.trim(),
      sessionId: input.sessionId,
    });
  }
  let last: number | null = null;
  input.messages.forEach((message, index) => {
    const at = message.createdAtMs ?? last ?? input.nowMs;
    last = at;
    const base = {
      sessionId: input.sessionId,
      uuid: `${input.sessionId}-${index + 1}`,
      cwd: input.cwd,
      timestamp: new Date(at).toISOString(),
      isSidechain: false,
    };
    lines.push(
      message.role === "user"
        ? { ...base, type: "user", message: { role: "user", content: message.text } }
        : {
            ...base,
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: message.text }] },
          },
    );
  });
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

/**
 * Read-only Turns that show the earlier conversation above a new external
 * Thread's own history. They carry no native Checkpoint, so fork and edit
 * stay unavailable on them.
 */
export function handoffSnapshotTurns(
  messages: readonly HandoffMessage[],
  idPrefix: string,
): JsonObject[] {
  const groups: { user: HandoffMessage | null; answers: HandoffMessage[] }[] = [];
  for (const message of messages) {
    const current = groups.at(-1);
    if (message.role === "user" || !current) {
      groups.push({
        user: message.role === "user" ? message : null,
        answers: message.role === "assistant" ? [message] : [],
      });
    } else {
      current.answers.push(message);
    }
  }
  return groups.map((group, index) => {
    const id = `${idPrefix}-${index + 1}`;
    const started = group.user?.createdAtMs ?? group.answers[0]?.createdAtMs ?? null;
    const completed = group.answers.at(-1)?.createdAtMs ?? started;
    const timed = started !== null && completed !== null && completed >= started;
    return {
      id,
      status: "completed",
      items: [
        ...(group.user
          ? [
              {
                id: `${id}-user`,
                type: "userMessage",
                clientId: null,
                content: [{ type: "text", text: group.user.text, text_elements: [] }],
              },
            ]
          : []),
        ...group.answers.map((answer, position) => ({
          id: `${id}-agent-${position + 1}`,
          type: "agentMessage",
          text: answer.text,
          phase: position === group.answers.length - 1 ? "final_answer" : null,
          memoryCitation: null,
        })),
      ],
      error: null,
      startedAt: timed ? Math.floor((started as number) / 1000) : null,
      completedAt: timed ? Math.floor((completed as number) / 1000) : null,
      durationMs: timed ? (completed as number) - (started as number) : null,
      itemsView: "full",
    };
  });
}

/** Hides a handoff block in the first user message of a Thread's own history. */
export function withoutHandoffBlock(turn: JsonObject): JsonObject {
  if (!Array.isArray(turn.items)) return turn;
  let changed = false;
  const items = turn.items.map((item) => {
    if (changed || !isRecord(item) || item.type !== "userMessage" || !Array.isArray(item.content)) {
      return item;
    }
    const content = item.content.map((part) => {
      if (changed || !isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
        return part;
      }
      const text = stripHandoffBlock(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { ...item, content } : item;
  });
  return changed ? { ...turn, items } : turn;
}

export interface ThreadHandoffRecord {
  formatVersion: 1;
  hostThreadId: string;
  sourceThreadId: string;
  sourceAgent: string;
  createdAt: string;
  turns: JsonObject[];
}

export function defaultThreadHandoffDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR;
  return path.join(
    dataDirectory ? path.resolve(dataDirectory) : path.join(os.homedir(), ".codexhost"),
    "thread-handoffs",
  );
}

/** The earlier conversation shown above each switched-to external Thread, one file per Thread. */
export class ThreadHandoffStore {
  readonly #directory: string;
  readonly #cache = new Map<string, ThreadHandoffRecord | null>();

  constructor(directory: string) {
    this.#directory = directory;
  }

  #file(hostThreadId: string): string {
    if (!/^[A-Za-z0-9._~-]+$/u.test(hostThreadId)) throw new Error("Invalid Thread ID");
    return path.join(this.#directory, `${hostThreadId}.json`);
  }

  /** Turns already loaded for this Thread, or none. */
  cachedTurns(hostThreadId: string): readonly JsonObject[] {
    return this.#cache.get(hostThreadId)?.turns ?? [];
  }

  async load(hostThreadId: string): Promise<ThreadHandoffRecord | null> {
    if (this.#cache.has(hostThreadId)) return this.#cache.get(hostThreadId) ?? null;
    let record: ThreadHandoffRecord | null = null;
    try {
      const parsed = JSON.parse(await readFile(this.#file(hostThreadId), "utf8")) as unknown;
      if (
        isRecord(parsed) &&
        parsed.formatVersion === 1 &&
        parsed.hostThreadId === hostThreadId &&
        Array.isArray(parsed.turns)
      ) {
        record = parsed as unknown as ThreadHandoffRecord;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#cache.set(hostThreadId, record);
    return record;
  }

  async save(record: ThreadHandoffRecord): Promise<void> {
    const file = this.#file(record.hostThreadId);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    this.#cache.set(record.hostThreadId, record);
  }

  async remove(hostThreadId: string): Promise<void> {
    await rm(this.#file(hostThreadId), { force: true });
    this.#cache.delete(hostThreadId);
  }
}
