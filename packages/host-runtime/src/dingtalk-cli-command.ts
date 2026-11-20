import type { Writable } from "node:stream";

import { DelegationControlError } from "./delegation-types.js";
import { createDingTalkCli, runDwsRaw } from "./dingtalk-cli.js";
import { DINGTALK_DISPATCH_ENV } from "./dingtalk-dispatch-types.js";
import { createDingTalkTransport, DINGTALK_DWS_PEER_ROUTE } from "./dingtalk-transport.js";
import { DingTalkSettingsStore, resolveDingTalkHost } from "./dingtalk-settings.js";
import { readPeerConfig, resolvePeerTarget, type ResolvedPeer } from "./peer-config.js";
import { requestPeerRoute, type PeerSpawn } from "./peer-transport.js";

export const DINGTALK_CLI_HELP = `codexhost dingtalk

Run official DingTalk Workspace CLI (dws) commands on the configured DingTalk Host.
Read-only commands run directly; commands that change anything require --yes.
OA approval writes are always forbidden. Dispatch Threads may only read.

Usage:
  codexhost dingtalk dws [--host <peer|Host ID>] [--yes] -- <dws args...>
  codexhost dingtalk status
  codexhost dingtalk help

Options:
  --host <name>   Peer name or Desktop Host ID; defaults to the DingTalk setting.
  --yes           Confirm a non-OA write command (send, recall, create, ...).
  --format json|compact  Output format for status.

Examples:
  codexhost dingtalk dws -- chat +search-msg --query "支付" --days 7 --page-all
  codexhost dingtalk dws -- chat message list --group <cid> --limit 30
  codexhost dingtalk dws --yes -- chat message send --conversation-id <cid> --content "收到"
`;

const READ_ONLY_PREFIXES: readonly (readonly string[])[] = [
  ["auth", "status"],
  ["profile", "list"],
  ["version"],
  ["schema"],
  ["shortcut", "list"],
  ["chat", "message", "list"],
  ["chat", "message", "list-all"],
  ["chat", "message", "list-unread-conversations"],
  ["chat", "message", "query-send-status"],
  ["chat", "message", "download-media"],
  ["chat", "+chat-messages"],
  ["chat", "+search-msg"],
  ["chat", "+recent-conversations"],
  ["chat", "+unread-chats"],
  ["chat", "+conversation-info"],
  ["chat", "+chat-list"],
  ["chat", "+my-groups"],
  ["chat", "+conversation-list-top"],
  ["chat", "+messages-mget"],
  ["chat", "+messages-resource-download"],
  ["chat", "+flag-list"],
  ["chat", "+chat-search"],
  ["chat", "+chat-members-list"],
  ["chat", "+at-me"],
  ["chat", "+thread-replies"],
  ["chat", "+feed-group-query-item"],
  ["contact", "user", "search"],
  ["contact", "user", "list"],
  ["event", "schema"],
  ["event", "status"],
  ["oa", "approval", "list-pending"],
  ["oa", "approval", "detail"],
  ...[
    "ding-info",
    "forecast-process",
    "form-schema",
    "list-by-admin",
    "list-cc",
    "list-executed",
    "list-forms",
    "list-initiated",
    "list-submitted",
    "records",
    "revert-activities",
    "search-forms",
    "tasks",
  ].map((command) => ["oa", "approval", command]),
];

const DWS_GLOBAL_VALUE_OPTIONS = new Set([
  "--client-id",
  "--client-secret",
  "--fields",
  "--jq",
  "--profile",
  "--timeout",
  "--format",
  "-f",
]);
const DWS_GLOBAL_FLAGS = new Set([
  "--debug",
  "--dry-run",
  "--mock",
  "--verbose",
  "-v",
  "--yes",
  "-y",
  "--help",
  "-h",
]);

/** Stop at the command leaf: option values and query text are never command words. */
function classifyDwsCommand(args: readonly string[]): { write: boolean; oa: boolean } {
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      const option = arg.split("=", 1)[0] ?? arg;
      if (DWS_GLOBAL_VALUE_OPTIONS.has(option)) {
        if (!arg.includes("=")) {
          const value = args[++index];
          if (!value || value.startsWith("-"))
            throw new DelegationControlError("INVALID_ARGUMENT", `${option} requires a value`);
        }
      } else if (!DWS_GLOBAL_FLAGS.has(arg) && !(arg.startsWith("-f") && arg.length > 2)) {
        // Ambiguous options cannot hide an OA command behind --yes.
        throw new DelegationControlError(
          "INVALID_ARGUMENT",
          `Unsupported dws command option '${arg}'`,
        );
      }
      continue;
    }
    words.push(arg);
    const prefixes = READ_ONLY_PREFIXES.filter((prefix) =>
      words.every((word, offset) => prefix[offset] === word),
    );
    if (prefixes.some((prefix) => prefix.length === words.length))
      return { write: false, oa: words[0] === "oa" };
    if (prefixes.length === 0) break;
  }
  return { write: true, oa: words[0] === "oa" || words[0] === "approval" };
}

/** Unknown commands are treated as writes so a new dws command cannot bypass consent. */
export function isDwsWriteCommand(args: readonly string[]): boolean {
  return classifyDwsCommand(args).write;
}

export interface DingTalkCliArguments {
  host: string | null;
  yes: boolean;
  dws: string[];
}

export function parseDingTalkCliArguments(args: readonly string[]): DingTalkCliArguments {
  let host: string | null = null;
  let yes = false;
  let separator = -1;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument === "--") {
      separator = index;
      break;
    }
    if (argument === "--host") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new DelegationControlError("INVALID_ARGUMENT", "--host requires a value");
      }
      host = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--host=")) {
      host = argument.slice("--host=".length);
      if (!host) throw new DelegationControlError("INVALID_ARGUMENT", "--host requires a value");
      continue;
    }
    if (argument === "--yes" || argument === "-y") {
      yes = true;
      continue;
    }
    if (!argument.startsWith("-")) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "dws arguments must follow '--', for example: codexhost dingtalk dws -- chat +unread-chats",
      );
    }
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `Unknown option '${argument}'. Pass dws arguments after '--'.`,
    );
  }
  if (separator < 0) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "dws arguments must follow '--', for example: codexhost dingtalk dws -- chat +unread-chats",
    );
  }
  return { host, yes, dws: args.slice(separator + 1) };
}

interface Target {
  local: boolean;
  name: string;
  peer: ResolvedPeer | null;
}

async function resolveTarget(environment: NodeJS.ProcessEnv, host: string | null): Promise<Target> {
  if (!host) {
    const settings = new DingTalkSettingsStore({ environment });
    const resolved = await resolveDingTalkHost(environment, await settings.read());
    return { local: resolved.local, name: resolved.name, peer: resolved.peer };
  }
  if (host === "local") return { local: true, name: "local", peer: null };
  const config = await readPeerConfig(environment);
  const target = resolvePeerTarget(config, host);
  if (!target) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      `DingTalk Host '${host}' is not configured`,
    );
  }
  if (target === "local") return { local: true, name: "local", peer: null };
  return { local: false, name: target.name, peer: target };
}

export interface RunDingTalkCliInput {
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  output?: Writable;
  diagnosticOutput?: Writable;
  timeoutMs?: number;
  spawnImpl?: PeerSpawn;
}

/** Passes dws output through unchanged and returns the CLI exit code. */
export async function runDingTalkCli(input: RunDingTalkCliInput): Promise<number> {
  const output = input.output ?? process.stdout;
  const diagnosticOutput = input.diagnosticOutput ?? process.stderr;
  const environment = input.environment ?? process.env;
  const [command, ...rest] = input.arguments;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    output.write(DINGTALK_CLI_HELP);
    return 0;
  }
  if (command === "status") {
    const cli = createDingTalkCli({
      environment,
      runImpl: (args, timeoutMs) => createDingTalkTransport({ environment }).run(args, timeoutMs),
    });
    const status = await cli.authStatus();
    output.write(`${JSON.stringify(status, null, 2)}\n`);
    return status.installed && status.authenticated ? 0 : 1;
  }
  if (command !== "dws") {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "Unknown DingTalk command. Run 'codexhost dingtalk --help'.",
    );
  }
  const parsed = parseDingTalkCliArguments(rest);
  if (parsed.dws.length === 0 || parsed.dws[0] === "--help" || parsed.dws[0] === "-h") {
    output.write(DINGTALK_CLI_HELP);
    return 0;
  }
  const { write, oa } = classifyDwsCommand(parsed.dws);
  if (write && oa) {
    throw new DelegationControlError("INVALID_ARGUMENT", "审批状态只能由你本人在钉钉里处理");
  }
  if (write && environment[DINGTALK_DISPATCH_ENV] === "1") {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "派发对话只能读取钉钉数据；回复只能由派发器发送到原会话，智能体不能执行 dws 写命令",
    );
  }
  if (write && !parsed.yes) {
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "consent_required: this dws command changes DingTalk; ask the user first, then rerun with --yes",
    );
  }
  const args = [...parsed.dws];
  if (write && !args.includes("--yes") && !args.includes("-y")) args.push("--yes");
  const target = await resolveTarget(environment, parsed.host);
  const timeoutMs = input.timeoutMs ?? (write ? 120_000 : 60_000);
  let raw;
  if (target.local) {
    raw = await runDwsRaw(args, { environment, timeoutMs });
  } else if (!target.peer) {
    throw new DelegationControlError("RUNTIME_UNREACHABLE", "DingTalk Host is unavailable");
  } else {
    const response = await requestPeerRoute({
      environment,
      peer: target.peer,
      route: DINGTALK_DWS_PEER_ROUTE,
      body: { args },
      timeoutMs,
      ...(input.spawnImpl ? { spawnImpl: input.spawnImpl } : {}),
    });
    raw = {
      exitCode: typeof response.exitCode === "number" ? response.exitCode : null,
      stdout: typeof response.stdout === "string" ? response.stdout : "",
      stderr: typeof response.stderr === "string" ? response.stderr : "",
      timedOut: response.timedOut === true,
    };
  }
  if (raw.stdout) output.write(raw.stdout);
  if (raw.stderr) diagnosticOutput.write(raw.stderr);
  if (raw.timedOut) {
    throw new DelegationControlError("RUNTIME_UNREACHABLE", "dws timed out");
  }
  return raw.exitCode ?? 1;
}
