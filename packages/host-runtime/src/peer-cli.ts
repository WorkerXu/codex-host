import type { Writable } from "node:stream";

import { peerCliHelp } from "./delegation-cli-help.js";
import { parseDelegationArguments } from "./delegation-cli-options.js";
import { DelegationControlError } from "./delegation-types.js";
import {
  readPeerConfig,
  resolvePeerTarget,
  validateHostId,
  validatePeerName,
  validateRemoteCommand,
  validateSshAlias,
  writePeerConfig,
  type PeerConfig,
  type PeerEntry,
} from "./peer-config.js";
import { DEFAULT_PEER_TIMEOUT_MS, requestPeerRoute, type PeerSpawn } from "./peer-transport.js";

function writeJson(output: Writable, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatOption(parsed: ReturnType<typeof parseDelegationArguments>): void {
  const format = parsed.options.get("--format");
  if (format !== undefined && format !== "json" && format !== "compact") {
    throw new DelegationControlError("INVALID_ARGUMENT", "--format must be json or compact");
  }
}

function rejectOptions(
  parsed: ReturnType<typeof parseDelegationArguments>,
  allowed: readonly string[],
): void {
  const known = new Set([...allowed, "--format"]);
  for (const name of parsed.options.keys()) {
    if (!known.has(name)) {
      throw new DelegationControlError("INVALID_ARGUMENT", `Unknown option '${name}'`);
    }
  }
}

function valueAfter(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index];
  if (value === undefined || value.startsWith("--")) {
    throw new DelegationControlError("INVALID_ARGUMENT", `${option} requires a value`);
  }
  return value;
}

function parseAddArguments(arguments_: readonly string[]): {
  name: string;
  ssh: string;
  hostIds: string[];
  command?: string;
} {
  let name: string | undefined;
  let ssh: string | undefined;
  let command: string | undefined;
  const hostIds: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument) continue;
    const separator = argument.indexOf("=");
    const option = separator === -1 ? argument : argument.slice(0, separator);
    if (!option.startsWith("--")) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "peer add accepts no positional arguments",
      );
    }
    const inline = separator === -1 ? undefined : argument.slice(separator + 1);
    if (!["--name", "--ssh", "--host-id", "--command", "--format"].includes(option)) {
      throw new DelegationControlError("INVALID_ARGUMENT", `Unknown option '${option}'`);
    }
    const value = inline ?? valueAfter(arguments_, ++index, option);
    if (value === "") {
      throw new DelegationControlError("INVALID_ARGUMENT", `${option} requires a value`);
    }
    if (option === "--host-id") {
      hostIds.push(validateHostId(value));
      continue;
    }
    if (seen.has(option)) {
      throw new DelegationControlError("INVALID_ARGUMENT", `${option} may only be provided once`);
    }
    seen.add(option);
    if (option === "--name") name = value;
    else if (option === "--ssh") ssh = value;
    else if (option === "--command") command = validateRemoteCommand(value);
    else if (value !== "json" && value !== "compact") {
      throw new DelegationControlError("INVALID_ARGUMENT", "--format must be json or compact");
    }
  }
  if (!name || !ssh) {
    throw new DelegationControlError("INVALID_ARGUMENT", "--name and --ssh are required");
  }
  return {
    name: validatePeerName(name),
    ssh: validateSshAlias(ssh),
    hostIds: [...new Set(hostIds)],
    ...(command ? { command } : {}),
  };
}

function peerOutput(config: PeerConfig): unknown {
  return {
    peers: Object.entries(config.peers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => ({ name, ...entry })),
  };
}

/** Owns `<data-dir>/peers.json`; routing code only reads it through peer-config. */
export async function runPeerCli(input: {
  arguments: string[];
  environment?: NodeJS.ProcessEnv;
  output?: Writable;
  timeoutMs?: number;
  spawnImpl?: PeerSpawn;
}): Promise<number> {
  const output = input.output ?? process.stdout;
  const environment = input.environment ?? process.env;
  const help = peerCliHelp(input.arguments);
  if (help !== undefined) {
    output.write(help);
    return 0;
  }
  const [command, ...rest] = input.arguments;
  if (command === "list") {
    const parsed = parseDelegationArguments(rest);
    rejectOptions(parsed, []);
    if (parsed.positionals.length > 0) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        "peer list accepts no positional arguments",
      );
    }
    formatOption(parsed);
    writeJson(output, peerOutput(await readPeerConfig(environment)));
    return 0;
  }
  if (command === "add") {
    const added = parseAddArguments(rest);
    const config = await readPeerConfig(environment);
    if (Object.hasOwn(config.peers, added.name)) {
      throw new DelegationControlError(
        "INVALID_ARGUMENT",
        `Peer '${added.name}' already exists; remove it before adding it again`,
      );
    }
    const entry: PeerEntry = {
      ssh: added.ssh,
      hostIds: added.hostIds,
      ...(added.command ? { command: added.command } : {}),
    };
    const peers = { ...config.peers, [added.name]: entry };
    await writePeerConfig(environment, { ...config, peers });
    writeJson(output, { peer: { name: added.name, ...entry } });
    return 0;
  }
  if (command === "remove") {
    const parsed = parseDelegationArguments(rest);
    rejectOptions(parsed, []);
    formatOption(parsed);
    if (parsed.positionals.length !== 1) {
      throw new DelegationControlError("INVALID_ARGUMENT", "peer remove requires one peer name");
    }
    const name = parsed.positionals[0] as string;
    const config = await readPeerConfig(environment);
    if (!Object.hasOwn(config.peers, name)) {
      throw new DelegationControlError("INVALID_ARGUMENT", `Peer '${name}' is not configured`);
    }
    const peers = Object.fromEntries(
      Object.entries(config.peers).filter(([peerName]) => peerName !== name),
    );
    await writePeerConfig(environment, { ...config, peers });
    writeJson(output, { removed: name });
    return 0;
  }
  if (command === "test") {
    const parsed = parseDelegationArguments(rest);
    rejectOptions(parsed, []);
    formatOption(parsed);
    if (parsed.positionals.length !== 1) {
      throw new DelegationControlError("INVALID_ARGUMENT", "peer test requires one peer name");
    }
    const name = parsed.positionals[0] as string;
    const target = resolvePeerTarget(await readPeerConfig(environment), name);
    if (!target || target === "local" || target.name !== name) {
      throw new DelegationControlError("INVALID_ARGUMENT", `Peer '${name}' is not configured`);
    }
    const result = await requestPeerRoute({
      environment,
      peer: target,
      route: "/v1/harness/list",
      body: {},
      timeoutMs: input.timeoutMs ?? DEFAULT_PEER_TIMEOUT_MS,
      ...(input.spawnImpl ? { spawnImpl: input.spawnImpl } : {}),
    });
    if (!Array.isArray(result.harnesses)) {
      throw new DelegationControlError("INTERNAL_ERROR", "Peer returned an invalid Harness list");
    }
    writeJson(output, { peer: name, harnesses: result.harnesses });
    return 0;
  }
  throw new DelegationControlError(
    "INVALID_ARGUMENT",
    "Unknown peer command. Run 'codexhost peer --help'.",
  );
}
