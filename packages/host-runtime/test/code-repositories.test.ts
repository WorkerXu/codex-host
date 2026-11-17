import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodeRepository } from "@codexhost/shared-contracts";
import { RepositoryCatalog, parseRepositoryList } from "../src/code-repository-catalog.js";
import { RepositoryCredentials } from "../src/code-repository-credentials.js";
import { RepositoryCloner, repositoryClonePath } from "../src/code-repository-clone.js";
import { runRepositoryCommand, type RepositoryCommand } from "../src/code-repository-process.js";
import { CodeRepositories } from "../src/code-repositories.js";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}
const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "repository-test-"));
  roots.push(root);
  const env = { HOME: root, CODEXHOST_USER_DIR: path.join(root, "host") };
  return { root, env, credentials: new RepositoryCredentials(env) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const github = {
  id: 1,
  name: "demo",
  full_name: "owner/demo",
  description: "A project",
  pushed_at: "2026-11-17T01:00:00Z",
  clone_url: "https://github.com/owner/demo.git",
};
const gitlab = {
  id: 2,
  path_with_namespace: "team/demo",
  description: null,
  last_activity_at: "2026-11-17T02:00:00Z",
  http_url_to_repo: "https://gitlab.xianghuanji.com/team/demo.git",
};
const repo: CodeRepository = required(parseRepositoryList("github", [github])[0]);

describe("code repository catalog and credentials", () => {
  it("parses first-page Github and GitLab fields and rejects credential-bearing clone URLs", () => {
    expect(parseRepositoryList("github", [github])).toEqual([
      {
        id: "1",
        provider: "github",
        name: "demo",
        namespace: "owner",
        description: "A project",
        lastActivity: github.pushed_at,
        cloneUrl: github.clone_url,
      },
    ]);
    expect(parseRepositoryList("gitlab", [gitlab])[0]).toMatchObject({
      id: "2",
      namespace: "team",
      description: "",
      name: "demo",
    });
    expect(() =>
      parseRepositoryList("github", [
        { ...github, clone_url: "https://user:secret@github.com/owner/demo.git" },
      ]),
    ).toThrow();
    expect(() =>
      parseRepositoryList("gitlab", [
        { ...gitlab, http_url_to_repo: "https://other.invalid/team/demo.git" },
      ]),
    ).toThrow();
    expect(() => parseRepositoryList("github", [{ ...github, full_name: "owner/.." }])).toThrow();
    expect(() => parseRepositoryList("github", [{ ...github, id: undefined }])).toThrow();
    expect(parseRepositoryList("github", Array(30).fill(github))).toHaveLength(20);
  });
  it("stores a private token with 0600 permissions and returns only a suffix", async () => {
    const { credentials } = await setup();
    const token = "synthetic-credential-1234";
    expect(await credentials.state()).toEqual({ configured: false, lastFour: null });
    expect(await credentials.update(token)).toEqual({ configured: true, lastFour: "1234" });
    expect((await stat(credentials.file)).mode & 0o777).toBe(0o600);
    expect(await credentials.token()).toBe(token);
    await credentials.update(null);
    expect(await credentials.token()).toBeNull();
  });
  it("runs GitHub listing and scoped search through the Mac gh executable", async () => {
    const { credentials, env } = await setup();
    const run = vi.fn<RepositoryCommand>(async (_cmd, args) =>
      args[1] === "user"
        ? "WorkerXu"
        : required(args[1]).startsWith("search/")
          ? JSON.stringify({ items: [github] })
          : JSON.stringify([github]),
    );
    const catalog = new RepositoryCatalog(credentials, run, fetch, env);
    await catalog.list("github", "");
    await catalog.list("github", "demo");
    expect(run.mock.calls.every(([command]) => command === "/opt/homebrew/bin/gh")).toBe(true);
    expect(run.mock.calls[1]?.[1]).toEqual([
      "api",
      "user/repos?affiliation=owner&sort=pushed&direction=desc&per_page=20",
    ]);
    const search = new URL(
      required(required(run.mock.calls.at(-1))[1][1]),
      "https://api.github.com/",
    );
    expect(search.searchParams.get("q")).toBe('"demo" user:WorkerXu');
    expect(search.searchParams.get("per_page")).toBe("20");
  });
  it("uses membership and activity order for GitLab server-side search without leaking credentials", async () => {
    const { credentials, env } = await setup();
    await credentials.update("synthetic-credential-1234");
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json([gitlab]));
    const catalog = new RepositoryCatalog(credentials, vi.fn(), fetchImpl, env);
    const result = await catalog.list("gitlab", "name & group");
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.origin).toBe("https://gitlab.xianghuanji.com");
    expect(url.searchParams.get("membership")).toBe("true");
    expect(url.searchParams.get("order_by")).toBe("last_activity_at");
    expect(url.searchParams.get("search")).toBe("name & group");
    expect(JSON.stringify(result)).not.toContain(await credentials.token());
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("maps missing tokens, unauthorized and raw fetch errors to fixed error codes", async () => {
    const { credentials } = await setup();
    const fetchImpl = vi.fn<typeof fetch>();
    const catalog = new RepositoryCatalog(credentials, vi.fn(), fetchImpl);
    await expect(catalog.list("gitlab", "")).rejects.toThrow("missing_token");
    expect(fetchImpl).not.toHaveBeenCalled();
    await credentials.update("synthetic-credential-1234");
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(catalog.list("gitlab", "")).rejects.toThrow("unauthorized");
    fetchImpl.mockRejectedValueOnce(new Error("sensitive server response"));
    await expect(catalog.list("gitlab", "")).rejects.toThrow(/^connection_failed$/);
  });
});

describe("clone plans, refusal and transfer", () => {
  it("copies a real isolated Git checkout with its history and original origin", async () => {
    const { root, credentials } = await setup();
    const source = path.join(root, "source");
    await mkdir(source);
    await runRepositoryCommand("git", ["init", source]);
    await writeFile(path.join(source, "README.md"), "isolated fixture\n");
    await runRepositoryCommand("git", ["-C", source, "add", "README.md"]);
    await runRepositoryCommand("git", [
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    const origin = `file://${source}`;
    const target = path.join(root, "destination");
    await new RepositoryCloner(credentials).clone(
      { ...repo, cloneUrl: origin },
      "local",
      target,
      vi.fn(),
    );
    expect(
      (await runRepositoryCommand("git", ["-C", target, "remote", "get-url", "origin"])).trim(),
    ).toBe(origin);
    expect(await runRepositoryCommand("git", ["-C", target, "log", "--oneline"])).toContain(
      "fixture",
    );
    expect(await readFile(path.join(target, "README.md"), "utf8")).toBe("isolated fixture\n");
    expect(await readFile(path.join(target, ".git", "config"), "utf8")).not.toContain(
      "credential.helper",
    );
  });
  it("builds an absolute destination and refuses parent traversal names", () => {
    expect(repositoryClonePath("/Users/lin/Downloads", "demo")).toBe("/Users/lin/Downloads/demo");
    expect(repositoryClonePath("/home/lin/projects", "demo")).toBe("/home/lin/projects/demo");
    for (const name of ["..", ".", "../demo", "/demo", "-bad/repo"])
      expect(() => repositoryClonePath("/tmp", name)).toThrow();
    expect(() => repositoryClonePath("relative", "demo")).toThrow();
  });
  it("refuses an existing local directory before running git or touching its contents", async () => {
    const { root, credentials, env } = await setup();
    const target = path.join(root, "demo");
    await mkdir(target);
    await writeFile(path.join(target, "keep"), "unchanged");
    const run = vi.fn<RepositoryCommand>();
    const cloner = new RepositoryCloner(credentials, env, run);
    await expect(cloner.clone(repo, "local", target, vi.fn())).rejects.toThrow("target_exists");
    expect(run).not.toHaveBeenCalled();
    expect(await readFile(path.join(target, "keep"), "utf8")).toBe("unchanged");
  });
  it("clones on Mac, keeps .git and origin, and uses gh without storing credentials", async () => {
    const { root, credentials, env } = await setup();
    let temporary = "";
    const run = vi.fn<RepositoryCommand>(async (command, args) => {
      expect(command).toBe("git");
      temporary = path.dirname(required(args.at(-1)));
      await mkdir(path.join(required(args.at(-1)), ".git"), { recursive: true });
      await writeFile(path.join(required(args.at(-1)), ".git", "config"), repo.cloneUrl);
      return "";
    });
    const cloner = new RepositoryCloner(credentials, env, run);
    const target = path.join(root, "demo");
    await cloner.clone(repo, "local", target, vi.fn());
    expect(await readFile(path.join(target, ".git", "config"), "utf8")).toBe(repo.cloneUrl);
    expect(run.mock.calls[0]?.[1]).toContain(
      "credential.helper=!/opt/homebrew/bin/gh auth git-credential",
    );
    await expect(stat(temporary)).rejects.toThrow();
  });
  it("passes GitLab credentials through one-shot askpass environment only and cleans temporary files", async () => {
    const { root, credentials, env } = await setup();
    const token = "synthetic-credential-1234";
    await credentials.update(token);
    let helper = "";
    const run = vi.fn<RepositoryCommand>(async (_command, args, options) => {
      expect(JSON.stringify(args)).not.toContain(token);
      expect(options?.env?.CODEXHOST_GITLAB_TOKEN).toBe(token);
      helper = required(options?.env?.GIT_ASKPASS);
      expect(await readFile(helper, "utf8")).not.toContain(token);
      expect((await stat(helper)).mode & 0o777).toBe(0o700);
      const checkout = required(args.at(-1));
      await mkdir(path.join(checkout, ".git"), { recursive: true });
      await writeFile(path.join(checkout, ".git", "config"), gitlab.http_url_to_repo);
      return "";
    });
    const cloner = new RepositoryCloner(credentials, env, run);
    const target = path.join(root, "demo");
    await cloner.clone(
      required(parseRepositoryList("gitlab", [gitlab])[0]),
      "local",
      target,
      vi.fn(),
    );
    expect(await readFile(path.join(target, ".git", "config"), "utf8")).not.toContain(token);
    await expect(stat(helper)).rejects.toThrow();
  });
  it("uses the configured SSH peer for preflight and archive transfer, with progress and no forwarded credential", async () => {
    const { root, credentials, env } = await setup();
    await mkdir(env.CODEXHOST_USER_DIR, { recursive: true });
    await writeFile(
      path.join(env.CODEXHOST_USER_DIR, "peers.json"),
      JSON.stringify({
        formatVersion: 1,
        peers: { server: { ssh: "existing-alias", hostIds: ["remote-host"] } },
      }),
    );
    let archive = "";
    const run = vi.fn<RepositoryCommand>(async (command, args, options) => {
      if (command === "ssh") {
        expect(args).toContain("existing-alias");
        expect(options?.env?.CODEXHOST_GITLAB_TOKEN).toBeUndefined();
        if (!options?.inputFile) return "absent\n";
        archive = options.inputFile;
        expect(await readFile(archive, "utf8")).toBe("archive");
        return "";
      }
      if (command === "git") {
        await mkdir(required(args.at(-1)), { recursive: true });
        return "";
      }
      if (command === "tar") {
        await writeFile(required(args[1]), "archive");
        return "";
      }
      throw new Error("unexpected command");
    });
    const cloner = new RepositoryCloner(credentials, env, run),
      progress = vi.fn();
    await cloner.clone(repo, "remote-host", "/home/user/projects/demo", progress);
    expect(progress.mock.calls.map(([state]) => state)).toEqual(["cloning", "transferring"]);
    expect(run.mock.calls.map(([cmd]) => cmd)).toEqual(["ssh", "git", "tar", "ssh"]);
    await expect(stat(archive)).rejects.toThrow();
    expect(await readdir(root)).toEqual(["host"]);
  });
  it("rejects renderer-supplied repositories that were never listed, and returns a conflict before starting work", async () => {
    const { credentials } = await setup();
    const catalog = new RepositoryCatalog(credentials, async (_command, args) =>
      args[1] === "user" ? "WorkerXu" : JSON.stringify([github]),
    );
    const cloner = {
      exists: vi.fn(async () => true),
      clone: vi.fn(),
    } as unknown as RepositoryCloner;
    const service = new CodeRepositories({ catalog, cloner });
    const input = { provider: "github", repositoryId: "1", hostId: "local", parent: "/Downloads" };
    await expect(service.request("codexhost/code-repositories/clone", input)).rejects.toThrow(
      "refresh_list",
    );
    await service.request("codexhost/code-repositories/list", { provider: "github" });
    expect(await service.request("codexhost/code-repositories/clone", input)).toMatchObject({
      state: "conflict",
      path: "/Downloads/demo",
    });
    expect(cloner.clone).not.toHaveBeenCalled();
  });
  it("does not serialize raw process errors into job results", async () => {
    const { credentials } = await setup();
    const catalog = new RepositoryCatalog(credentials, async (_command, args) =>
      args[1] === "user" ? "WorkerXu" : JSON.stringify([github]),
    );
    const cloner = {
      exists: async () => false,
      clone: async () => {
        throw new Error("private credential response");
      },
    } as unknown as RepositoryCloner;
    const service = new CodeRepositories({ catalog, cloner });
    await service.request("codexhost/code-repositories/list", { provider: "github" });
    const job = (await service.request("codexhost/code-repositories/clone", {
      provider: "github",
      repositoryId: "1",
      hostId: "local",
      parent: "/Downloads",
    })) as { id: string };
    await vi.waitFor(async () =>
      expect(
        await service.request("codexhost/code-repositories/job", { id: job.id }),
      ).toMatchObject({ state: "error", errorCode: "clone_failed" }),
    );
    expect(
      JSON.stringify(await service.request("codexhost/code-repositories/job", { id: job.id })),
    ).not.toContain("private credential response");
  });
});
