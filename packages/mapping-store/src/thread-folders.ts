import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  threadFoldersSelectionSchema,
  type ThreadFoldersSelection,
} from "@codexhost/shared-contracts";

/** Each execution Host owns its directory; Thread IDs never cross that namespace. */
export class ThreadFoldersStore {
  constructor(readonly directory: string) {}

  #file(threadId: string): string {
    return path.join(this.directory, `${createHash("sha256").update(threadId).digest("hex")}.json`);
  }

  async get(threadId: string): Promise<ThreadFoldersSelection | null> {
    try {
      return threadFoldersSelectionSchema.parse(
        JSON.parse(await readFile(this.#file(threadId), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async update(
    threadId: string,
    change: (current: ThreadFoldersSelection | null) => ThreadFoldersSelection,
  ): Promise<ThreadFoldersSelection> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = `${this.#file(threadId)}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = await stat(lock)
          .then((value) => Date.now() - value.mtimeMs)
          .catch(() => 0);
        if (age > 30000) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline)
          throw new Error("Working folder selection is busy; retry the change");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      const next = change(await this.get(threadId));
      await this.#put(threadId, next);
      return next;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async #put(threadId: string, selection: ThreadFoldersSelection): Promise<void> {
    const parsed = threadFoldersSelectionSchema.parse(selection);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.#file(threadId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(parsed), { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async recent(): Promise<string[]> {
    const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const selections: ThreadFoldersSelection[] = [];
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
      try {
        selections.push(
          threadFoldersSelectionSchema.parse(
            JSON.parse(await readFile(path.join(this.directory, file), "utf8")),
          ),
        );
      } catch {
        /* A damaged unrelated record must not hide this Host's other recent folders. */
      }
    }
    selections.sort((a, b) => b.changedAt.localeCompare(a.changedAt));
    return [...new Set(selections.flatMap(({ folders }) => folders))].slice(0, 64);
  }
}
