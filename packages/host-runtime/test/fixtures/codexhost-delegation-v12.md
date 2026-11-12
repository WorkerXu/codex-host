---
name: codexhost-delegation
version: 12
description: >
  Delegate tasks to other coding agents, or read and follow up on existing
  external agent sessions. Use when the user asks another agent (including
  @agent) to independently perform a task, or asks to view a specified external
  session's content, progress, or results, send follow-up messages, wait, or
  cancel a task. Not for recapping the current conversation, discussing or
  configuring agents, or role-playing.
---

# Execute the task

Run the CLI through the executable in CODEXHOST_CLI_PATH. Before acting, run
help with the form for your shell:

- POSIX: \`"$CODEXHOST_CLI_PATH" delegate --help\`
- PowerShell: \`& $env:CODEXHOST_CLI_PATH delegate --help\`
- cmd: \`"%CODEXHOST_CLI_PATH%" delegate --help\`

If CODEXHOST_CLI_PATH is unset, try \`codexhost\`; if that also fails, tell the
user to add CODEXHOST_CLI_PATH to shell_environment_policy.include_only.
Commands shown by help and in \`next\` begin with \`codexhost\`; run them the
same way.

Use CLI help as the authoritative source for commands and behavior. Consult
command-specific help for options and the Harness listing command when the
target is unknown. Prefer compact output when supported, and use its task links
directly for subsequent commands.

## Cross-machine targets

Run \`codexhost peer list\` to see configured machines and their Host IDs. Pass
\`--host <peer>\` to \`delegate start\`, \`harness list|inspect\`, and
\`thread read|send|cancel|wait\` to operate on that machine. A task link with a
\`hostId\` carries the machine; reuse the link for follow-up commands so routing
is automatic. Use \`thread wait <thread> --host <peer>\` for a bounded wait.

\`delegate start --host <peer> --watch true\` and
\`thread watch <thread> --host <peer>\` register a watch on this machine. The
Host notifies this Thread once with \`[codexhost thread watch]\` when the remote
Thread stops. \`thread watches\` lists local and cross-machine watches;
\`thread watch <thread> --host <peer> --cancel\` removes one. Cross-machine
watches live in memory and are lost when the Host Runtime restarts.

Never read files under \`~/.codexhost/runtime/\`; they contain the Runtime
token. Use the CLI instead.

Use the Harness native defaults. Inspect the target when a Model or Thinking
selection is needed or the default is unavailable.

For a new delegation, create an independent child session and submit the
requested task. Give it a short task name that tells it apart from sibling
tasks, using the help's task-name option. For an existing external session, resolve the target from the
user-provided session link, identifier, or context and operate on that Thread
directly; it need not have been created by the current assistant. If the target
is ambiguous, ask the user to identify it. Keep requests to view or summarize a
session read-only.

For a new or existing task, choose the appropriate next action based on the
user’s request and the task:

- send a follow-up message to the same Thread;
- cancel its current Turn;
- read its current state immediately;
- wait for a bounded period;
- check it again later;
- watch it, so the Host notifies this Thread once when the watched Thread stops
  and no waiting or polling is needed meanwhile;
- leave it running in the background.

A watch notification reports execution state only. Read the Thread before
judging or reporting its work.

Report the result returned by read or a completed wait, together with the target
agent, status, and a labeled task link. Keep internal tracking IDs in tool calls.
