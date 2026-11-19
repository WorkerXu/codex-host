import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DINGTALK_DISPATCH_MAX_AGENTS,
  DINGTALK_REPLY_SCOPES,
  defaultDingTalkDispatchSettings,
  dingtalkDispatchSettingsSchema,
  type DingTalkDispatchSettings,
} from "@codexhost/shared-contracts";
import { z } from "zod";

import { CodexAgentError } from "./codex-agents.js";

export const DINGTALK_DISPATCH_SETTINGS_FILE = "dingtalk-dispatch.json";
const MAX_SETTINGS_BYTES = 64 * 1024;

/** The part of an installed agent the settings file refers to. */
export interface DingTalkDispatchAgent {
  fileName: string;
  name: string;
  description: string;
}

export interface DingTalkDispatchSettingsStoreOptions {
  /** Desktop-local codexhost directory; defaults to `~/.codexhost`. */
  homeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Before per-agent settings, one global switch selected event types for a list
 * of agent names. Only `replyScope` and enabled-ness remain meaningful.
 */
const legacyDingTalkDispatchSettingsSchema = z
  .object({
    enabled: z.boolean(),
    eventTypes: z.array(z.string()).max(8),
    matchThreshold: z.number().min(0).max(1),
    replyScope: z.enum(DINGTALK_REPLY_SCOPES),
    participatingAgents: z.array(z.string()).max(DINGTALK_DISPATCH_MAX_AGENTS),
  })
  .strip();

type LegacyDingTalkDispatchSettings = z.infer<typeof legacyDingTalkDispatchSettingsSchema>;

function defaultHomeDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(environment.HOME?.trim() || os.homedir(), ".codexhost");
}

/**
 * The previous file kept one global switch and a list of agent names. Turn it
 * into per-agent entries for exactly the agents that participated before:
 * the saved names, or every agent with a description when the list was empty.
 * Section and project stay unset, so the agent shows its setup hint until the
 * user picks them.
 */
function migrateLegacySettings(
  legacy: LegacyDingTalkDispatchSettings,
  agents: readonly DingTalkDispatchAgent[],
): DingTalkDispatchSettings {
  const settings: DingTalkDispatchSettings = { agents: {} };
  if (!legacy.enabled) return settings;
  const participants =
    legacy.participatingAgents.length > 0
      ? agents.filter((agent) => legacy.participatingAgents.includes(agent.name))
      : agents.filter((agent) => agent.description.trim().length > 0);
  for (const agent of participants.slice(0, DINGTALK_DISPATCH_MAX_AGENTS)) {
    settings.agents[agent.fileName] = {
      enabled: true,
      replyScope: legacy.replyScope,
      sectionId: null,
      projectId: null,
      projectPath: null,
      projectRoots: [],
    };
  }
  return settings;
}

/** Drop entries whose file no longer exists, so a reused file starts off. */
function pruneSettings(
  settings: DingTalkDispatchSettings,
  agents: readonly DingTalkDispatchAgent[],
): DingTalkDispatchSettings {
  const known = new Set(agents.map((agent) => agent.fileName));
  const entries = Object.entries(settings.agents).filter(([fileName]) => known.has(fileName));
  if (entries.length === Object.keys(settings.agents).length) return settings;
  return { agents: Object.fromEntries(entries) };
}

/** Retired auto-dispatch keys must not survive a rewrite. */
function hasRetiredKeys(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if ("threshold" in record || "eventTypes" in record || "matchThreshold" in record) return true;
  const agents = record.agents;
  if (typeof agents !== "object" || agents === null || Array.isArray(agents)) return false;
  return Object.values(agents).some(
    (agent) =>
      typeof agent === "object" &&
      agent !== null &&
      !Array.isArray(agent) &&
      ("eventTypes" in agent || "threshold" in agent),
  );
}

/**
 * Persists the DingTalk dispatch choices on the local Host.
 *
 * Listening is per agent. Dispatch is manual only; a message is never sent to
 * an agent by the event stream. The section and project choose where a manual
 * dispatch creates its Thread.
 */
export class DingTalkDispatchSettingsStore {
  readonly #directory: string;
  readonly #listeners = new Set<(settings: DingTalkDispatchSettings) => void>();

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

  /**
   * A missing or unreadable file means defaults. `agents` is the current agent
   * list; `null` means the list could not be read, so entries are kept. Retired
   * `eventTypes` and `threshold` keys are ignored and rewritten without them.
   */
  async read(
    agents: readonly DingTalkDispatchAgent[] | null = null,
  ): Promise<DingTalkDispatchSettings> {
    let parsed: unknown;
    try {
      const text = await readFile(this.filePath, "utf8");
      if (text.length > MAX_SETTINGS_BYTES) return defaultDingTalkDispatchSettings();
      parsed = JSON.parse(text);
    } catch {
      return defaultDingTalkDispatchSettings();
    }

    const current = dingtalkDispatchSettingsSchema.safeParse(parsed);
    if (current.success) {
      const pruned = agents === null ? current.data : pruneSettings(current.data, agents);
      if (hasRetiredKeys(parsed) || pruned !== current.data) {
        await this.write(pruned).catch(() => undefined);
      }
      return pruned;
    }

    const legacy = legacyDingTalkDispatchSettingsSchema.safeParse(parsed);
    if (!legacy.success) return defaultDingTalkDispatchSettings();
    const migrated = migrateLegacySettings(legacy.data, agents ?? []);
    await this.write(migrated).catch(() => undefined);
    return migrated;
  }

  /** The dispatcher reloads on every save; the settings page stays the source. */
  subscribe(listener: (settings: DingTalkDispatchSettings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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
    for (const listener of this.#listeners) {
      try {
        listener(parsed.data);
      } catch {
        /* A listener must not fail the save. */
      }
    }
    return parsed.data;
  }
}
