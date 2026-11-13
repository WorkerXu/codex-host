import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_JARVIS_THRESHOLD,
  JARVIS_KEY_MAX_LENGTH,
  type JarvisSettingsResult,
} from "@codexhost/shared-contracts";

export const JARVIS_GEMINI_KEY_FILE = "gemini-api-key";
export const JARVIS_SETTINGS_FILE = "jarvis-settings.json";

export interface JarvisSettingsStoreOptions {
  /** Desktop-local codexhost configuration directory. */
  configDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

function defaultConfigDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(environment.HOME || os.homedir(), ".config", "codexhost");
}

function settingsFileValue(value: unknown): { threshold?: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const threshold = (value as Record<string, unknown>).threshold;
  return typeof threshold === "number" && threshold >= 0 && threshold <= 1 ? { threshold } : {};
}

/**
 * The Gemini key is local to the Desktop Host: it is written 0600 and never
 * transported over a Host connection or included in a result.
 */
export class JarvisSettingsStore {
  readonly #directory: string;

  constructor(options: JarvisSettingsStoreOptions = {}) {
    this.#directory =
      options.configDirectory ?? defaultConfigDirectory(options.environment ?? process.env);
  }

  get directory(): string {
    return this.#directory;
  }

  get keyPath(): string {
    return path.join(this.#directory, JARVIS_GEMINI_KEY_FILE);
  }

  async readKey(): Promise<string | null> {
    try {
      const value = (await readFile(this.keyPath, "utf8")).trim();
      if (!value || value.length > JARVIS_KEY_MAX_LENGTH || /\s/u.test(value)) return null;
      return value;
    } catch {
      return null;
    }
  }

  async writeKey(value: string | null): Promise<void> {
    await this.#writeFile(this.keyPath, value === null ? null : `${value.trim()}\n`);
  }

  async readThreshold(): Promise<number> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(path.join(this.#directory, JARVIS_SETTINGS_FILE), "utf8"),
      );
      return settingsFileValue(parsed).threshold ?? DEFAULT_JARVIS_THRESHOLD;
    } catch {
      return DEFAULT_JARVIS_THRESHOLD;
    }
  }

  async writeThreshold(value: number): Promise<void> {
    const threshold = Math.min(1, Math.max(0, value));
    await this.#writeFile(
      path.join(this.#directory, JARVIS_SETTINGS_FILE),
      `${JSON.stringify({ threshold }, null, 2)}\n`,
    );
  }

  async read(): Promise<JarvisSettingsResult> {
    return {
      hasKey: (await this.readKey()) !== null,
      threshold: await this.readThreshold(),
    };
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
