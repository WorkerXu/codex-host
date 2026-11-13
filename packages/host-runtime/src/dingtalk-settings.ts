import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DINGTALK_DEFAULT_PEER,
  type DingTalkHostOption,
  type DingTalkSettings,
} from "@codexhost/shared-contracts";

import { readPeerConfig, resolvePeerTarget, type ResolvedPeer } from "./peer-config.js";

export const DINGTALK_SETTINGS_FILE = "dingtalk-settings.json";

export interface DingTalkSettingsStoreOptions {
  configDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

function defaultConfigDirectory(environment: NodeJS.ProcessEnv): string {
  return path.join(environment.HOME || os.homedir(), ".config", "codexhost");
}

async function readConfiguredHost(directory: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(directory, DINGTALK_SETTINGS_FILE), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).defaultHost;
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= 128 ? trimmed : null;
  } catch {
    return null;
  }
}

/** The peer/DingTalk login choice is local to this Desktop Host. */
export class DingTalkSettingsStore {
  readonly #directory: string;

  constructor(options: DingTalkSettingsStoreOptions = {}) {
    this.#directory =
      options.configDirectory ?? defaultConfigDirectory(options.environment ?? process.env);
  }

  get directory(): string {
    return this.#directory;
  }

  async read(): Promise<string | null> {
    return await readConfiguredHost(this.#directory);
  }

  async write(defaultHost: string | null): Promise<void> {
    if (defaultHost === null) {
      await rm(path.join(this.#directory, DINGTALK_SETTINGS_FILE), { force: true });
      return;
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700).catch(() => undefined);
    const file = path.join(this.#directory, DINGTALK_SETTINGS_FILE);
    const temporary = path.join(
      this.#directory,
      `.${DINGTALK_SETTINGS_FILE}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      await writeFile(temporary, `${JSON.stringify({ defaultHost }, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, file);
      await chmod(file, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export interface DingTalkHostResolution {
  name: string;
  hostId: string | null;
  local: boolean;
  peer: ResolvedPeer | null;
}

export interface DingTalkHostResolutionResult extends DingTalkHostResolution {
  configured: string | null;
  hosts: DingTalkHostOption[];
}

/**
 * Auto prefers the `tencent` peer; on that machine the peer is absent from its
 * own peers.json, so the same default resolves to the local dws login.
 */
export async function resolveDingTalkHost(
  environment: NodeJS.ProcessEnv,
  configured: string | null,
): Promise<DingTalkHostResolutionResult> {
  const config = await readPeerConfig(environment).catch(() => null);
  const peers = config ? Object.entries(config.peers) : [];
  const hosts: DingTalkHostOption[] = [
    { name: "local", hostId: config?.self?.hostIds[0] ?? null, local: true },
    ...peers
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => ({ name, hostId: entry.hostIds[0] ?? null, local: false })),
  ];
  const hasPeer = (name: string): boolean => peers.some(([peerName]) => peerName === name);
  const selected =
    configured && configured !== "local"
      ? configured
      : configured === "local"
        ? "local"
        : hasPeer(DINGTALK_DEFAULT_PEER)
          ? DINGTALK_DEFAULT_PEER
          : "local";
  if (!config || selected === "local") {
    return {
      name: "local",
      hostId: config?.self?.hostIds[0] ?? null,
      local: true,
      peer: null,
      configured,
      hosts,
    };
  }
  const target = resolvePeerTarget(config, selected);
  if (!target || target === "local") {
    return {
      name: "local",
      hostId: config.self?.hostIds[0] ?? null,
      local: true,
      peer: null,
      configured,
      hosts,
    };
  }
  return {
    name: target.name,
    hostId: target.linkHostId,
    local: false,
    peer: target,
    configured,
    hosts,
  };
}

export async function readDingTalkSettings(
  environment: NodeJS.ProcessEnv,
  store: DingTalkSettingsStore,
): Promise<DingTalkSettings> {
  const configured = await store.read();
  const resolved = await resolveDingTalkHost(environment, configured);
  return {
    defaultHost: configured,
    effectiveHost: resolved.name,
    effectiveHostId: resolved.hostId,
    hosts: resolved.hosts,
  };
}
