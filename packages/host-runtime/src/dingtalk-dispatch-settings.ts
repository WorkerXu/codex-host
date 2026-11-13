import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  defaultDingTalkDispatchSettings,
  dingtalkDispatchSettingsSchema,
  type DingTalkDispatchSettings,
} from "@codexhost/shared-contracts";

import { CodexAgentError } from "./codex-agents.js";

export const DINGTALK_DISPATCH_SETTINGS_FILE = "dingtalk-dispatch.json";
const MAX_SETTINGS_BYTES = 64 * 1024;

export interface DingTalkDispatchSettingsStoreOptions {
  /** Desktop-local codexhost directory; defaults to `~/.codexhost`. */
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

function defaultHomeDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(environment.HOME?.trim() || os.homedir(), ".codexhost");
}

/**
 * Persists the DingTalk dispatch choices on the local Host.
 *
 * This store is only the settings contract for the listener/dispatcher that is
 * implemented separately. Approvals are never auto-approved, and dispatch is
 * multi-agent: every participating agent at or above the threshold receives
 * the task.
 */
export class DingTalkDispatchSettingsStore {
  readonly #directory: string;

  constructor(options: DingTalkDispatchSettingsStoreOptions = {}) {
    this.#directory =
      options.homeDirectory ?? defaultHomeDirectory(options.environment ?? process.env);
  }

  get directory(): string {
    return this.#directory;
  }

  get filePath(): string {
    return path.join(this.#directory, DINGTALK_DISPATCH_SETTINGS_FILE);
  }

  /** A missing or unreadable file means defaults; `defaultAgents` seeds opt-in. */
  async read(defaultAgents: readonly string[] = []): Promise<DingTalkDispatchSettings> {
    try {
      const text = await readFile(this.filePath, "utf8");
      if (text.length > MAX_SETTINGS_BYTES) {
        return defaultDingTalkDispatchSettings(defaultAgents);
      }
      const parsed: unknown = JSON.parse(text);
      const settings = dingtalkDispatchSettingsSchema.safeParse(parsed);
      return settings.success ? settings.data : defaultDingTalkDispatchSettings(defaultAgents);
    } catch {
      return defaultDingTalkDispatchSettings(defaultAgents);
    }
  }

  async write(settings: DingTalkDispatchSettings): Promise<DingTalkDispatchSettings> {
    const parsed = dingtalkDispatchSettingsSchema.safeParse(settings);
    if (!parsed.success) {
      throw new CodexAgentError("invalid_params", "Invalid DingTalk dispatch settings");
    }
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await chmod(this.#directory, 0o700).catch(() => undefined);
      const temporary = path.join(
        this.#directory,
        `.${DINGTALK_DISPATCH_SETTINGS_FILE}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
      );
      try {
        await writeFile(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        await chmod(temporary, 0o600).catch(() => undefined);
        await rename(temporary, this.filePath);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof CodexAgentError) throw error;
      throw new CodexAgentError("io_failed", "Could not save DingTalk dispatch settings");
    }
    return parsed.data;
  }
}
