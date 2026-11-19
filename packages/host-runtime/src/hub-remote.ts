import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { HubAdminError } from "./hub-admin-http.js";
import { headerNameFromRouting, type McpHubRouting } from "./mcphub-connection.js";

/**
 * The hubs live behind one SSH alias, outside the codexhost Hosts. The Host
 * keeps a single forward for both services; never one connection per request.
 */
export interface HubRemoteSettings {
  sshAlias: string;
  memhubPort: number;
  mcphubPort: number;
  tokenPath: string;
}
export const DEFAULT_HUB_REMOTE_SETTINGS: HubRemoteSettings = Object.freeze({
  sshAlias: "india",
  memhubPort: 8765,
  mcphubPort: 3000,
  tokenPath: "/home/ubuntu/.one-memory/runtime-token",
});
const settingsSchema = z
  .object({
    sshAlias: z
      .string()
      .regex(/^[A-Za-z0-9._@-]{1,200}$/u)
      .optional(),
    memhubPort: z.number().int().min(1).max(65535).optional(),
    mcphubPort: z.number().int().min(1).max(65535).optional(),
    tokenPath: z.string().max(1024).regex(/^\//u).optional(),
  })
  .strict();
const mcpRoutingSchema = z.object({
  enableBearerAuth: z.boolean().optional(),
  skipAuth: z.boolean().optional(),
  bearerAuthHeaderName: z.string().optional(),
});
/** Runs on India: only the routing fields leave the Host. */
const MCP_ROUTING_SCRIPT = `import json,re
path='/opt/mcphub/data/mcp_settings.json'
try:
  with open('/etc/mcphub.env') as f:
    for line in f:
      m=re.match(r'\s*(?:export\s+)?MCPHUB_SETTING_PATH\s*=\s*(.*?)\s*$',line)
      if m:
        v=m.group(1)
        if len(v)>=2 and v[0]==v[-1] and v[0] in ('"',"'"): v=v[1:-1]
        path=v
        break
except Exception:
  pass
try:
  with open(path) as f: s=json.load(f)
  r=(s.get('systemConfig') or {}).get('routing') or {}
  o={}
  for k in ('enableBearerAuth','skipAuth','bearerAuthHeaderName'):
    if k in r: o[k]=r[k]
  print(json.dumps(o))
except FileNotFoundError:
  print(json.dumps({'_error':'missing'}))
except Exception:
  print(json.dumps({'_error':'failed'}))
`;
const MCP_ROUTING_COMMAND = `python3 -c "import base64;exec(base64.b64decode('${Buffer.from(
  MCP_ROUTING_SCRIPT,
).toString("base64")}'))"`;
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const port = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined;
};
export function settingsFromEnvironment(
  environment: NodeJS.ProcessEnv,
  overrides: { [K in keyof HubRemoteSettings]?: HubRemoteSettings[K] | undefined } = {},
): HubRemoteSettings {
  const aliased = environment.CODEXHOST_HUB_SSH_ALIAS?.trim();
  return {
    sshAlias:
      overrides.sshAlias ??
      (aliased && /^[A-Za-z0-9._@-]{1,200}$/u.test(aliased)
        ? aliased
        : DEFAULT_HUB_REMOTE_SETTINGS.sshAlias),
    memhubPort:
      overrides.memhubPort ??
      port(environment.CODEXHOST_HUB_MEMHUB_PORT) ??
      DEFAULT_HUB_REMOTE_SETTINGS.memhubPort,
    mcphubPort:
      overrides.mcphubPort ??
      port(environment.CODEXHOST_HUB_MCPHUB_PORT) ??
      DEFAULT_HUB_REMOTE_SETTINGS.mcphubPort,
    tokenPath:
      overrides.tokenPath ??
      (environment.CODEXHOST_HUB_TOKEN_PATH?.trim().startsWith("/")
        ? environment.CODEXHOST_HUB_TOKEN_PATH.trim()
        : DEFAULT_HUB_REMOTE_SETTINGS.tokenPath),
  };
}
/** Settings live beside the MCPHub key on the Host that owns the forward. */
export async function loadHubRemoteSettings(
  environment: NodeJS.ProcessEnv,
  configDirectory = path.join(environment.HOME || homedir(), ".config", "codexhost"),
): Promise<HubRemoteSettings> {
  let file: z.infer<typeof settingsSchema> = {};
  try {
    file = settingsSchema.parse(
      JSON.parse(await readFile(path.join(configDirectory, "hub-remote.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HubAdminError("failed");
  }
  return settingsFromEnvironment(environment, file);
}

export type HubForwardState = "idle" | "connecting" | "ready" | "retrying";
export interface HubForwardEndpoints {
  memhub: string;
  mcphub: string;
}
type Spawn = (
  command: string,
  args: readonly string[],
  options: { stdio: "ignore" },
) => ChildProcess;
type ExecFile = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface HubForwardOptions {
  settings?: HubRemoteSettings;
  spawn?: Spawn;
  execFile?: ExecFile;
  probe?: (port: number) => Promise<boolean>;
  delay?: (ms: number) => Promise<void>;
  readinessTimeoutMs?: number;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const value = typeof address === "object" && address ? address.port : 0;
      server.close(() => (value ? resolve(value) : reject(new Error("no port"))));
    });
  });
}
function probePort(target: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: target });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
const defaultExecFile: ExecFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stderr })) : resolve({ stdout, stderr }),
    );
  });

/** One SSH forward for MemHub and MCPHub, opened lazily and kept for the Host. */
export class HubForward {
  readonly #settings: HubRemoteSettings;
  readonly #spawn: Spawn;
  readonly #execFile: ExecFile;
  readonly #probe: (port: number) => Promise<boolean>;
  readonly #delay: (ms: number) => Promise<void>;
  readonly #readinessTimeoutMs: number;
  #controlDirectory: string | null = null;
  #controlPath: string | null = null;
  #child: ChildProcess | null = null;
  #endpoints: HubForwardEndpoints | null = null;
  #state: HubForwardState = "idle";
  #attempt: Promise<HubForwardEndpoints> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #failures = 0;
  #stopped = false;
  constructor(options: HubForwardOptions = {}) {
    this.#settings = options.settings ?? DEFAULT_HUB_REMOTE_SETTINGS;
    this.#spawn =
      options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
    this.#execFile = options.execFile ?? defaultExecFile;
    this.#probe = options.probe ?? probePort;
    this.#delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 10_000;
  }
  state(): HubForwardState {
    return this.#state;
  }
  async endpoints(): Promise<HubForwardEndpoints> {
    if (this.#stopped) throw new HubAdminError("retrying");
    if (this.#state === "ready" && this.#endpoints) return this.#endpoints;
    if (this.#state === "retrying" && this.#retry) throw new HubAdminError("retrying");
    if (!this.#attempt) this.#attempt = this.#open();
    try {
      return await this.#attempt;
    } catch {
      throw new HubAdminError(this.#state === "retrying" ? "retrying" : "connecting");
    }
  }
  /** Reads the MemHub token over the master connection; callers cache the value, not the file. */
  async readToken(file: string): Promise<string> {
    const control = await this.#control();
    try {
      const { stdout } = await this.#execFile(
        "ssh",
        this.#remoteArgs(control, `cat -- ${shellQuote(file)}`),
      );
      return stdout;
    } catch (error) {
      const message = String((error as { stderr?: string }).stderr ?? "");
      throw new HubAdminError(message.includes("No such file") ? "unavailable" : "forbidden");
    }
  }
  /** Extracts only MCPHub's routing fields on the remote; raw config never returns. */
  async readMcpRouting(): Promise<McpHubRouting> {
    const control = await this.#control();
    let stdout: string;
    try {
      ({ stdout } = await this.#execFile("ssh", this.#remoteArgs(control, MCP_ROUTING_COMMAND)));
    } catch {
      throw new HubAdminError("unavailable");
    }
    let value: unknown;
    try {
      value = JSON.parse(stdout);
    } catch {
      throw new HubAdminError("failed");
    }
    if (typeof value !== "object" || value === null) throw new HubAdminError("failed");
    if ("_error" in value)
      throw new HubAdminError(
        (value as { _error?: string })._error === "missing" ? "unavailable" : "failed",
      );
    const parsed = mcpRoutingSchema.safeParse(value);
    if (!parsed.success) throw new HubAdminError("failed");
    return parsed.data;
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#attempt = null;
    this.#endpoints = null;
    this.#state = "idle";
    if (this.#controlPath) {
      await this.#execFile("ssh", [
        "-o",
        "BatchMode=yes",
        "-o",
        `ControlPath=${this.#controlPath}`,
        "-O",
        "exit",
        this.#settings.sshAlias,
      ]).catch(() => undefined);
    }
    const child = this.#child;
    this.#child = null;
    if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
    const directory = this.#controlDirectory;
    this.#controlDirectory = null;
    this.#controlPath = null;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  async #control(): Promise<string> {
    if (this.#controlPath) return this.#controlPath;
    const directory = await mkdtemp(path.join(tmpdir(), "codexhost-hub-"));
    await chmod(directory, 0o700);
    this.#controlDirectory = directory;
    this.#controlPath = path.join(directory, "control");
    return this.#controlPath;
  }
  #remoteArgs(control: string, command: string): string[] {
    return [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ControlMaster=no",
      "-o",
      `ControlPath=${control}`,
      this.#settings.sshAlias,
      command,
    ];
  }
  async #open(): Promise<HubForwardEndpoints> {
    this.#state = "connecting";
    this.#endpoints = null;
    const control = await this.#control();
    const [memhubPort, mcphubPort] = await Promise.all([freePort(), freePort()]);
    const args = [
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${control}`,
      "-o",
      "ControlPersist=no",
      "-L",
      `127.0.0.1:${memhubPort}:127.0.0.1:${this.#settings.memhubPort}`,
      "-L",
      `127.0.0.1:${mcphubPort}:127.0.0.1:${this.#settings.mcphubPort}`,
      this.#settings.sshAlias,
    ];
    const child = this.#spawn("ssh", args, { stdio: "ignore" });
    this.#child = child;
    let exited = false;
    const exit = new Promise<void>((resolve) => {
      child.once("exit", () => {
        exited = true;
        if (this.#child === child && this.#state === "ready") this.#lost(child);
        resolve();
      });
      child.once("error", () => {
        exited = true;
        resolve();
      });
    });
    try {
      const deadline = Date.now() + this.#readinessTimeoutMs;
      for (;;) {
        if (exited) throw new Error("ssh exited");
        if ((await this.#probe(memhubPort)) && (await this.#probe(mcphubPort))) break;
        if (Date.now() >= deadline) throw new Error("forward timeout");
        await Promise.race([this.#delay(150), exit]);
      }
      this.#endpoints = {
        memhub: `http://127.0.0.1:${memhubPort}`,
        mcphub: `http://127.0.0.1:${mcphubPort}`,
      };
      this.#state = "ready";
      this.#failures = 0;
      return this.#endpoints;
    } catch (error) {
      if (this.#child === child) this.#child = null;
      if (child.exitCode === null) child.kill("SIGTERM");
      this.#endpoints = null;
      this.#state = "retrying";
      this.#attempt = null;
      this.#schedule();
      throw error;
    }
  }
  #lost(child: ChildProcess): void {
    if (this.#stopped || this.#child !== child) return;
    this.#child = null;
    this.#endpoints = null;
    this.#attempt = null;
    this.#state = "retrying";
    this.#schedule();
  }
  #schedule(): void {
    if (this.#stopped || this.#retry) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.#failures, 5));
    this.#failures += 1;
    this.#retry = setTimeout(() => {
      this.#retry = null;
      if (this.#stopped) return;
      this.#attempt = this.#open();
      void this.#attempt.catch(() => undefined);
    }, delay);
  }
}

/** Owns the settings, the forward and the in-memory secret reads for one Host. */
export class HubRemote {
  readonly #settings: Promise<HubRemoteSettings>;
  readonly #forward: Promise<HubForward>;
  #token: string | null = null;
  #header: string | null = null;
  constructor(environment: NodeJS.ProcessEnv, options: HubForwardOptions = {}) {
    this.#settings = options.settings
      ? Promise.resolve(options.settings)
      : loadHubRemoteSettings(environment).catch(() => DEFAULT_HUB_REMOTE_SETTINGS);
    this.#forward = this.#settings.then((settings) => new HubForward({ ...options, settings }));
  }
  async endpoints(): Promise<HubForwardEndpoints> {
    return (await this.#forward).endpoints();
  }
  /** Read once over the master connection, keep in memory, never write to disk or logs. */
  async token(): Promise<string> {
    if (this.#token !== null) return this.#token;
    const settings = await this.#settings;
    const forward = await this.#forward;
    const value = (await forward.readToken(settings.tokenPath)).trim();
    if (!value || /[\r\n]/u.test(value)) throw new HubAdminError("forbidden");
    this.#token = value;
    return value;
  }
  async forgetToken(): Promise<void> {
    this.#token = null;
  }
  /** Keep only the derived header name; MCPHub's raw routing never stays in memory. */
  async mcphubHeaderName(): Promise<string> {
    if (this.#header !== null) return this.#header;
    const routing = await (await this.#forward).readMcpRouting();
    this.#header = headerNameFromRouting(routing);
    return this.#header;
  }
  async stop(): Promise<void> {
    this.#token = null;
    this.#header = null;
    return (await this.#forward).stop();
  }
}
