import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse, stringify, type TomlTable } from "smol-toml";
import {
  CODEX_AGENT_DESCRIPTION_MAX_LENGTH,
  CODEX_AGENT_EFFORT_MAX_LENGTH,
  CODEX_AGENT_INSTRUCTIONS_MAX_LENGTH,
  CODEX_AGENT_MAX_FILES,
  CODEX_AGENT_MODEL_MAX_LENGTH,
  isCodexAgentFileName,
  isCodexAgentName,
  type CodexAgentErrorCode,
  type CodexAgentIssue,
  type CodexAgentListResult,
  type CodexAgentRecord,
  type CodexAgentSaveParams,
  type CodexAgentSummary,
} from "@codexhost/shared-contracts";

const MAX_AGENT_FILE_BYTES = 512 * 1024;
const FILE_NAME_MAX_LENGTH = 128;

export class CodexAgentError extends Error {
  constructor(
    readonly code: CodexAgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodexAgentError";
  }
}

export interface CodexAgentStoreOptions {
  /** Defaults to `$CODEX_HOME`, then `~/.codex`. */
  codexHome?: string;
  environment?: NodeJS.ProcessEnv;
}

function defaultCodexHome(environment: NodeJS.ProcessEnv): string {
  const configured = environment.CODEX_HOME?.trim();
  if (configured) return path.resolve(configured);
  return path.join(environment.HOME?.trim() || os.homedir(), ".codex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function revisionOf(info: { mtimeMs: number; size: number }): string {
  return `${Math.max(0, Math.floor(info.mtimeMs))}-${info.size}`;
}

function textField(doc: Record<string, unknown>, key: string): string | null {
  const value = doc[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optionalTextField(doc: Record<string, unknown>, key: string): string | null {
  const value = doc[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

interface ParsedAgent {
  name: string;
  description: string;
  model: string | null;
  reasoningEffort: string | null;
  developerInstructions: string;
}

function agentFields(doc: Record<string, unknown>): ParsedAgent | null {
  const name = textField(doc, "name");
  const description = textField(doc, "description");
  const developerInstructions = textField(doc, "developer_instructions");
  if (!name || !description || !developerInstructions) return null;
  return {
    name: name.trim(),
    description,
    model: optionalTextField(doc, "model"),
    reasoningEffort: optionalTextField(doc, "model_reasoning_effort"),
    developerInstructions,
  };
}

/**
 * Reads and writes Codex custom agent files on the local Host.
 *
 * The codexhost form owns `name`, `description`, `developer_instructions`,
 * `model` and `model_reasoning_effort`. Every other key is Codex configuration
 * this form does not understand, so saves merge into the parsed document and
 * keep those keys (and the file name) untouched.
 */
export class CodexAgentStore {
  readonly #codexHome: string;

  constructor(options: CodexAgentStoreOptions = {}) {
    this.#codexHome = options.codexHome
      ? path.resolve(options.codexHome)
      : defaultCodexHome(options.environment ?? process.env);
  }

  get codexHome(): string {
    return this.#codexHome;
  }

  get directory(): string {
    return path.join(this.#codexHome, "agents");
  }

  async list(): Promise<CodexAgentListResult> {
    const directory = this.directory;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { directory, agents: [], issues: [] };
      }
      throw new CodexAgentError("io_failed", "Could not read the agents directory");
    }

    const agents: CodexAgentSummary[] = [];
    const issues: CodexAgentIssue[] = [];
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
      .slice(0, CODEX_AGENT_MAX_FILES);
    for (const entry of files) {
      if (!isCodexAgentFileName(entry.name)) continue;
      try {
        const { doc, info } = await this.#readDocument(entry.name);
        const fields = agentFields(doc);
        if (!fields) {
          issues.push({ fileName: entry.name, reason: "missing_fields" });
          continue;
        }
        agents.push(summaryOf(entry.name, fields, revisionOf(info)));
      } catch (error) {
        if (error instanceof CodexAgentError && error.code === "invalid_toml") {
          issues.push({ fileName: entry.name, reason: "invalid_toml" });
        } else {
          issues.push({ fileName: entry.name, reason: "unreadable" });
        }
      }
    }
    agents.sort((left, right) => left.name.localeCompare(right.name));
    return { directory, agents, issues };
  }

  async read(fileName: string): Promise<CodexAgentRecord> {
    const { doc, info } = await this.#readDocument(fileName);
    const fields = agentFields(doc);
    if (!fields) {
      throw new CodexAgentError(
        "invalid_field",
        "This agent file is missing name, description or developer_instructions",
      );
    }
    return {
      fileName,
      ...fields,
      revision: revisionOf(info),
    };
  }

  async save(input: CodexAgentSaveParams): Promise<CodexAgentRecord> {
    const name = input.name.trim();
    if (!isCodexAgentName(name)) {
      throw new CodexAgentError("invalid_name", "Agent names must match Codex's identifier form");
    }
    if (!input.description.trim()) {
      throw new CodexAgentError("invalid_field", "Description must not be blank");
    }
    if (input.description.length > CODEX_AGENT_DESCRIPTION_MAX_LENGTH) {
      throw new CodexAgentError("invalid_field", "Description is too long");
    }
    if (!input.developerInstructions.trim()) {
      throw new CodexAgentError("invalid_field", "Developer instructions must not be blank");
    }
    if (input.developerInstructions.length > CODEX_AGENT_INSTRUCTIONS_MAX_LENGTH) {
      throw new CodexAgentError("invalid_field", "Developer instructions are too long");
    }
    const model = normalizeOptional(input.model, CODEX_AGENT_MODEL_MAX_LENGTH);
    const reasoningEffort = normalizeOptional(input.reasoningEffort, CODEX_AGENT_EFFORT_MAX_LENGTH);

    const root = await this.#root();
    const fileName = input.fileName ?? `${name}.toml`;
    if (!isCodexAgentFileName(fileName)) {
      throw new CodexAgentError(
        "invalid_file_name",
        "Agent file names must stay in the agents directory",
      );
    }
    const target = path.join(root, fileName);
    await this.#assertNameAvailable(root, name, input.fileName ? fileName : null);

    let doc: TomlTable;
    let mode = 0o600;
    if (input.fileName) {
      const current = await this.#readDocument(fileName);
      if (current.info.size > MAX_AGENT_FILE_BYTES) {
        throw new CodexAgentError("invalid_field", "This agent file is too large to edit");
      }
      if (input.expectedRevision !== revisionOf(current.info)) {
        throw new CodexAgentError("revision_conflict", "The agent file changed since it was read");
      }
      doc = current.doc;
      mode = current.info.mode & 0o777 || 0o600;
    } else {
      const existing = await lstat(target).catch(() => null);
      if (existing) {
        throw new CodexAgentError("name_taken", "An agent file with this name already exists");
      }
      doc = {};
    }

    doc.name = name;
    doc.description = input.description;
    doc.developer_instructions = input.developerInstructions;
    if (model) doc.model = model;
    else delete doc.model;
    if (reasoningEffort) doc.model_reasoning_effort = reasoningEffort;
    else delete doc.model_reasoning_effort;

    await this.#writeAtomic(root, fileName, `${stringify(doc)}\n`, mode);
    const saved = await this.#readDocument(fileName);
    const fields = agentFields(saved.doc);
    if (!fields) {
      throw new CodexAgentError("io_failed", "The saved agent file could not be read back");
    }
    return { fileName, ...fields, revision: revisionOf(saved.info) };
  }

  async delete(fileName: string, expectedRevision: string): Promise<void> {
    const root = await this.#root();
    assertFileName(fileName);
    const current = await this.#readDocument(fileName);
    if (revisionOf(current.info) !== expectedRevision) {
      throw new CodexAgentError("revision_conflict", "The agent file changed since it was read");
    }
    await rm(path.join(root, fileName), { force: false });
  }

  async #root(): Promise<string> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      return await realpath(this.directory);
    } catch {
      throw new CodexAgentError("io_failed", "Could not prepare the agents directory");
    }
  }

  async #readDocument(
    fileName: string,
  ): Promise<{ doc: TomlTable; info: { mtimeMs: number; size: number; mode: number } }> {
    assertFileName(fileName);
    const root = await this.#root();
    const target = path.join(root, fileName);
    if (path.dirname(target) !== root) {
      throw new CodexAgentError(
        "invalid_file_name",
        "Agent files must stay in the agents directory",
      );
    }
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CodexAgentError("not_found", "Agent file not found");
      }
      throw new CodexAgentError("io_failed", "Could not read the agent file");
    }
    // A symlink could point outside the agents directory; never follow it.
    if (!info.isFile()) {
      throw new CodexAgentError("invalid_file_name", "Agent path must be a regular file");
    }
    if (info.size > MAX_AGENT_FILE_BYTES) {
      throw new CodexAgentError("invalid_field", "This agent file is too large to edit");
    }
    let text: string;
    try {
      text = await readFile(target, "utf8");
    } catch {
      throw new CodexAgentError("io_failed", "Could not read the agent file");
    }
    let doc: TomlTable;
    try {
      const parsed: unknown = parse(text);
      if (!isRecord(parsed)) throw new Error("Agent TOML must be a table");
      doc = parsed as TomlTable;
    } catch {
      throw new CodexAgentError("invalid_toml", "Agent file is not valid TOML");
    }
    return { doc, info };
  }

  async #assertNameAvailable(
    root: string,
    name: string,
    exceptFileName: string | null,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
      if (entry.name === exceptFileName || !isCodexAgentFileName(entry.name)) continue;
      try {
        const { doc } = await this.#readDocument(entry.name);
        const existing = textField(doc, "name");
        if (existing && existing.trim() === name) {
          throw new CodexAgentError("name_taken", "Another agent already uses this name");
        }
      } catch (error) {
        if (error instanceof CodexAgentError && error.code === "name_taken") throw error;
        // Unreadable files cannot claim the name; the list reports them separately.
      }
    }
  }

  async #writeAtomic(root: string, fileName: string, content: string, mode: number): Promise<void> {
    const target = path.join(root, fileName);
    const temporary = path.join(
      root,
      `.${fileName}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      await writeFile(temporary, content, { mode, flag: "wx" });
      await chmod(temporary, mode).catch(() => undefined);
      await rename(temporary, target);
    } catch {
      throw new CodexAgentError("io_failed", "Could not save the agent file");
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function assertFileName(fileName: string): void {
  if (fileName.length > FILE_NAME_MAX_LENGTH || !isCodexAgentFileName(fileName)) {
    throw new CodexAgentError(
      "invalid_file_name",
      "Agent file names must stay in the agents directory",
    );
  }
}

function normalizeOptional(value: string | null, maximum: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maximum || /[\r\n]/u.test(trimmed)) {
    throw new CodexAgentError("invalid_field", "Value is not a valid single-line setting");
  }
  return trimmed;
}

function summaryOf(fileName: string, fields: ParsedAgent, revision: string): CodexAgentSummary {
  return {
    fileName,
    name: fields.name,
    description: fields.description,
    model: fields.model,
    reasoningEffort: fields.reasoningEffort,
    revision,
  };
}
