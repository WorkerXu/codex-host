import { spawn } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  DELEGATION_RUNTIME_ENDPOINT_ENV,
  DELEGATION_RUNTIME_TOKEN_ENV,
  DelegationControlError,
  type DelegationControlErrorCode,
} from "./delegation-types.js";
import type { ResolvedPeer } from "./peer-config.js";
import { codexhostDataDirectory } from "./runtime-control-file.js";

export const PEER_EXEC_SUBCOMMAND = "peer-exec";
export const DEFAULT_PEER_TIMEOUT_MS = 30_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const STDERR_EXCERPT_BYTES = 2000;

export interface PeerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type PeerSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv },
) => PeerProcess;

/** Arguments are always passed as an array; no local shell parses the peer data. */
export function peerSshArguments(input: { environment: NodeJS.ProcessEnv; peer: ResolvedPeer }): {
  command: string;
  args: string[];
} {
  const controlPath = path.join(codexhostDataDirectory(input.environment), "ssh", "%C");
  return {
    command: "ssh",
    args: [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${controlPath}`,
      "-o",
      "ControlPersist=60",
      input.peer.ssh,
      input.peer.command ?? "codexhost",
      PEER_EXEC_SUBCOMMAND,
    ],
  };
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv },
): PeerProcess {
  return spawn(command, [...args], {
    stdio: options.stdio,
    env: options.env,
  }) as unknown as PeerProcess;
}

/** A SendEnv rule must never forward this machine's Runtime token over SSH. */
function sshEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => name !== DELEGATION_RUNTIME_ENDPOINT_ENV && name !== DELEGATION_RUNTIME_TOKEN_ENV,
    ),
  );
}

function unreachable(
  peer: ResolvedPeer,
  message: string,
  details: Record<string, unknown>,
): DelegationControlError {
  return new DelegationControlError("RUNTIME_UNREACHABLE", message, {
    peer: peer.name,
    ...details,
  });
}

function errorEnvelope(
  value: unknown,
): { code: string; message: string; details?: unknown } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const error = (value as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return undefined;
  const body = error as Record<string, unknown>;
  if (typeof body.code !== "string" || typeof body.message !== "string") return undefined;
  return {
    code: body.code,
    message: body.message,
    ...(body.details ? { details: body.details } : {}),
  };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Runs one Runtime route on a peer through its SSH alias. The peer reads the
 * JSON envelope from stdin and proxies it to its local Host Runtime.
 */
export async function requestPeerRoute(input: {
  environment: NodeJS.ProcessEnv;
  peer: ResolvedPeer;
  route: string;
  body: Record<string, unknown>;
  timeoutMs?: number;
  spawnImpl?: PeerSpawn;
}): Promise<Record<string, unknown>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
  const { command, args } = peerSshArguments(input);
  // ControlMaster sockets live here; ssh requires the directory to exist.
  const controlDirectory = path.join(codexhostDataDirectory(input.environment), "ssh");
  await mkdir(controlDirectory, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await chmod(controlDirectory, 0o700).catch(() => undefined);

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let child: PeerProcess;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(
          unreachable(input.peer, `Peer '${input.peer.name}' timed out`, {
            reason: "peer_timeout",
            timeoutMs,
          }),
        );
      });
    }, timeoutMs);
    try {
      child = (input.spawnImpl ?? defaultSpawn)(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: sshEnvironment(input.environment),
      });
    } catch (error) {
      finish(() => {
        reject(
          unreachable(input.peer, `Peer '${input.peer.name}' could not be started`, {
            reason: "peer_spawn_failed",
            cause: error instanceof Error ? error.message : String(error),
          }),
        );
      });
      return;
    }
    child.on("error", (error) => {
      finish(() => {
        reject(
          unreachable(input.peer, `Peer '${input.peer.name}' could not be started`, {
            reason: "peer_spawn_failed",
            cause: error.message,
          }),
        );
      });
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        finish(() => {
          child.kill("SIGKILL");
          reject(
            new DelegationControlError(
              "RESPONSE_TOO_LARGE",
              `Peer '${input.peer.name}' returned more than ${MAX_STDOUT_BYTES} bytes`,
              { peer: input.peer.name },
            ),
          );
        });
        return;
      }
      stdout.push(buffer);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      stderrBytes += Math.min(buffer.length, remaining);
      stderr.push(buffer.subarray(0, remaining));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${JSON.stringify({ route: input.route, body: input.body })}\n`);
    child.on("close", (code) => {
      finish(() => {
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");
        if (code !== 0) {
          const error = errorEnvelope(parseJsonObject(stdoutText));
          if (error) {
            reject(
              new DelegationControlError(
                error.code as DelegationControlErrorCode,
                error.message,
                error.details as Record<string, unknown> | undefined,
              ),
            );
            return;
          }
          reject(
            unreachable(input.peer, `Peer '${input.peer.name}' command failed`, {
              reason: "peer_command_failed",
              exitCode: code,
              stderr: stderrText.trim().slice(0, STDERR_EXCERPT_BYTES),
            }),
          );
          return;
        }
        const body = parseJsonObject(stdoutText);
        if (!body) {
          reject(
            unreachable(input.peer, `Peer '${input.peer.name}' returned an unreadable response`, {
              reason: "invalid_peer_response",
            }),
          );
          return;
        }
        resolve(body);
      });
    });
  });
}
