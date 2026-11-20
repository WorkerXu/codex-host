import { randomUUID } from "node:crypto";
import {
  CODE_REPOSITORIES_PREFIX,
  repositoryCloneParamsSchema,
  repositoryListParamsSchema,
  repositoryTargetParamsSchema,
  repositoryTokenParamsSchema,
  type CodeRepository,
  type RepositoryJob,
} from "@codexhost/shared-contracts";
import { RepositoryCredentials } from "./code-repository-credentials.js";
import { RepositoryCatalog } from "./code-repository-catalog.js";
import { RepositoryCloner, repositoryClonePath } from "./code-repository-clone.js";
import { RepositoryError } from "./code-repository-process.js";

/** Desktop-local service. Remote Hosts never receive the repository credentials or catalog traffic. */
export class CodeRepositories {
  readonly #catalog: RepositoryCatalog;
  readonly #cloner: RepositoryCloner;
  readonly #credentials: RepositoryCredentials;
  readonly #listed = new Map<string, CodeRepository>();
  readonly #jobs = new Map<string, RepositoryJob>();
  constructor(
    options: {
      environment?: NodeJS.ProcessEnv;
      catalog?: RepositoryCatalog;
      cloner?: RepositoryCloner;
    } = {},
  ) {
    this.#credentials =
      options.catalog?.credentials ?? new RepositoryCredentials(options.environment);
    this.#catalog =
      options.catalog ??
      new RepositoryCatalog(this.#credentials, undefined, undefined, options.environment);
    this.#cloner = options.cloner ?? new RepositoryCloner(this.#credentials, options.environment);
  }
  async request(method: string, params: unknown): Promise<unknown> {
    switch (method.slice(CODE_REPOSITORIES_PREFIX.length)) {
      case "settings":
        return this.#settings();
      case "set-token":
        await this.#credentials.update(repositoryTokenParamsSchema.parse(params).token);
        return this.#settings();
      case "test":
        try {
          await this.#catalog.gitlab("user");
          return { ok: true, errorCode: null };
        } catch (error) {
          return {
            ok: false,
            errorCode: error instanceof RepositoryError ? error.code : "connection_failed",
          };
        }
      case "list": {
        const { provider, search } = repositoryListParamsSchema.parse(params);
        const repos = await this.#catalog.list(provider, search);
        for (const repo of repos) this.#listed.set(`${provider}:${repo.id}`, repo);
        if (this.#listed.size > 500) {
          this.#listed.clear();
          for (const repo of repos) this.#listed.set(`${provider}:${repo.id}`, repo);
        }
        return repos;
      }
      case "target": {
        const input = repositoryTargetParamsSchema.parse(params);
        return this.#cloner.target(input.hostId, input.parent);
      }
      case "clone": {
        if (
          [...this.#jobs.values()].some(
            (job) => job.state === "cloning" || job.state === "transferring",
          )
        )
          throw new RepositoryError("busy");
        const input = repositoryCloneParamsSchema.parse(params);
        const repository = this.#listed.get(`${input.provider}:${input.repositoryId}`);
        if (!repository) throw new RepositoryError("refresh_list");
        const target = repositoryClonePath(input.parent, repository.name);
        const job: RepositoryJob = {
          id: randomUUID(),
          state: "cloning",
          path: target,
          errorCode: null,
        };
        this.#jobs.set(job.id, job);
        try {
          if (await this.#cloner.exists(input.hostId, target)) {
            this.#jobs.delete(job.id);
            return { ...job, state: "conflict" };
          }
        } catch (error) {
          this.#jobs.delete(job.id);
          throw error;
        }
        if (this.#jobs.size > 100) {
          const oldest = this.#jobs.keys().next().value;
          if (oldest) this.#jobs.delete(oldest);
        }
        void this.#cloner
          .clone(repository, input.hostId, target, (state) => {
            job.state = state;
          })
          .then(() => {
            job.state = "complete";
          })
          .catch((error: unknown) => {
            job.state =
              error instanceof RepositoryError && error.code === "target_exists"
                ? "conflict"
                : "error";
            job.errorCode = error instanceof RepositoryError ? error.code : "clone_failed";
          });
        return { ...job };
      }
      case "job": {
        const id =
          typeof params === "object" && params !== null && "id" in params ? params.id : null;
        const job = typeof id === "string" ? this.#jobs.get(id) : null;
        if (!job) throw new RepositoryError("missing_job");
        return { ...job };
      }
      default:
        throw new RepositoryError("unknown_method");
    }
  }
  async #settings() {
    const [gitlab, login] = await Promise.all([
      this.#credentials.state(),
      this.#catalog.githubLogin(),
    ]);
    return { gitlab, github: { login } };
  }
}
