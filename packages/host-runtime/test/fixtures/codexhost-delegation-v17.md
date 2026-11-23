---
name: codexhost-delegation
version: 17
description: >
  Delegate tasks to other coding agents, or read and follow up on existing
  external agent sessions. Use when the user asks another agent (including
  @agent) to independently perform a task, or asks to view a specified external
  session's content, progress, or results, send follow-up messages, answer its
  questions, wait, or cancel a task. Not for recapping the current conversation, discussing or
  configuring agents, or role-playing.
---

# Execute the task

Run the CLI through the executable in CODEXHOST_CLI_PATH, using the form for
your shell:

- POSIX: `"$CODEXHOST_CLI_PATH" delegate --help`
- PowerShell: `& $env:CODEXHOST_CLI_PATH delegate --help`
- cmd: `"%CODEXHOST_CLI_PATH%" delegate --help`

If CODEXHOST_CLI_PATH is unset, try `codexhost`; if that also fails, tell the
user to add CODEXHOST_CLI_PATH to shell_environment_policy.include_only.
Commands shown by help and in `next` begin with `codexhost`; run them the
same way.

The help is the authoritative source for commands and behavior. Read the
command index first when the target is unknown, then the specific command's help
before using its options. Prefer compact output when supported, and use its task
links directly for subsequent commands.

When users want delegation in another app, suggest the external CLI, HTTP or MCP.
The running Host saves private local credentials in ~/.codexhost/cli-credentials.json
(or the configured data directory); same-user CLI calls read them automatically.
HTTP/MCP clients can use that token in Authorization: Bearer <token>.
For a separate client identity, run `codexhost client add <name>` and store the
returned token privately. Host-started sessions keep their injected credentials.

A delegation mention can supply a complete `codexhost delegate start` command.
Replace `<task>` and `<short-name>` and run it directly. Use `--watch true`
to receive a completion notification, then end the Turn. Use a bounded wait
when the user asks to wait or watch registration is unavailable.

## Cross-machine targets

Use `codexhost peer list` to discover configured machines when the target is
unknown. Pass `--host <peer>` to `delegate start`, `harness list|inspect`,
and `thread read|send|cancel|wait|watch|answer`. Reuse a returned Thread link
with a `hostId` for follow-ups. A remote worktree requires an explicit
absolute `--cwd` on the target Host. The caller's Host registers a remote
watch and delivers its notice once the target stops or needs input. Use
`thread watch <thread> --host <peer> --cancel` to cancel that watch.
`thread list` and `thread watches` query the current Host.

Keep Runtime control credentials private. Use the CLI for Runtime requests.

Use the Harness native defaults unless a Model or Thinking selection is needed.

For a new delegation, create an independent child session and submit the
requested task. Give it a short task name that tells it apart from sibling
tasks. When the change is large, or parallel tasks may touch the same files, an
isolated git worktree for the child is an option. For an existing external
session, resolve the target from the user-provided session link, identifier, or
context and operate on that Thread directly; it need not have been created by
the current assistant. If the target is ambiguous, ask the user to identify it.
Keep requests to view or summarize a session read-only.

Then choose the next action from the user's request: send a follow-up, cancel,
read now, answer a pending question, wait for a bounded period, check later, or
watch it so the Host notifies this Thread once when it stops or needs input.
You can also leave it running. A watch notification
reports execution state only; read the Thread before judging or reporting its
work. Only when debugging needs the full Thread, export it to a file.

For a pending question, read the Thread and follow the answer command's help.
After answering, read or watch again; submission does not prove completion.
Questions requiring the user's decision or additional authorization belong to
the user.

Report the result returned by read or a completed wait, together with the target
agent, status, and a labeled task link. Keep internal tracking IDs in tool calls.
