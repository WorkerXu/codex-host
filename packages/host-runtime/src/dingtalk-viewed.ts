import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { codexhostUserDirectory } from "./runtime-control-file.js";

export const DINGTALK_VIEWED_FILE = "dingtalk-viewed.json";
const MAX_ENTRIES = 500;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * dws cannot mark messages read. codexhost therefore remembers the newest
 * message time the user opened per conversation and hides that conversation
 * from the unread list until a newer message arrives.
 */
export class DingTalkViewedStore {
  readonly #directory: string;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.#directory = codexhostUserDirectory(environment);
  }

  get path(): string {
    return path.join(this.#directory, DINGTALK_VIEWED_FILE);
  }

  async read(): Promise<Map<string, number>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!record(parsed) || !record(parsed.conversations)) return new Map();
      const entries = Object.entries(parsed.conversations)
        .filter(
          ([conversationId, value]) =>
            conversationId.length > 0 &&
            conversationId.length <= 512 &&
            typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value >= 0,
        )
        .sort((left, right) => (right[1] as number) - (left[1] as number))
        .slice(0, MAX_ENTRIES);
      return new Map(entries as [string, number][]);
    } catch {
      return new Map();
    }
  }

  async write(viewed: ReadonlyMap<string, number>): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const entries = [...viewed.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_ENTRIES);
    const file = this.path;
    const temporary = path.join(
      this.#directory,
      `.${DINGTALK_VIEWED_FILE}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ conversations: Object.fromEntries(entries) }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
