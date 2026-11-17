import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Explicit live check: creates only an ephemeral Codex Thread and two disposable cache roots. */
export async function probeRemoteThreadFolders(
  host: string,
  cli = "codex",
  timeoutMs = 180_000,
): Promise<{ host: string; roots: string[]; threadId: string; secondRootWritable: true }> {
  if (!host || host.startsWith("-")) throw new Error("An SSH host alias is required");
  const marker = randomUUID();
  const remote = async (command: string) =>
    execute("ssh", ["--", host, command], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  const home = (await remote('printf "%s" "$HOME"')).stdout.trim();
  if (!home.startsWith("/") || home === "/")
    throw new Error("This probe requires a POSIX SSH host with a home directory");
  const base = `${home}/.cache/codexhost-folder-probe-${randomUUID()}`;
  const roots = [`${base}/main`, `${base}/extra`];
  await remote(`mkdir -p -- ${roots.map(quote).join(" ")}`);
  const child = spawn("ssh", ["--", host, `${quote(cli)} app-server`], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let sequence = 0;
  let threadId = "";
  let turnId = "";
  const terminal = Promise.withResolvers<undefined>();
  // A startup error may precede the point where the caller starts awaiting this promise.
  void terminal.promise.catch(() => undefined);
  const rejectAll = (error: Error) => {
    pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(error);
    });
    pending.clear();
    terminal.reject(error);
  };
  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (!record(value)) return;
      if (typeof value.id === "number") {
        const entry = pending.get(value.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(value.id);
        if (value.error) entry.reject(new Error(JSON.stringify(value.error)));
        else entry.resolve(value.result);
      } else if (
        value.method === "turn/completed" &&
        record(value.params) &&
        value.params.threadId === threadId &&
        record(value.params.turn)
      ) {
        const turn = value.params.turn;
        if (turnId && turn.id !== turnId) return;
        if (turn.status === "completed") terminal.resolve(undefined);
        else terminal.reject(new Error(`Turn ended with ${String(turn.status)}`));
      } else if ("id" in value && typeof value.method === "string") {
        child.stdin.write(
          `${JSON.stringify({ id: value.id, error: { code: -32601, message: "Manual folder probe does not approve requests" } })}\n`,
        );
      }
    } catch (error) {
      rejectAll(error instanceof Error ? error : new Error(String(error)));
    }
  });
  // Drain diagnostics without exposing authentication or configuration contents.
  child.stderr.resume();
  child.once("error", rejectAll);
  child.stdin.on("error", rejectAll);
  child.once("exit", () => rejectAll(new Error("Remote app-server exited")));
  let terminalTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await request("initialize", {
      clientInfo: { name: "codexhost-folder-probe", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const started = await request("thread/start", {
      cwd: roots[0],
      runtimeWorkspaceRoots: roots,
      projectId: null,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    if (!record(started) || !record(started.thread) || typeof started.thread.id !== "string")
      throw new Error("No ephemeral Thread identity was returned");
    threadId = started.thread.id;
    const sandbox = record(started.sandbox) ? started.sandbox : null;
    if (
      !sandbox ||
      sandbox.type !== "workspaceWrite" ||
      !Array.isArray(sandbox.writableRoots) ||
      !sandbox.writableRoots.includes(roots[1])
    )
      throw new Error("thread/start did not expose the second root as sandbox-writable");
    const turn = await request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: `Write exactly ${marker} to ${roots[1]}/marker.txt using a shell command. Do not write any other files. Then reply done.`,
        },
      ],
    });
    if (!record(turn) || !record(turn.turn) || typeof turn.turn.id !== "string")
      throw new Error("No Turn identity was returned");
    turnId = turn.turn.id;
    terminalTimeout = setTimeout(
      () => terminal.reject(new Error("Remote write verification timed out")),
      timeoutMs,
    );
    await terminal.promise;
    const result = await remote(`cat -- ${quote(`${roots[1]}/marker.txt`)}`);
    if (result.stdout.trim() !== marker)
      throw new Error("The second root does not contain the expected marker");
    return { host, roots, threadId, secondRootWritable: true };
  } finally {
    if (terminalTimeout) clearTimeout(terminalTimeout);
    if (threadId && turnId)
      child.stdin.write(
        `${JSON.stringify({ id: ++sequence, method: "turn/interrupt", params: { threadId, turnId } })}\n`,
      );
    child.stdin.end();
    child.kill("SIGTERM");
    lines.close();
    rejectAll(new Error("Probe closed"));
    await remote(`rm -rf -- ${quote(base)}`);
  }
}
