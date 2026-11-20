import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { JsonObject } from "@codexhost/protocol-core";

import type { ThreadHandoffReadInput } from "./delegation-types.js";
import { handoffItemsFromTurns, type HandoffItem } from "./thread-handoff-content.js";

/** What a conversation brought along when it moved to another Agent. */
export interface ThreadHandoffRecord {
  formatVersion: 2;
  /** The Thread the conversation moved to. */
  hostThreadId: string;
  sourceThreadId: string;
  sourceAgent: string;
  sourceTitle: string;
  targetAgent: string;
  createdAt: string;
  /**
   * The source's whole visible history, item by item. The receiving Agent
   * reads omitted items from here, so it never depends on the archived
   * source, or its Harness, still being available.
   */
  items: HandoffItem[];
  /** Read-only Turns shown above an external Thread's own history; empty for Codex. */
  turns: JsonObject[];
  /** Items the Agent received in its first request or injected context. */
  deliveredItemIds: string[];
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_MAX_CHARS = 4_000;
const MAX_MAX_CHARS = 20_000;
const PREVIEW_CHARS = 160;
const SOURCES_FILE = "sources.json";

export class ThreadHandoffReadError extends Error {
  constructor(
    readonly code: "THREAD_NOT_FOUND" | "INVALID_ARGUMENT",
    message: string,
  ) {
    super(message);
    this.name = "ThreadHandoffReadError";
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9._~-]+$/u.test(value)) throw new Error("Invalid Thread ID");
  return value;
}

export function defaultThreadHandoffDirectory(environment: NodeJS.ProcessEnv): string {
  const dataDirectory = environment.CODEXHOST_DATA_DIR;
  return path.join(
    dataDirectory ? path.resolve(dataDirectory) : path.join(os.homedir(), ".codexhost"),
    "thread-handoffs",
  );
}

/** Records written before items were kept carry only the display Turns. */
function upgrade(value: unknown, hostThreadId: string): ThreadHandoffRecord | null {
  if (!isRecord(value) || value.hostThreadId !== hostThreadId || !Array.isArray(value.turns)) {
    return null;
  }
  const turns = value.turns.filter(isRecord);
  if (value.formatVersion === 2 && Array.isArray(value.items)) {
    return value as unknown as ThreadHandoffRecord;
  }
  if (value.formatVersion !== 1) return null;
  return {
    formatVersion: 2,
    hostThreadId,
    sourceThreadId: typeof value.sourceThreadId === "string" ? value.sourceThreadId : "",
    sourceAgent: typeof value.sourceAgent === "string" ? value.sourceAgent : "",
    sourceTitle: "",
    targetAgent: "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    items: handoffItemsFromTurns(turns),
    turns,
    deliveredItemIds: [],
  };
}

async function writeAtomic(file: string, body: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** One private file per switched-to Thread, plus an index from each source to its Thread. */
export class ThreadHandoffStore {
  readonly #directory: string;
  readonly #cache = new Map<string, ThreadHandoffRecord | null>();
  #sources: Map<string, string> | null = null;
  #indexWrite: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.#directory = directory;
  }

  #file(hostThreadId: string): string {
    return path.join(this.#directory, `${safeId(hostThreadId)}.json`);
  }

  /** Turns already loaded for this Thread, or none. */
  cachedTurns(hostThreadId: string): readonly JsonObject[] {
    return this.#cache.get(hostThreadId)?.turns ?? [];
  }

  async load(hostThreadId: string): Promise<ThreadHandoffRecord | null> {
    if (this.#cache.has(hostThreadId)) return this.#cache.get(hostThreadId) ?? null;
    let record: ThreadHandoffRecord | null = null;
    try {
      record = upgrade(JSON.parse(await readFile(this.#file(hostThreadId), "utf8")), hostThreadId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#cache.set(hostThreadId, record);
    return record;
  }

  async #index(): Promise<Map<string, string>> {
    if (this.#sources) return this.#sources;
    const sources = new Map<string, string>();
    try {
      const parsed = JSON.parse(
        await readFile(path.join(this.#directory, SOURCES_FILE), "utf8"),
      ) as unknown;
      const entries = isRecord(parsed) && isRecord(parsed.sources) ? parsed.sources : {};
      for (const [source, target] of Object.entries(entries)) {
        if (typeof target === "string") sources.set(source, target);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#sources = sources;
    return sources;
  }

  #writeIndex(update: (sources: Map<string, string>) => void): Promise<void> {
    const next = this.#indexWrite.then(async () => {
      const sources = await this.#index();
      update(sources);
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await writeAtomic(
        path.join(this.#directory, SOURCES_FILE),
        JSON.stringify({ formatVersion: 1, sources: Object.fromEntries(sources) }),
      );
    });
    this.#indexWrite = next.catch(() => undefined);
    return next;
  }

  async save(record: ThreadHandoffRecord): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await writeAtomic(this.#file(record.hostThreadId), JSON.stringify(record));
    this.#cache.set(record.hostThreadId, record);
    if (record.sourceThreadId) {
      await this.#writeIndex((sources) => sources.set(record.sourceThreadId, record.hostThreadId));
    }
  }

  async remove(hostThreadId: string): Promise<void> {
    const record = await this.load(hostThreadId).catch(() => null);
    await rm(this.#file(hostThreadId), { force: true });
    this.#cache.delete(hostThreadId);
    if (record?.sourceThreadId) {
      await this.#writeIndex((sources) => {
        if (sources.get(record.sourceThreadId) === hostThreadId)
          sources.delete(record.sourceThreadId);
      });
    }
  }

  /** The Thread a source moved to, when it has moved. */
  async findBySource(sourceThreadId: string): Promise<ThreadHandoffRecord | null> {
    const target = (await this.#index()).get(sourceThreadId);
    return target ? this.load(target) : null;
  }

  /**
   * A switched-to Thread's handoff, item by item. Accepts the source Thread too,
   * so either end of the switch finds it.
   */
  async read(input: ThreadHandoffReadInput): Promise<JsonObject> {
    const record =
      (await this.load(safeId(input.threadId))) ?? (await this.findBySource(input.threadId));
    if (!record) {
      throw new ThreadHandoffReadError("THREAD_NOT_FOUND", "这段对话没有交接记录");
    }
    const summary = {
      threadId: record.hostThreadId,
      sourceThreadId: record.sourceThreadId,
      sourceAgent: record.sourceAgent,
      sourceTitle: record.sourceTitle,
      createdAt: record.createdAt,
      total: record.items.length,
    };
    const delivered = new Set(record.deliveredItemIds);
    if (input.item !== undefined) {
      const item = record.items.find(({ id }) => id === input.item);
      if (!item) throw new ThreadHandoffReadError("INVALID_ARGUMENT", `没有条目 ${input.item}`);
      const offset = Math.min(input.offset ?? 0, item.text.length);
      const maxChars = Math.min(input.maxChars ?? DEFAULT_MAX_CHARS, MAX_MAX_CHARS);
      const end = Math.min(item.text.length, offset + maxChars);
      return {
        ...summary,
        item: {
          id: item.id,
          turn: item.turn,
          kind: item.kind,
          role: item.role,
          status: item.status,
          delivered: delivered.has(item.id),
        },
        offset,
        nextOffset: end < item.text.length ? end : null,
        totalChars: item.text.length,
        text: item.text.slice(offset, end),
      };
    }
    const start = input.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new ThreadHandoffReadError("INVALID_ARGUMENT", "cursor 无效");
    }
    const limit = Math.min(input.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const page = record.items.slice(start, start + limit);
    return {
      ...summary,
      items: page.map((item) => ({
        id: item.id,
        turn: item.turn,
        kind: item.kind,
        role: item.role,
        status: item.status,
        chars: item.text.length,
        delivered: delivered.has(item.id),
        preview: item.text.replace(/\s+/gu, " ").slice(0, PREVIEW_CHARS),
      })),
      nextCursor: start + page.length < record.items.length ? String(start + page.length) : null,
    };
  }
}
