import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  modelServiceSetSchema,
  modelServiceSettingsSchema,
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
  keyPath(provider: ModelProvider): string {
    return path.join(this.#directory, `${provider}-api-key`);
  }
  async readKey(provider: ModelProvider): Promise<string | null> {
    try {
      const value = (await readFile(this.keyPath(provider), "utf8")).trim();
      return value.length >= 8 && value.length <= 512 && !/\s/u.test(value) ? value : null;
    } catch {
      return null;
    }
  }
  async provider(): Promise<"openai"> {
    try {
      return modelServiceSettingsSchema.shape.provider.parse(
        JSON.parse(await readFile(path.join(this.#directory, "model-service.json"), "utf8"))
          .provider,
      );
    } catch {
      return "openai";
    }
  }
  async read(): Promise<ModelServiceSettings> {
    const state = async (provider: ModelProvider) => {
      const key = await this.readKey(provider);
      return { configured: key !== null, lastFour: key?.slice(-4) ?? null };
    };
    const [provider, openai, gemini] = await Promise.all([
      this.provider(),
      state("openai"),
      state("gemini"),
    ]);
    return { provider, openai, gemini };
  }
  async update(input: ModelServiceSet): Promise<ModelServiceSettings> {
    const value = modelServiceSetSchema.parse(input);
    if (value.key)
      await this.#writeFile(
        this.keyPath(value.key.provider),
        value.key.value === null ? null : `${value.key.value}\n`,
      );
    if (value.provider)
      await this.#writeFile(
        path.join(this.#directory, "model-service.json"),
        `${JSON.stringify({ provider: value.provider })}\n`,
      );
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
      await writeFile(temporary, content, { mode: 0o600 });
      await chmod(temporary, 0o600).catch(() => undefined);
      await rename(temporary, file);
      await chmod(file, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
