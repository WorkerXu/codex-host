import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  projectGroupsFileSchema,
  projectGroupsSchema,
  type ProjectGroup,
  type ProjectGroupsFile,
} from "@codexhost/shared-contracts";

const PROJECT_GROUPS_FORMAT_VERSION = 1;
const PROJECT_GROUPS_FILE = "groups.json";

export class ProjectGroupStoreError extends Error {
  constructor(
    readonly code: "IO_ERROR" | "INVALID_FILE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectGroupStoreError";
  }
}

export class ProjectGroupRevisionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Project groups changed from revision ${expected} to ${actual}; reload and retry`);
    this.name = "ProjectGroupRevisionConflictError";
  }
}

export function emptyProjectGroupsFile(): ProjectGroupsFile {
  return { formatVersion: PROJECT_GROUPS_FORMAT_VERSION, revision: 0, groups: [] };
}

export function projectGroupsFilePath(directory: string): string {
  return path.join(directory, PROJECT_GROUPS_FILE);
}

export async function readProjectGroupsFile(file: string): Promise<ProjectGroupsFile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return emptyProjectGroupsFile();
    throw new ProjectGroupStoreError("IO_ERROR", "Project groups could not be read", {
      cause: error,
    });
  }
  try {
    return projectGroupsFileSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new ProjectGroupStoreError("INVALID_FILE", "Project groups file is invalid", {
      cause: error,
    });
  }
}

export async function writeProjectGroupsFile(
  file: string,
  value: ProjectGroupsFile,
): Promise<ProjectGroupsFile> {
  const parsed = projectGroupsFileSchema.parse(value);
  const directory = path.dirname(file);
  const temp = `${file}.tmp-${randomUUID()}`;
  let handle: FileHandle | null = null;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    handle = await open(temp, "wx", constants.S_IRUSR | constants.S_IWUSR);
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, file);
    return parsed;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw new ProjectGroupStoreError("IO_ERROR", "Project groups could not be persisted", {
      cause: error,
    });
  }
}

/**
 * Independent project-group configuration beside the mapping store. The store
 * owns only this file; deleting a group never touches native Desktop state.
 */
export class ProjectGroupStore {
  readonly #directory: string;
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();
  #lastQuarantine: string | null = null;

  constructor(options: { directory: string; now?: () => Date }) {
    this.#directory = path.resolve(options.directory);
    this.#now = options.now ?? (() => new Date());
  }

  get file(): string {
    return projectGroupsFilePath(this.#directory);
  }

  list(): Promise<ProjectGroupsFile> {
    return this.#enqueue(() => this.#read());
  }

  /** The most recent quarantine backup, consumed by the next list response. */
  takeQuarantine(): string | null {
    const backup = this.#lastQuarantine;
    this.#lastQuarantine = null;
    return backup;
  }

  replace(revision: number, groups: readonly ProjectGroup[]): Promise<ProjectGroupsFile> {
    return this.#enqueue(async () => {
      const current = await this.#read();
      if (current.revision !== revision)
        throw new ProjectGroupRevisionConflictError(revision, current.revision);
      const next = {
        formatVersion: PROJECT_GROUPS_FORMAT_VERSION,
        revision: current.revision + 1,
        groups: projectGroupsSchema.parse(groups),
      } satisfies ProjectGroupsFile;
      return writeProjectGroupsFile(this.file, next);
    });
  }

  async #read(): Promise<ProjectGroupsFile> {
    try {
      return await readProjectGroupsFile(this.file);
    } catch (error) {
      if (!(error instanceof ProjectGroupStoreError) || error.code !== "INVALID_FILE") throw error;
      // Presentation configuration must not block Host startup. Keep the bad
      // file for diagnosis and start from an empty configuration.
      const backupName = `groups.json.${this.#now().getTime()}.invalid`;
      const moved = await rename(this.file, path.join(this.#directory, backupName))
        .then(() => true)
        .catch(() => false);
      if (moved) this.#lastQuarantine = backupName;
      return emptyProjectGroupsFile();
    }
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run, run);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
