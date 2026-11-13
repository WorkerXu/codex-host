import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { JarvisLoginStartResult } from "@codexhost/shared-contracts";

import { readPeerConfig, resolvePeerTarget } from "./peer-config.js";
import { codexhostUserDirectory } from "./runtime-control-file.js";

const LOGIN_TIMEOUT = "5m";
const LOGIN_WINDOW_MS = 5 * 60_000;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/u;

export class JarvisLoginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JarvisLoginError";
  }
}

export function extractLoginUrl(output: string): URL | null {
  for (const match of output.matchAll(new RegExp(URL_PATTERN.source, "gu"))) {
    try {
      const url = new URL(match[0]);
      if (url.searchParams.has("callback_url")) return url;
    } catch {
      // Ignore partial lines until the CLI prints the complete URL.
    }
  }
  return null;
}

export function loginCallbackPort(url: URL): number | null {
  const callback = url.searchParams.get("callback_url");
  if (!callback) return null;
  try {
    const parsed = new URL(callback);
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Runs `jarvis login --no-browser` and keeps it alive while the user completes
 * the browser flow. The auth URL contains a one-time state value and is only
 * returned to the Desktop Renderer that asked for it.
 */
export class JarvisLoginManager {
  #child: ReturnType<typeof spawn> | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly input: {
      executable: () => Promise<string | null>;
      environment: NodeJS.ProcessEnv;
      spawnImpl?: typeof spawn;
      timeoutMs?: number;
    },
  ) {}

  async start(): Promise<JarvisLoginStartResult> {
    this.cancel();
    const executable = await this.input.executable();
    if (!executable) throw new JarvisLoginError("not_installed", "jarvis CLI is not installed");
    const spawnImpl = this.input.spawnImpl ?? spawn;
    const child = spawnImpl(executable, ["login", "--no-browser", "--timeout", LOGIN_TIMEOUT], {
      stdio: ["ignore", "pipe", "pipe"],
      env: this.input.environment,
    });
    this.#child = child;
    let output = "";
    const url = await new Promise<URL>((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: URL): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else if (value) resolve(value);
      };
      const timer = setTimeout(
        () => finish(new JarvisLoginError("timeout", "jarvis login did not print an auth URL")),
        this.input.timeoutMs ?? 15_000,
      );
      const receive = (chunk: Buffer | string): void => {
        output += chunk.toString();
        const found = extractLoginUrl(output);
        if (found) finish(null, found);
      };
      child.stdout?.on("data", receive);
      child.stderr?.on("data", receive);
      child.on("error", () =>
        finish(new JarvisLoginError("not_installed", "jarvis login could not start")),
      );
      child.on("close", () =>
        finish(new JarvisLoginError("login_failed", "jarvis login stopped before authorization")),
      );
    }).catch((error: unknown) => {
      child.kill("SIGTERM");
      this.#child = null;
      throw error;
    });
    const port = loginCallbackPort(url);
    if (!port) {
      child.kill("SIGTERM");
      this.#child = null;
      throw new JarvisLoginError("invalid_login_url", "jarvis login URL has no callback port");
    }
    this.#timer = setTimeout(() => this.cancel(), LOGIN_WINDOW_MS + 30_000);
    return {
      authUrl: url.toString(),
      callbackPort: port,
      expiresAt: new Date(Date.now() + LOGIN_WINDOW_MS).toISOString(),
    };
  }

  cancel(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#child?.kill("SIGTERM");
    this.#child = null;
  }
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.setTimeout(300);
      const finish = (ready: boolean): void => {
        socket.destroy();
        if (ready) resolve(true);
        else if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 100);
      };
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(false));
      socket.once("error", () => finish(false));
    };
    attempt();
  });
}

async function freePort(preferred?: number): Promise<number> {
  const attempt = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        const allocated = typeof address === "object" && address ? address.port : port;
        server.close(() => resolve(allocated));
      });
    });
  if (preferred) {
    try {
      return await attempt(preferred);
    } catch {
      // The remote callback port is already used locally; allocate another one.
    }
  }
  let lastError: unknown;
  for (let i = 0; i < 5; i += 1) {
    try {
      return await attempt(0);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new JarvisLoginError("no_port", "No free port");
}

/** Replace the callback and completion ports with the locally forwarded port. */
export function rewriteLoginCallbackPort(authUrl: string, localPort: number): string {
  const url = new URL(authUrl);
  for (const key of ["callback_url", "redirect_url"]) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    try {
      const parsed = new URL(value);
      parsed.hostname = "127.0.0.1";
      parsed.port = String(localPort);
      url.searchParams.set(key, parsed.toString());
    } catch {
      // Leave malformed optional parameters untouched; the CLI reports them.
    }
  }
  return url.toString();
}

export interface JarvisLoginForward {
  forwardId: string;
  authUrl: string;
  localPort: number;
  stop(): void;
}

/**
 * For a remote Host, the OAuth callback targets 127.0.0.1 on that machine.
 * The local Desktop Host opens an SSH local forward, preferring the original
 * port so the printed URL stays byte-for-byte valid.
 */
export class JarvisLoginForwarder {
  readonly #forwards = new Map<
    string,
    { child: ReturnType<typeof spawn>; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly input: {
      environment: NodeJS.ProcessEnv;
      spawnImpl?: typeof spawn;
      timeoutMs?: number;
    },
  ) {}

  async start(target: { hostId: string; callbackPort: number; authUrl: string }): Promise<{
    forwarded: boolean;
    authUrl: string;
    forwardId: string | null;
    errorCode: string | null;
  }> {
    if (target.hostId === "local") {
      return { forwarded: false, authUrl: target.authUrl, forwardId: null, errorCode: null };
    }
    let peer: ReturnType<typeof resolvePeerTarget>;
    try {
      peer = resolvePeerTarget(await readPeerConfig(this.input.environment), target.hostId);
    } catch {
      return {
        forwarded: false,
        authUrl: target.authUrl,
        forwardId: null,
        errorCode: "peer_unavailable",
      };
    }
    if (peer === "local") {
      return { forwarded: false, authUrl: target.authUrl, forwardId: null, errorCode: null };
    }
    if (!peer) {
      return {
        forwarded: false,
        authUrl: target.authUrl,
        forwardId: null,
        errorCode: "peer_unavailable",
      };
    }
    const localPort = await freePort(target.callbackPort);
    const controlPath = path.join(codexhostUserDirectory(this.input.environment), "ssh", "%C");
    await mkdir(path.dirname(controlPath), { recursive: true, mode: 0o700 }).catch(() => undefined);
    const child = (this.input.spawnImpl ?? spawn)(
      "ssh",
      [
        "-N",
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
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `127.0.0.1:${localPort}:127.0.0.1:${target.callbackPort}`,
        peer.ssh,
      ],
      { stdio: ["ignore", "ignore", "pipe"], env: this.input.environment },
    );
    let exited = false;
    child.once("close", () => {
      exited = true;
    });
    child.once("error", () => {
      exited = true;
    });
    const ready = await waitForPort(localPort, 5_000);
    if (!ready || exited) {
      child.kill("SIGTERM");
      return {
        forwarded: false,
        authUrl: target.authUrl,
        forwardId: null,
        errorCode: "forward_failed",
      };
    }
    const forwardId = randomUUID();
    const timer = setTimeout(() => this.stop(forwardId), this.input.timeoutMs ?? 10 * 60_000);
    this.#forwards.set(forwardId, { child, timer });
    return {
      forwarded: true,
      authUrl:
        localPort === target.callbackPort
          ? target.authUrl
          : rewriteLoginCallbackPort(target.authUrl, localPort),
      forwardId,
      errorCode: null,
    };
  }

  stop(forwardId: string): void {
    const entry = this.#forwards.get(forwardId);
    if (!entry) return;
    this.#forwards.delete(forwardId);
    clearTimeout(entry.timer);
    entry.child.kill("SIGTERM");
  }

  dispose(): void {
    for (const id of [...this.#forwards.keys()]) this.stop(id);
  }
}
