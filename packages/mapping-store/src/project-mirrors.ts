import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
  projectMirrorRecordSchema,
  projectMirrorsFileSchema,
  type ProjectMirrorRecord,
  type ProjectMirrorsFile,
} from "@codexhost/shared-contracts";

const PROJECT_MIRRORS_FORMAT_VERSION = 1;
const PROJECT_MIRRORS_FILE = "mirrors.json";

export class ProjectMirrorStoreError extends Error {
  constructor(
    readonly code: "IO_ERROR" | "INVALID_FILE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectMirrorStoreError";
  }
}

export class ProjectMirrorRevisionConflictError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`Project mirrors changed from revision ${expected} to ${actual}; reload and retry`);
    this.name = "ProjectMirrorRevisionConflictError";
  }
}

export function emptyProjectMirrorsFile(): ProjectMirrorsFile {
  return {
    formatVersion: PROJECT_MIRRORS_FORMAT_VERSION,
    revision: 0,
    projects: {},
    acknowledged: {},
  };
}

export function projectMirrorsFilePath(directory: string): string {
  return path.join(directory, PROJECT_MIRRORS_FILE);
}

export async function readProjectMirrorsFile(file: string): Promise<ProjectMirrorsFile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT")
      return emptyProjectMirrorsFile();
    throw new ProjectMirrorStoreError("IO_ERROR", "Project mirrors could not be read", {
      cause: error,
    });
  }
  try {
    return projectMirrorsFileSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new ProjectMirrorStoreError("INVALID_FILE", "Project mirrors file is invalid", {
      cause: error,
    });
  }
}

export async function writeProjectMirrorsFile(
  file: string,
  value: ProjectMirrorsFile,
): Promise<ProjectMirrorsFile> {
  const parsed = projectMirrorsFileSchema.parse(value);
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
    throw new ProjectMirrorStoreError("IO_ERROR", "Project mirrors could not be persisted", {
      cause: error,
    });
  }
}

export interface ProjectMirrorUpdate {
  acknowledge?: true;
  /** `null` removes the mirror; omitting the field keeps the current record. */
  record?: ProjectMirrorRecord | null;
}

/**
 * Independent mirror registry beside the project-group configuration. It never
 * touches Desktop state; it only remembers which remote projects codexhost
 * created and which source projects the user confirmed as name-only.
 */
export class ProjectMirrorStore {
  readonly #directory: string;
  readonly #now: () => Date;
  #queue: Promise<void> = Promise.resolve();
  #lastQuarantine: string | null = null;

  constructor(options: { directory: string; now?: () => Date }) {
    this.#directory = path.resolve(options.directory);
    this.#now = options.now ?? (() => new Date());
  }

  get file(): string {
    return projectMirrorsFilePath(this.#directory);
  }

  list(): Promise<ProjectMirrorsFile> {
    return this.#enqueue(() => this.#read());
  }

  /** The most recent quarantine backup, consumed by the next list response. */
  takeQuarantine(): string | null {
    const backup = this.#lastQuarantine;
    this.#lastQuarantine = null;
    return backup;
  }

  upsert(
    revision: number,
    sourceProjectId: string,
    update: ProjectMirrorUpdate,
  ): Promise<ProjectMirrorsFile> {
    return this.#enqueue(async () => {
      const current = await this.#read();
      if (current.revision !== revision)
        throw new ProjectMirrorRevisionConflictError(revision, current.revision);
      let projects = { ...current.projects };
      const acknowledged = { ...current.acknowledged };
      if (update.acknowledge) acknowledged[sourceProjectId] = true;
      if (update.record === null) {
        projects = Object.fromEntries(
          Object.entries(projects).filter(([projectId]) => projectId !== sourceProjectId),
        );
      } else if (update.record !== undefined) {
        projects[sourceProjectId] = projectMirrorRecordSchema.parse(update.record);
      }
      const next = {
        formatVersion: PROJECT_MIRRORS_FORMAT_VERSION,
        revision: current.revision + 1,
        projects,
        acknowledged,
      } satisfies ProjectMirrorsFile;
      return writeProjectMirrorsFile(this.file, next);
    });
  }

  async #read(): Promise<ProjectMirrorsFile> {
    try {
      return await readProjectMirrorsFile(this.file);
    } catch (error) {
      if (!(error instanceof ProjectMirrorStoreError) || error.code !== "INVALID_FILE") throw error;
      // A corrupt registry must not block Host startup; keep it for diagnosis
      // and continue with an empty registry.
      const backupName = `mirrors.json.${this.#now().getTime()}.invalid`;
      const moved = await rename(this.file, path.join(this.#directory, backupName))
        .then(() => true)
        .catch(() => false);
      if (moved) this.#lastQuarantine = backupName;
      return emptyProjectMirrorsFile();
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
