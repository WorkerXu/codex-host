import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DelegationControlError } from "./delegation-types.js";
import { codexhostDataDirectory } from "./runtime-control-file.js";

export const PEER_CONFIG_FORMAT_VERSION = 1;
export const PEER_CONFIG_FILE_NAME = "peers.json";
const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
// SSH config aliases may contain user@host, IPv6 literals, and a port.
const SSH_ALIAS = /^[A-Za-z0-9_.@:+-]{1,255}$/u;
// Passed as one remote command word; shell metacharacters are rejected.
const REMOTE_COMMAND = /^[A-Za-z0-9_./:@+-]{1,1024}$/u;
const HOST_ID = /^[A-Za-z0-9_.:@%+-]{1,256}$/u;

export interface PeerEntry {
  /** Alias from the local ~/.ssh/config. */
  ssh: string;
  /** Desktop Host IDs that identify this peer; the first one is used in links. */
  hostIds: string[];
  /** Remote codexhost executable when it is not on the peer's PATH. */
  command?: string;
}

export interface PeerConfig {
  formatVersion: 1;
  peers: Record<string, PeerEntry>;
}

export interface ResolvedPeer extends PeerEntry {
  name: string;
  /** Host ID used in Thread links and as the default routing value. */
  linkHostId: string;
}

export function emptyPeerConfig(): PeerConfig {
  return { formatVersion: PEER_CONFIG_FORMAT_VERSION, peers: {} };
}

export function peerConfigPath(environment: NodeJS.ProcessEnv): string {
  return path.join(codexhostDataDirectory(environment), PEER_CONFIG_FILE_NAME);
}

function invalid(message: string): DelegationControlError {
  return new DelegationControlError("INVALID_ARGUMENT", message);
}

export function validatePeerName(value: string): string {
  if (
    !PEER_NAME.test(value) ||
    value === "local" ||
    value === "__proto__" ||
    value === "constructor" ||
    value === "prototype"
  ) {
    throw invalid(
      "Peer name must contain 1-64 letters, digits, dots, underscores, or hyphens and must not be a reserved name",
    );
  }
  return value;
}

export function validateSshAlias(value: string): string {
  if (!SSH_ALIAS.test(value) || value.startsWith("-")) {
    throw invalid("Peer SSH alias is invalid");
  }
  return value;
}

export function validateRemoteCommand(value: string): string {
  if (!REMOTE_COMMAND.test(value) || value.startsWith("-")) {
    throw invalid("Peer command must be one absolute path or command word without shell syntax");
  }
  return value;
}

export function validateHostId(value: string): string {
  if (!HOST_ID.test(value)) throw invalid(`Host ID '${value}' is invalid`);
  return value;
}

function parseEntry(name: string, value: unknown): PeerEntry {
  validatePeerName(name);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`Peer '${name}' must be an object`);
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.ssh !== "string") throw invalid(`Peer '${name}' requires an ssh alias`);
  const ssh = validateSshAlias(entry.ssh);
  const hostIds: string[] = [];
  if (entry.hostIds !== undefined) {
    if (!Array.isArray(entry.hostIds)) throw invalid(`Peer '${name}' hostIds must be an array`);
    for (const hostId of entry.hostIds) {
      if (typeof hostId !== "string") throw invalid(`Peer '${name}' hostIds must be strings`);
      validateHostId(hostId);
      if (!hostIds.includes(hostId)) hostIds.push(hostId);
    }
  }
  let command: string | undefined;
  if (entry.command !== undefined) {
    if (typeof entry.command !== "string") throw invalid(`Peer '${name}' command must be a string`);
    command = validateRemoteCommand(entry.command);
  }
  return { ssh, hostIds, ...(command ? { command } : {}) };
}

/** Rejects duplicate Host IDs so every link resolves to exactly one peer. */
function assertUniqueHostIds(config: PeerConfig): void {
  const owner = new Map<string, string>();
  for (const [name, entry] of Object.entries(config.peers)) {
    for (const hostId of entry.hostIds) {
      const existing = owner.get(hostId);
      if (existing !== undefined && existing !== name) {
        throw invalid(
          `Host ID '${hostId}' is configured for both peer '${existing}' and '${name}'`,
        );
      }
      owner.set(hostId, name);
    }
  }
}

export function parsePeerConfig(value: unknown): PeerConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("Peer configuration must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.formatVersion !== PEER_CONFIG_FORMAT_VERSION) {
    throw invalid(`Peer configuration formatVersion must be ${PEER_CONFIG_FORMAT_VERSION}`);
  }
  if (typeof raw.peers !== "object" || raw.peers === null || Array.isArray(raw.peers)) {
    throw invalid("Peer configuration peers must be an object");
  }
  const peers: Record<string, PeerEntry> = {};
  for (const [name, entry] of Object.entries(raw.peers as Record<string, unknown>)) {
    peers[name] = parseEntry(name, entry);
  }
  const config: PeerConfig = { formatVersion: PEER_CONFIG_FORMAT_VERSION, peers };
  assertUniqueHostIds(config);
  return config;
}

export async function readPeerConfig(environment: NodeJS.ProcessEnv): Promise<PeerConfig> {
  const filePath = peerConfigPath(environment);
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPeerConfig();
    throw invalid(`Peer configuration could not be read from ${filePath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid(`Peer configuration at ${filePath} is not valid JSON`);
  }
  try {
    return parsePeerConfig(value);
  } catch (error) {
    throw invalid(
      `Peer configuration at ${filePath} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function writePeerConfig(
  environment: NodeJS.ProcessEnv,
  config: PeerConfig,
): Promise<void> {
  const normalized = parsePeerConfig(config);
  const directory = codexhostDataDirectory(environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const filePath = peerConfigPath(environment);
  const temporary = path.join(
    directory,
    `.peers-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Resolves a `--host` value or Thread hostId. Peer names win over the special
 * `local` value, and configured Host IDs win over `local`, so a peer can
 * explicitly claim links that use that placeholder on its own Desktop.
 */
export function resolvePeerTarget(
  config: PeerConfig,
  target: string,
): ResolvedPeer | "local" | undefined {
  const byName = Object.entries(config.peers).find(([name]) => name === target);
  if (byName) {
    const [name, entry] = byName;
    return { ...entry, name, linkHostId: entry.hostIds[0] ?? name };
  }
  for (const [name, entry] of Object.entries(config.peers)) {
    if (entry.hostIds.includes(target)) return { ...entry, name, linkHostId: target };
  }
  if (target === "local") return "local";
  return undefined;
}

/** Thread links carry a Desktop Host ID; fall back to the peer name if none is set. */
export function peerThreadReference(threadId: string, linkHostId: string): string {
  return `thread://${threadId}?hostId=${encodeURIComponent(linkHostId)}`;
}
