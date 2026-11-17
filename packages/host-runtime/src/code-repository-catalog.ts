import {
  codeRepositorySchema,
  type CodeRepository,
  type RepositoryProvider,
} from "@codexhost/shared-contracts";
import type { RepositoryCredentials } from "./code-repository-credentials.js";
import {
  RepositoryError,
  runRepositoryCommand,
  type RepositoryCommand,
} from "./code-repository-process.js";

export const GITLAB_ORIGIN = "https://gitlab.xianghuanji.com";
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const text = (value: unknown, max = 2048) => (typeof value === "string" ? value.slice(0, max) : "");

export function parseRepositoryList(
  provider: RepositoryProvider,
  value: unknown,
): CodeRepository[] {
  if (!Array.isArray(value)) throw new RepositoryError("invalid_response");
  return value.slice(0, 20).map((item) => {
    if (!record(item)) throw new RepositoryError("invalid_response");
    if (
      (typeof item.id !== "number" && typeof item.id !== "string") ||
      !/^\d+$/u.test(String(item.id))
    )
      throw new RepositoryError("invalid_response");
    const url = new URL(text(provider === "github" ? item.clone_url : item.http_url_to_repo));
    if (
      url.origin !== (provider === "github" ? "https://github.com" : GITLAB_ORIGIN) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new RepositoryError("invalid_response");
    const fullName = text(provider === "github" ? item.full_name : item.path_with_namespace, 1024);
    const name = fullName.split("/").at(-1) ?? "";
    if (!/^[\w.-]+$/u.test(name) || name === "." || name === "..")
      throw new RepositoryError("invalid_response");
    return codeRepositorySchema.parse({
      id: String(item.id),
      provider,
      name,
      namespace: fullName.slice(0, -(name.length + 1)),
      description: text(item.description),
      lastActivity: text(provider === "github" ? item.pushed_at : item.last_activity_at),
      cloneUrl: url.href,
    });
  });
}

export class RepositoryCatalog {
  constructor(
    readonly credentials: RepositoryCredentials,
    private readonly run: RepositoryCommand = runRepositoryCommand,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}
  async githubLogin(): Promise<string | null> {
    try {
      const login = (
        await this.run("/opt/homebrew/bin/gh", ["api", "user", "--jq", ".login"], {
          env: this.environment,
        })
      ).trim();
      return /^[\w-]+$/u.test(login) ? login : null;
    } catch {
      return null;
    }
  }
  async gitlab(path: string): Promise<unknown> {
    const token = await this.credentials.token();
    if (!token) throw new RepositoryError("missing_token");
    try {
      const response = await this.fetchImpl(`${GITLAB_ORIGIN}/api/v4/${path}`, {
        headers: { "PRIVATE-TOKEN": token },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 401 || response.status === 403)
        throw new RepositoryError("unauthorized");
      if (!response.ok) throw new RepositoryError("connection_failed");
      return await response.json();
    } catch (error) {
      throw error instanceof RepositoryError ? error : new RepositoryError("connection_failed");
    }
  }
  async list(provider: RepositoryProvider, search: string): Promise<CodeRepository[]> {
    if (provider === "gitlab")
      return parseRepositoryList(
        provider,
        await this.gitlab(
          `projects?${new URLSearchParams({ membership: "true", order_by: "last_activity_at", sort: "desc", per_page: "20", search })}`,
        ),
      );
    const login = await this.githubLogin();
    if (!login) throw new RepositoryError("github_not_logged_in");
    const endpoint = search
      ? `search/repositories?${new URLSearchParams({ q: `${JSON.stringify(search)} user:${login}`, sort: "updated", order: "desc", per_page: "20" })}`
      : "user/repos?affiliation=owner&sort=pushed&direction=desc&per_page=20";
    let raw: unknown;
    try {
      raw = JSON.parse(
        await this.run("/opt/homebrew/bin/gh", ["api", endpoint], { env: this.environment }),
      );
    } catch (error) {
      throw error instanceof RepositoryError ? error : new RepositoryError("invalid_response");
    }
    return parseRepositoryList(provider, search && record(raw) ? raw.items : raw);
  }
}
