import { consumesNextArgument } from "./delegation-cli-options.js";

const COMMAND_HELP = {
  "harness list": `codexhost harness list [--host <peer-or-host-id>] [--format json|compact]
List Harnesses available in the active Runtime.
--host routes discovery to a configured SSH peer; omit it or use local for this machine.`,
  "harness inspect": `codexhost harness inspect <harness> [--cwd <path>] [--refresh true|false] [--host <peer-or-host-id>] [--format json|compact]
Read available Models, native defaults, Thinking options, and configuration capabilities.
Use the returned Model and Thinking IDs for explicit selections.
--host routes inspection to a configured SSH peer.`,
  "delegate start": `codexhost delegate start --harness <id> --task <text> [--task-name <name>] [--cwd <path>] [--model <opaque-ref>] [--thinking <option-id>] [--parent-thread <thread>] [--request-id <id>] [--watch true|false] [--watch-timeout-ms <n>] [--host <peer-or-host-id>] [--format json|compact]
Create an independent child Thread, submit the task, and return immediately.
--task-name supplies a short subtask name (1-120 characters); otherwise the first task line is used.
The child title is "subtask name · parent title", fixed at creation; renaming the parent does not rename existing children.
Omit --model and --thinking to use the Harness native defaults.
--cwd overrides the child workspace; a relative path resolves against the caller process cwd. Otherwise use the resolved parent Thread workspace, then the Host Runtime process cwd. A cross-machine path must exist on the peer.
--parent-thread overrides caller inference. PARENT_THREAD_AMBIGUOUS requires an explicit parent.
Reuse --request-id for an idempotent retry. Identical recent parent/target/task/configuration requests are also deduplicated briefly.
--watch true also registers thread watch on the child with the resolved parent as the notified Thread; the response's watch field reports whether it was registered.
--host runs the start on an SSH peer. Cross-machine starts have no parent Thread, reject --parent-thread and --watch, and return a host-qualified Thread link; follow them with thread wait --host.
The response confirms cwd and parent. Use its Thread reference with thread read, wait, send, cancel, or watch.`,
  "thread send": `codexhost thread send <thread> [--host <peer-or-host-id>] [--message <text>] [--format json|compact]
Start a new Turn in an idle writable Thread and return immediately.
A thread://<id>?hostId=<x> reference or --host routes to a configured SSH peer; local and unconfigured hosts use the local Runtime.
THREAD_BUSY means the current Turn is still active: wait or cancel before sending. Messages are not queued.
To be notified when that Turn ends, run thread watch after sending. Thread watch is local-only.`,
  "thread cancel": `codexhost thread cancel <thread> [--host <peer-or-host-id>] [--format json|compact]
Request cancellation of the active Turn while preserving the Thread and history.
A thread://<id>?hostId=<x> reference or --host routes to a configured SSH peer.
cancelled=true (compact: cancelRequested=true) means the cancellation request was accepted. Read or wait to confirm the terminal state. An idle Thread returns false.`,
  "thread read": `codexhost thread read <thread> [--host <peer-or-host-id>] [--view result|messages] [--cursor <cursor>] [--limit <n>] [--format json|compact]
Read immediately without starting a Turn. Accepts thread://<id>?hostId=<encoded-host-id> or --host with a bare ID.
A configured peer is read over SSH. Without a peer, a non-local Host falls back to the existing Desktop remote connection, which needs updated local and remote codexhost and an available Desktop Host connection.
The default result view reports the latest Turn's status and result.
The messages view pages visible user/Agent messages, oldest first. Default limit 25, maximum 100; --cursor and --limit require --view messages.
hasMore describes remaining messages now. Save nextCursor for later incremental reads even when hasMore=false.
Compact messages output contains only the message page and status; compact result output includes the latest nonempty progress while running.
Full JSON retains the complete snapshot. Tool calls/output, file activity, and reasoning are not included in either format.`,
  "thread wait": `codexhost thread wait <thread> [--host <peer-or-host-id>] [--timeout-ms <n>] [--view result|messages] [--cursor <cursor>] [--limit <n>] [--format json|compact]
Wait until the Thread is terminal or the timeout expires (default 30000 ms), then return the same snapshot as thread read plus timedOut.
A thread://<id>?hostId=<x> reference or --host waits on a configured SSH peer; unknown non-local Hosts are rejected.
timedOut=true is a running checkpoint: the child keeps running. The response already includes the result when available; another read is unnecessary unless more information is needed.
Message pagination uses --view messages, default limit 25, maximum 100. hasMore is for current pages; nextCursor also supports future incremental reads.`,
  "thread watch": `codexhost thread watch <thread> [--notify <thread>] [--timeout-ms <n>] [--format json|compact]
Ask the Host to notify one Thread, once, when the watched Thread stops. Returns immediately; no waiting or polling by the caller is needed, and the caller may end its Turn.
Thread watch is local-only in this version: a thread:// reference with a hostId or --host fails with an explicit error. Use thread wait --host <peer> for a remote Thread.
--notify defaults to the calling Thread when it is identified (CODEXHOST_THREAD_ID, or CODEX_THREAD_ID in native Codex); otherwise it is required. delegate start reports the caller as its parent.
The notification starts a new Turn in the notified Thread with the watched Thread's link and outcome: completed, failed, interrupted, timedOut, unreadable, or notFound; a terminal outcome names the Turn it came from. It reports execution state only; read the Thread to judge the work.
--timeout-ms defaults to 1740000 (29 min). timedOut means the Thread had not reached a terminal state, which also covers a Harness that stopped without reporting it; watch again to keep waiting. unreadable means reads failed for 60 s, so the state is unknown.
state=watching means registered. state=alreadyTerminal means the Thread was not running: nothing was registered and nothing will be sent.
A busy notified Thread is notified after its Turn ends (retried for up to 6 hours); notifications due together arrive as one message. THREAD_BUSY is never treated as delivered.
A watch is one-shot and cannot be cancelled. Watching the same pair again while it is still watched returns that watch; once it has stopped, a new watch covers the next stop and any pending notification is still delivered. Watches live in Host Runtime memory and are lost when it restarts.`,
  "thread watches": `codexhost thread watches [--host <peer-or-host-id>] [--format json|compact]
List watches that have not been delivered: watching, pendingDelivery (waiting for the notified Thread), or undeliverable (with the reason). Delivered watches are removed.
The watch registry is local-only in this version; a non-local --host fails with an explicit error.`,
  "thread list": `codexhost thread list [--cwd <path>] [--parent <thread>] [--limit <n>] [--cursor <cursor>] [--sort created-asc|created-desc|updated-asc|updated-desc|recency-asc|recency-desc] [--format json|compact]
Find existing Threads by workspace, or use --parent to list a Thread's delegated children.
Workspace listing defaults to the caller process cwd. Default limit 25 (maximum 100), sorted created-desc.
--parent uses Delegation relationships. A null nextCursor ends the list.
Compact output keeps task links, Harness, status, title, and workspace.`,
} as const;

const PEER_COMMAND_HELP = {
  "peer list": `codexhost peer list [--format json|compact]
List peers configured in ~/.codexhost/peers.json and the self Host IDs that stay local.`,
  "peer add": `codexhost peer add --name <name> --ssh <alias> [--host-id <id>]... [--command <path>] [--format json|compact]
Register a machine reachable through an SSH config alias.
--host-id may be repeated; the first ID is used in Thread links. Desktop normally reports another machine as remote-ssh-discovered:<alias>.
--command overrides the remote codexhost executable when it is not on the peer's non-interactive PATH.`,
  "peer remove": `codexhost peer remove <name> [--format json|compact]
Remove a peer from ~/.codexhost/peers.json. Existing remote Threads are not changed.`,
  "peer test": `codexhost peer test <name> [--format json|compact]
Run harness list on the peer through SSH and print the returned Harnesses.`,
  "peer self": `codexhost peer self [list] [--format json|compact]
Show the Desktop Host IDs that identify this machine. Links using these IDs stay local.`,
  "peer self list": `codexhost peer self list [--format json|compact]
Show the Desktop Host IDs that identify this machine.`,
  "peer self add": `codexhost peer self add <hostId> [--format json|compact]
Treat a Desktop Host ID as this machine, so thread://<id>?hostId=<hostId> reads locally.
The same Host ID cannot also be configured for a peer.`,
  "peer self remove": `codexhost peer self remove <hostId> [--format json|compact]
Stop treating a Desktop Host ID as this machine.`,
} as const;

export type DelegationCliCommand = keyof typeof COMMAND_HELP;
export type PeerCliCommand = keyof typeof PEER_COMMAND_HELP;

const COMMON_HELP = `Thread references accept a bare ID, codex://threads/<id>, or thread://<id>?hostId=<encoded-host-id>.
--host <peer-or-host-id> routes delegate start, harness list|inspect, and thread read|send|cancel|wait to a peer configured in ~/.codexhost/peers.json; a Thread reference with hostId routes automatically. A Host ID configured under peer self stays local. --host local, or no --host, uses this machine.
A cross-machine delegate start has no parent Thread, rejects --parent-thread and --watch, and returns a host-qualified Thread link; use thread wait --host afterwards. thread watch and thread watches are local-only.
Options accept --name <value> or --name=<value>. --task, --task-name, and --message take the next argument verbatim, even when it is empty or starts with --.
--format json is the compatible full JSON output (default); --format compact returns concise JSON using task links instead of internal IDs.
Success is written to stdout; errors {"error":{"code":"...","message":"...","details":{...}}} go to stderr with exit code 1. Exit code 0 means the command succeeded, not that the delegated task succeeded.
read/wait are non-consuming. Native Codex callers need local Runtime access; RUNTIME_UNREACHABLE requires the Host-provided environment and a sandbox that permits that connection.
Native Codex shell commands also need the Host-provided CODEXHOST_* environment variables. If shell_environment_policy filters them, prefer inherit = "all" with ignore_default_excludes = true and a narrow include_only containing "CODEXHOST_RUNTIME_ENDPOINT" and "CODEXHOST_RUNTIME_TOKEN" plus the variables required by the platform and invoked tools. Avoid unconstrained inherit = "all", which forwards unrelated ambient variables.`;

export const PEER_HELP = `usage:
  codexhost peer list
  codexhost peer add --name <name> --ssh <alias> [--host-id <id>]...
  codexhost peer remove <name>
  codexhost peer test <name>
  codexhost peer self [list]
  codexhost peer self add|remove <hostId>

Peers are stored in ~/.codexhost/peers.json (CODEXHOST_USER_DIR moves that fixed user directory; CODEXHOST_DATA_DIR does not).
The control endpoint and SSH ControlPath use the same fixed user directory, so a normal SSH session sees the Desktop-managed Runtime.
The SSH alias comes from ~/.ssh/config and must authenticate non-interactively (BatchMode).
The peer must run codexhost and have a live Host Runtime. peer-exec is its hidden remote entry point.
Use the peer name or any configured Host ID with --host. Use <command> --help for command options.
`;

export const DELEGATION_HELP = `usage:
  codexhost harness list
  codexhost harness inspect <harness>
  codexhost delegate start --harness <id> --task <text>
  codexhost thread send <thread> --message <text>
  codexhost thread cancel <thread>
  codexhost thread read <thread>
  codexhost thread wait <thread>
  codexhost thread watch <thread>
  codexhost thread watches
  codexhost thread list
  codexhost peer list|add|remove|test|self

Use <command> --help for its options. Use harness list to discover targets.
${COMMON_HELP}
`;

function hasHelpOption(arguments_: readonly string[]): boolean {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") return true;
    if (argument && consumesNextArgument(argument, arguments_[index + 1])) index += 1;
  }
  return false;
}

export function delegationCliHelp(arguments_: readonly string[]): string | undefined {
  const [group, command, ...rest] = arguments_;
  if (!group || group === "--help" || group === "-h") return DELEGATION_HELP;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    if (group === "delegate") return DELEGATION_HELP;
    if (group === "harness" || group === "thread") {
      const usages = Object.entries(COMMAND_HELP)
        .filter(([name]) => name.startsWith(`${group} `))
        .map(([, help]) => help.split("\n")[0]);
      return `${usages.join("\n")}\n\n${COMMON_HELP}\n`;
    }
  }
  if (hasHelpOption(rest)) {
    const name = `${group} ${command}`;
    if (Object.hasOwn(COMMAND_HELP, name)) {
      return `${COMMAND_HELP[name as DelegationCliCommand]}\n\n${COMMON_HELP}\n`;
    }
  }
  return undefined;
}

export function peerCliHelp(arguments_: readonly string[]): string | undefined {
  const [command, ...rest] = arguments_;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    return PEER_HELP;
  }
  const [subcommand, ...tail] = rest;
  if (command === "self" && subcommand && !subcommand.startsWith("-") && hasHelpOption(tail)) {
    const scoped = `peer self ${subcommand}`;
    if (Object.hasOwn(PEER_COMMAND_HELP, scoped)) {
      return `${PEER_COMMAND_HELP[scoped as PeerCliCommand]}\n\n${PEER_HELP}\n`;
    }
  }
  if (hasHelpOption(rest)) {
    const name = `peer ${command}`;
    if (Object.hasOwn(PEER_COMMAND_HELP, name)) {
      return `${PEER_COMMAND_HELP[name as PeerCliCommand]}\n\n${PEER_HELP}\n`;
    }
  }
  return undefined;
}
