import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestDesktopRemoteConnections } from "@codexhost/desktop-control";
import {
  codexSshConnectionSchema,
  type CodexSshConnection,
  type CodeRepository,
  type RepositoryJob,
  type RepositoryTarget,
} from "@codexhost/shared-contracts";
import { z } from "zod";
import type { RepositoryCredentials } from "./code-repository-credentials.js";
import {
  RepositoryError,
  runRepositoryCommand,
  type RepositoryCommand,
  type RepositoryCommandOptions,
} from "./code-repository-process.js";

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
export function repositoryClonePath(parent: string, name: string): string {
  if (
    !path.posix.isAbsolute(parent) ||
    parent.includes("\0") ||
    !/^[\w.-]+$/u.test(name) ||
    name === "." ||
    name === ".."
  )
    throw new RepositoryError("invalid_path");
  return path.posix.join(parent, name);
}
const TARGET_SCRIPT = `import os,json,sys
p=sys.argv[1] or os.path.expanduser('~/projects')
if not sys.argv[1]: os.makedirs(p,exist_ok=True)
print(json.dumps({'parent':os.path.abspath(p),'children':[os.path.join(p,n) for n in sorted(os.listdir(p)) if os.path.isdir(os.path.join(p,n))][:500]}))`;
const EXISTS_SCRIPT = `import os,sys
print('exists' if os.path.lexists(sys.argv[1]) else 'absent')`;
// The archive is generated from a local checkout, not supplied by the Renderer.
const RECEIVE_SCRIPT = `import os,sys,subprocess,shutil
p=sys.argv[1]
try: os.mkdir(p)
except FileExistsError: sys.stderr.write('TARGET_EXISTS');sys.exit(1)
ok=False
try:
 r=subprocess.run(['tar','--no-same-owner','-xzf','-','-C',p],stdin=sys.stdin.buffer,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if r.returncode: sys.exit(1)
 ok=True
finally:
 if not ok: shutil.rmtree(p)
`;

export class RepositoryCloner {
  constructor(
    private readonly credentials: RepositoryCredentials,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly run: RepositoryCommand = runRepositoryCommand,
    private readonly findConnection: (
      hostId: string,
    ) => Promise<CodexSshConnection | undefined> = async (hostId) => {
      const reply = await requestDesktopRemoteConnections(environment, { action: "list" });
      if ("error" in reply) throw new RepositoryError("connection_failed");
      return z
        .array(codexSshConnectionSchema)
        .parse(reply.result)
        .find((connection) => connection.hostId === hostId);
    },
  ) {}
  async #remote(
    hostId: string,
    script: string,
    argument: string,
    options: RepositoryCommandOptions = {},
  ): Promise<string> {
    const connection = await this.findConnection(hostId);
    const destination = connection?.sshAlias || connection?.sshHost;
    if (!connection || !destination || destination.startsWith("-") || /[\s\0]/u.test(destination))
      throw new RepositoryError("unknown_host");
    return this.run(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        ...(connection.sshPort ? ["-p", String(connection.sshPort)] : []),
        ...(connection.identity ? ["-i", connection.identity] : []),
        "--",
        destination,
        ["python3", "-c", script, argument].map(quote).join(" "),
      ],
      { ...options, env: this.environment },
    );
  }
  async target(hostId: string, parent?: string): Promise<RepositoryTarget> {
    if (hostId !== "local") {
      if (parent && !path.posix.isAbsolute(parent)) throw new RepositoryError("invalid_path");
      try {
        return JSON.parse(
          await this.#remote(hostId, TARGET_SCRIPT, parent ?? ""),
        ) as RepositoryTarget;
      } catch (error) {
        throw error instanceof RepositoryError ? error : new RepositoryError("connection_failed");
      }
    }
    const folder = parent ?? path.join(this.environment.HOME || os.homedir(), "Downloads");
    if (!path.isAbsolute(folder)) throw new RepositoryError("invalid_path");
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    return {
      parent: folder,
      children: entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(folder, e.name))
        .slice(0, 500),
    };
  }
  async exists(hostId: string, target: string): Promise<boolean> {
    if (hostId !== "local")
      return (await this.#remote(hostId, EXISTS_SCRIPT, target)).trim() === "exists";
    try {
      await lstat(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new RepositoryError("invalid_path");
    }
  }
  async clone(
    repository: CodeRepository,
    hostId: string,
    target: string,
    progress: (state: RepositoryJob["state"]) => void,
  ): Promise<void> {
    // Preflight precedes git, temporary directories, and writes to the destination.
    if (await this.exists(hostId, target)) throw new RepositoryError("target_exists");
    const temporary = await mkdtemp(path.join(os.tmpdir(), "codexhost-repository-"));
    const checkout = path.join(temporary, "checkout");
    const env = { ...this.environment, GIT_TERMINAL_PROMPT: "0" };
    try {
      const args = ["-c", "credential.helper="];
      if (repository.provider === "gitlab") {
        const token = await this.credentials.token();
        if (!token) throw new RepositoryError("missing_token");
        const askpass = path.join(temporary, "askpass");
        await writeFile(
          askpass,
          '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" oauth2;; *) printf "%s\\n" "$CODEXHOST_GITLAB_TOKEN";; esac\n',
          { mode: 0o700 },
        );
        Object.assign(env, { GIT_ASKPASS: askpass, CODEXHOST_GITLAB_TOKEN: token });
      } else args.push("-c", "credential.helper=!/opt/homebrew/bin/gh auth git-credential");
      progress("cloning");
      await this.run("git", [...args, "clone", "--", repository.cloneUrl, checkout], {
        env,
        timeoutMs: 10 * 60_000,
      });
      if (hostId === "local") {
        let created = false;
        try {
          await mkdir(target);
          created = true;
          for (const entry of await readdir(checkout))
            await cp(path.join(checkout, entry), path.join(target, entry), {
              recursive: true,
              force: false,
              errorOnExist: true,
              verbatimSymlinks: true,
            });
        } catch (error) {
          if (created) await rm(target, { recursive: true, force: true });
          throw new RepositoryError(
            (error as NodeJS.ErrnoException).code === "EEXIST" ? "target_exists" : "clone_failed",
          );
        }
      } else {
        progress("transferring");
        const archive = path.join(temporary, "repository.tar.gz");
        await this.run("tar", ["-czf", archive, "-C", checkout, "."], {
          env: this.environment,
          timeoutMs: 10 * 60_000,
        });
        await this.#remote(hostId, RECEIVE_SCRIPT, target, {
          inputFile: archive,
          timeoutMs: 10 * 60_000,
        });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
