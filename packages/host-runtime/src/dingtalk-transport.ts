import { spawn } from "node:child_process";

import {
  createDingTalkCli,
  dwsErrorFromValue,
  parseDwsEventLine,
  runDwsJson,
  runDwsRaw,
  type DwsEventRecord,
  type DwsRawResult,
  type DwsResult,
  type DwsSpawn,
  type DingTalkEventStream,
} from "./dingtalk-cli.js";
import {
  downloadDingTalkMedia,
  type DingTalkMediaRequest,
  type DingTalkMediaResult,
} from "./dingtalk-media.js";
import {
  DingTalkSettingsStore,
  resolveDingTalkHost,
  type DingTalkHostResolution,
} from "./dingtalk-settings.js";
import {
  peerSshArguments,
  peerSshEnvironment,
  requestPeerRoute,
  type PeerSpawn,
} from "./peer-transport.js";

import { DINGTALK_DWS_PEER_ROUTE, DINGTALK_MEDIA_PEER_ROUTE } from "./dingtalk-peer.js";

export { DINGTALK_DWS_PEER_ROUTE, DINGTALK_MEDIA_PEER_ROUTE };
const PEER_TIMEOUT_MS = 45_000;

export interface DingTalkTransport {
  /** Known immediately; refreshed when settings change. */
  readonly local: boolean;
  readonly hostName: string;
  /** The configured Host can run the dws event stream (locally or over SSH). */
  readonly canListen: boolean;
  configure(resolution: DingTalkHostResolution): void;
  refresh(): Promise<DingTalkHostResolution>;
  run(args: readonly string[], timeoutMs?: number): Promise<DwsResult>;
  runRaw(args: readonly string[], timeoutMs?: number): Promise<DwsRawResult>;
  /** Streams `dws event consume` from a peer; local Hosts use the CLI path. */
  openEvents(input: {
    onRecord(record: DwsEventRecord): void;
    onExit?(): void;
  }): Promise<DingTalkEventStream | null>;
  /** Reads a message image from the DingTalk Host's cached download. */
  readMedia(request: DingTalkMediaRequest): Promise<DingTalkMediaResult>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResult(raw: DwsRawResult): DwsResult {
  let value: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw.stdout.trim());
    if (record(parsed)) value = parsed;
  } catch {
    value = null;
  }
  const failure = dwsErrorFromValue(value);
  return {
    ...raw,
    value,
    errorCode: raw.timedOut
      ? "timeout"
      : raw.exitCode === null
        ? "peer_unavailable"
        : (failure.code ?? (raw.exitCode === 0 ? null : "cli_failed")),
    errorMessage: failure.message,
  };
}

/**
 * Reads run on the configured DingTalk Host. The Host that owns the login
 * executes dws directly; every other Host forwards the same argument array
 * through peer-exec, so the CLI sees identical flags everywhere.
 */
export function createDingTalkTransport(input: {
  environment: NodeJS.ProcessEnv;
  settings?: DingTalkSettingsStore;
  spawnImpl?: DwsSpawn;
  peerSpawnImpl?: PeerSpawn;
}): DingTalkTransport {
  const settings = input.settings ?? new DingTalkSettingsStore({ environment: input.environment });
  let resolution: DingTalkHostResolution = {
    name: "local",
    hostId: null,
    local: true,
    peer: null,
  };

  const refreshResolution = async (): Promise<DingTalkHostResolution> => {
    resolution = await resolveDingTalkHost(input.environment, await settings.read());
    return resolution;
  };
  let ready: Promise<unknown> = refreshResolution();

  const executeRemote = async (
    args: readonly string[],
    timeoutMs: number,
  ): Promise<DwsRawResult> => {
    if (!resolution.peer) {
      return {
        exitCode: null,
        stdout: "",
        stderr: "DingTalk Host is unavailable",
        timedOut: false,
        truncated: false,
      };
    }
    try {
      const response = await requestPeerRoute({
        environment: input.environment,
        peer: resolution.peer,
        route: DINGTALK_DWS_PEER_ROUTE,
        body: { args: [...args] },
        timeoutMs,
        ...(input.peerSpawnImpl ? { spawnImpl: input.peerSpawnImpl } : {}),
      });
      return {
        exitCode: typeof response.exitCode === "number" ? response.exitCode : null,
        stdout: typeof response.stdout === "string" ? response.stdout : "",
        stderr: typeof response.stderr === "string" ? response.stderr : "",
        timedOut: response.timedOut === true,
        truncated: response.truncated === true,
      };
    } catch (error) {
      return {
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        truncated: false,
      };
    }
  };

  const transport: DingTalkTransport = {
    get local() {
      return resolution.local;
    },
    get hostName() {
      return resolution.name;
    },
    get canListen() {
      return resolution.local || resolution.peer !== null;
    },
    configure(next) {
      resolution = next;
    },
    async refresh() {
      return await refreshResolution();
    },
    async run(args, timeoutMs = PEER_TIMEOUT_MS) {
      await ready;
      return resolution.local
        ? await runDwsJson(args, {
            environment: input.environment,
            timeoutMs,
            ...(input.spawnImpl ? { spawnImpl: input.spawnImpl } : {}),
          })
        : jsonResult(await executeRemote([...args, "--format", "json"], timeoutMs));
    },
    async runRaw(args, timeoutMs = PEER_TIMEOUT_MS) {
      await ready;
      return resolution.local
        ? await runDwsRaw(args, {
            environment: input.environment,
            timeoutMs,
            ...(input.spawnImpl ? { spawnImpl: input.spawnImpl } : {}),
          })
        : await executeRemote(args, timeoutMs);
    },
    async openEvents(events) {
      await ready;
      if (resolution.local)
        return createDingTalkCli({
          environment: input.environment,
          ...(input.spawnImpl ? { spawnImpl: input.spawnImpl } : {}),
        }).openEvents(events);
      if (!resolution.peer) return null;
      const peer = resolution.peer;
      const base = peerSshArguments({ environment: input.environment, peer });
      const args = [
        ...base.args.slice(0, -2),
        "~/.local/bin/dws",
        "event",
        "consume",
        "user_im_message_receive_o2o_all",
        "user_im_message_receive_group_all",
        "--flatten",
        "-f",
        "ndjson",
      ];
      let child;
      try {
        const spawnImpl: PeerSpawn = input.peerSpawnImpl ?? (spawn as unknown as PeerSpawn);
        child = spawnImpl(base.command, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: peerSshEnvironment(input.environment),
        });
      } catch {
        return null;
      }
      let buffer = "";
      let stopped = false;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 8 * 1024 * 1024) buffer = buffer.slice(-8 * 1024 * 1024);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const parsed = parseDwsEventLine(line);
          if (parsed && !stopped) events.onRecord(parsed);
          newline = buffer.indexOf("\n");
        }
      });
      child.stdin.end();
      child.stderr.resume();
      child.on("error", () => {
        if (!stopped) events.onExit?.();
      });
      child.on("close", () => {
        if (!stopped) events.onExit?.();
      });
      return {
        stop() {
          if (stopped) return;
          stopped = true;
          child.kill("SIGTERM");
        },
      };
    },
    async readMedia(request) {
      await ready;
      if (resolution.local) {
        return await downloadDingTalkMedia({
          environment: input.environment,
          request,
          ...(input.spawnImpl ? { spawnImpl: input.spawnImpl } : {}),
        });
      }
      if (!resolution.peer) {
        return {
          ok: false,
          base64: null,
          mimeType: null,
          sizeBytes: null,
          errorCode: "peer_unavailable",
        };
      }
      try {
        const response = await requestPeerRoute({
          environment: input.environment,
          peer: resolution.peer,
          route: DINGTALK_MEDIA_PEER_ROUTE,
          body: { ...request },
          timeoutMs: 60_000,
          ...(input.peerSpawnImpl ? { spawnImpl: input.peerSpawnImpl } : {}),
        });
        return {
          ok: response.ok === true,
          base64: typeof response.base64 === "string" ? response.base64 : null,
          mimeType: typeof response.mimeType === "string" ? response.mimeType : null,
          sizeBytes: typeof response.sizeBytes === "number" ? response.sizeBytes : null,
          errorCode: typeof response.errorCode === "string" ? response.errorCode : null,
        };
      } catch {
        return {
          ok: false,
          base64: null,
          mimeType: null,
          sizeBytes: null,
          errorCode: "peer_unavailable",
        };
      }
    },
  };
  // A failed initial settings read must not block the first request; refresh
  // reports the error and the transport stays local.
  ready = ready.catch(() => undefined);
  return transport;
}
