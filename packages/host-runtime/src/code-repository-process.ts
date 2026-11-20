import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";

export class RepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface RepositoryCommandOptions {
  env?: NodeJS.ProcessEnv;
  inputFile?: string;
  timeoutMs?: number;
}
export type RepositoryCommand = (
  command: string,
  args: string[],
  options?: RepositoryCommandOptions,
) => Promise<string>;

/** Command output is private; only bounded results or classified error codes leave this layer. */
export const runRepositoryCommand: RepositoryCommand = async (command, args, options = {}) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      errors = "",
      settled = false;
    const finish = (code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source?.destroy();
      if (code) {
        child.kill("SIGKILL");
        reject(new RepositoryError(code));
      } else resolve(output);
    };
    const timer = setTimeout(() => finish("timeout"), options.timeoutMs ?? 30_000);
    const source = options.inputFile ? createReadStream(options.inputFile) : null;
    if (source) {
      source.on("error", () => finish("transfer_failed"));
      source.pipe(child.stdin);
    } else child.stdin.end();
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 4 * 1024 * 1024) finish("invalid_response");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errors.length < 64 * 1024) errors += chunk.toString();
    });
    child.on("error", () => finish("connection_failed"));
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : /TARGET_EXISTS/u.test(errors)
            ? "target_exists"
            : /Authentication failed|could not read Username|not found|403|401|denied/iu.test(
                  errors,
                )
              ? "unauthorized"
              : "connection_failed",
      ),
    );
  });
