import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  modelServiceSetSchema,
  type ModelProvider,
  type ModelServiceSet,
  type ModelServiceSettings,
} from "@codexhost/shared-contracts";

/** Desktop-local credentials. Public snapshots contain only configuration state and a suffix. */
export class ModelServiceSettingsStore {
  readonly #directory: string;
  constructor(options: { configDirectory?: string; environment?: NodeJS.ProcessEnv } = {}) {
    this.#directory =
      options.configDirectory ??
      path.join(options.environment?.HOME || os.homedir(), ".config", "codexhost");
  }
  keyPath(): string {
    return path.join(this.#directory, "gemini-api-key");
  }
  async readKey(provider: ModelProvider): Promise<string | null> {
    try {
      if (provider !== "gemini") return null;
      const value = (await readFile(this.keyPath(), "utf8")).trim();
      return value.length >= 8 && value.length <= 512 && !/\s/u.test(value) ? value : null;
    } catch {
      return null;
    }
  }
  async read(): Promise<ModelServiceSettings> {
    const key = await this.readKey("gemini");
    return { gemini: { configured: key !== null, lastFour: key?.slice(-4) ?? null } };
  }
  async update(input: ModelServiceSet): Promise<ModelServiceSettings> {
    const { key } = modelServiceSetSchema.parse(input);
    await this.#writeFile(this.keyPath(), key.value === null ? null : `${key.value}\n`);
    return this.read();
  }
  async #writeFile(file: string, content: string | null): Promise<void> {
    if (content === null) {
      await rm(file, { force: true });
      return;
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700).catch(() => undefined);
    const temporary = path.join(
      this.#directory,
      `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
