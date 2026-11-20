/**
 * Structured Jarvis bug search behind the `@` entry.
 *
 * Two entry shapes share one execution path:
 *  - the legacy whole-query search interprets the text and resolves projects;
 *  - the two-step panel fixes the project first, then interprets only the
 *    remaining conditions inside that project.
 *
 * Every bug list is read through `jarvis bug list`; the fixed-project path
 * never calls `project list`.
 */
import {
  JARVIS_MAX_SEARCH_BUGS,
  JARVIS_MAX_SEARCH_PROJECTS,
  type JarvisBug,
  type JarvisBugCondition,
  type JarvisBugQuery,
  type JarvisBugSearchParams,
  type JarvisBugSearchResult,
  type JarvisProjectBugSearchParams,
} from "@codexhost/shared-contracts";

import {
  bugFromJarvisRow,
  type JarvisBugListOptions,
  type JarvisBugPageResult,
  type JarvisProjectRow,
} from "./jarvis-cli.js";
import { JarvisQueryError, type JarvisQueryInterpreter } from "./jarvis-query-parser.js";

const PAGE_SIZE = 100;
const MAX_PAGES_PER_QUERY = 2;
const PROJECT_SEARCH_TTL_MS = 5 * 60_000;
const MAX_PROJECT_SEARCH_CACHE = 64;

export interface JarvisBugSearchCli {
  user(): Promise<{ id: number; name: string } | null>;
  projects(): Promise<JarvisProjectRow[]>;
  searchProjects(name: string): Promise<JarvisProjectRow[]>;
  bugList(projectId: number, options?: JarvisBugListOptions): Promise<JarvisBugPageResult>;
}

export interface JarvisBugSearchOptions {
  cli: JarvisBugSearchCli;
  interpreter: Pick<JarvisQueryInterpreter, "interpret">;
  isLocalHost: boolean;
  now?: () => number;
  concurrency?: number;
  projectSearchTtlMs?: number;
}

interface ProjectTokenMatch {
  token: string;
  projects: JarvisProjectRow[];
}

interface ProjectResolution {
  tokens: ProjectTokenMatch[];
  targets: Map<number, JarvisProjectRow>;
}

interface SearchPlan {
  scope: JarvisBugQuery["scope"];
  statuses: number[] | null;
  priorities: number[] | null;
  severities: number[] | null;
  order: JarvisBugQuery["order"];
  timeField: "create" | "update";
  since: number | null;
  until: number | null;
  timeLabel: string | null;
  titles: string[];
  /** Scope chip is hidden after the user removes it. */
  scopeOmitted: boolean;
  orderOmitted: boolean;
}

interface FetchOutcome {
  rows: Record<string, unknown>[];
  total: number;
  capped: boolean;
  failed: boolean;
  errorCode: string | null;
}

function uniqById(projects: readonly JarvisProjectRow[]): JarvisProjectRow[] {
  const seen = new Set<number>();
  return projects.filter((project) => {
    if (seen.has(project.id)) return false;
    seen.add(project.id);
    return true;
  });
}

function timestamp(value: string | undefined): number {
  if (!value) return 0;
  const normalized = value.replace(" ", "T");
  const parsed = Date.parse(
    /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(normalized) ? normalized : `${normalized}+08:00`,
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(1, limit - 1))}…` : value;
}

function conditionLabel(value: number, labels: Readonly<Record<number, string>>): string {
  return labels[value] ?? String(value);
}

function failedSearch(
  errorCode: string,
  source: "openai" | "gemini" | "model" = "model",
): JarvisBugSearchResult {
  return {
    available: false,
    source,
    errorCode,
    conditions: [],
    bugs: [],
    total: 0,
    capped: false,
  };
}

function timeLabel(window: JarvisBugQuery["timeWindow"]): string | null {
  if (!window) return null;
  const format = (value: number) =>
    new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(value);
  const since = window.since === null ? null : format(window.since);
  const until = window.until === null ? null : format(window.until);
  const range =
    since === null ? `早于 ${until}` : until === null ? `${since} 起` : `${since} 至 ${until}`;
  return `${window.field === "create" ? "创建" : "更新"} ${range}`;
}

export class JarvisBugSearcher {
  readonly #cli: JarvisBugSearchCli;
  readonly #interpreter: Pick<JarvisQueryInterpreter, "interpret">;
  readonly #isLocalHost: boolean;
  readonly #now: () => number;
  readonly #concurrency: number;
  readonly #projectSearchTtlMs: number;
  readonly #projectSearches = new Map<
    string,
    { projects: JarvisProjectRow[]; expiresAt: number }
  >();

  constructor(options: JarvisBugSearchOptions) {
    this.#cli = options.cli;
    this.#interpreter = options.interpreter;
    this.#isLocalHost = options.isLocalHost;
    this.#now = options.now ?? Date.now;
    this.#concurrency = options.concurrency ?? 8;
    this.#projectSearchTtlMs = options.projectSearchTtlMs ?? PROJECT_SEARCH_TTL_MS;
  }

  async search(
    params: JarvisBugSearchParams,
    signal?: AbortSignal,
  ): Promise<JarvisBugSearchResult> {
    if (!this.#isLocalHost) return failedSearch("local_only");
    let query: JarvisBugQuery;
    try {
      signal?.throwIfAborted();
      query = await this.#interpreter.interpret(params.query, this.#now(), signal);
      signal?.throwIfAborted();
    } catch (error) {
      return failedSearch(
        error instanceof JarvisQueryError ? error.code : "provider_failed",
        error instanceof JarvisQueryError ? error.provider : "model",
      );
    }
    if (query.unrecognized !== null) return failedSearch("unrecognized_query");
    const omit = new Set(params.omit ?? []);
    const [user, known] = await Promise.all([this.#cli.user(), this.#cli.projects()]).catch(
      () => [null, []] as const,
    );
    if (!user) return failedSearch("not_logged_in");
    const resolution = await this.#resolveProjects(query.projectNames, known, omit);
    if (signal?.aborted) return failedSearch("cancelled");
    const plan = this.#plan(query, omit);
    const projectNames = new Map<number, string>();
    for (const project of [...known, ...resolution.targets.values()]) {
      projectNames.set(project.id, project.name);
    }

    const targets = [...resolution.targets.values()].slice(0, JARVIS_MAX_SEARCH_PROJECTS);
    const result = await this.#execute(
      targets,
      projectNames,
      plan,
      this.#conditions(plan, resolution, omit),
      signal,
      resolution.targets.size > JARVIS_MAX_SEARCH_PROJECTS,
    );
    return result;
  }

  /**
   * The two-step panel's condition search. The project is fixed by the
   * Renderer: project names in the parse are ignored and `project list` is
   * never called.
   */
  async searchInProject(
    params: JarvisProjectBugSearchParams,
    signal?: AbortSignal,
  ): Promise<JarvisBugSearchResult> {
    if (!this.#isLocalHost) return failedSearch("local_only");
    // The assigned list does not depend on the parse. Start it alongside the
    // model so a small project is ready when the conditions arrive.
    const prefetch = this.#prefetchAssigned(params.projectId, signal);
    let query: JarvisBugQuery;
    try {
      signal?.throwIfAborted();
      query = await this.#interpreter.interpret(params.query, this.#now(), signal);
      signal?.throwIfAborted();
    } catch (error) {
      return failedSearch(
        error instanceof JarvisQueryError ? error.code : "provider_failed",
        error instanceof JarvisQueryError ? error.provider : "model",
      );
    }
    if (query.unrecognized !== null) return failedSearch("unrecognized_query");
    const omit = new Set(params.omit ?? []);
    const plan = this.#plan(query, omit);
    const project: JarvisProjectRow = { id: params.projectId, name: "" };
    return await this.#execute(
      [project],
      new Map(),
      plan,
      this.#conditions(plan, { tokens: [], targets: new Map() }, omit),
      signal,
      false,
      await prefetch,
    );
  }

  /**
   * Instant title preview for the chosen project. This is the only path that
   * runs before the model answers, so it must stay a single CLI call.
   */
  async previewTitle(
    projectId: number,
    title: string,
    signal?: AbortSignal,
  ): Promise<JarvisBugSearchResult> {
    if (!this.#isLocalHost) return failedSearch("local_only");
    if (signal?.aborted) return failedSearch("cancelled");
    const plan: SearchPlan = {
      scope: "assigned",
      statuses: null,
      priorities: null,
      severities: null,
      order: "newest",
      timeField: "update",
      since: null,
      until: null,
      timeLabel: null,
      titles: [],
      scopeOmitted: true,
      orderOmitted: true,
    };
    const outcome = await this.#fetch(projectId, false, plan, title.trim() || null);
    if (outcome.failed) return failedSearch(outcome.errorCode ?? "cli_failed");
    const bugs = this.#filterAndSort([outcome], new Map(), plan);
    return {
      available: true,
      source: "model",
      errorCode: null,
      conditions: [],
      bugs: bugs.slice(0, JARVIS_MAX_SEARCH_BUGS),
      total: Math.max(outcome.total, bugs.length),
      capped: outcome.capped || bugs.length > JARVIS_MAX_SEARCH_BUGS,
    };
  }

  /** One unfiltered assigned page; null means the real query must run. */
  async #prefetchAssigned(
    projectId: number,
    signal: AbortSignal | undefined,
  ): Promise<FetchOutcome | null> {
    if (signal?.aborted) return null;
    try {
      const result = await this.#cli.bugList(projectId, { page: 1, pageSize: PAGE_SIZE });
      if (signal?.aborted || result.errorCode) return null;
      return {
        rows: result.list,
        total: result.total,
        capped: result.total > result.list.length,
        failed: false,
        errorCode: null,
      };
    } catch {
      return null;
    }
  }

  /**
   * A complete first page is a superset of every filter the plan applies, so
   * local filtering produces the same rows without a second CLI call. Larger
   * projects fall back to the filtered, paged query.
   */
  #reusesPrefetch(outcome: FetchOutcome | null, plan: SearchPlan): outcome is FetchOutcome {
    return (
      outcome !== null &&
      !outcome.failed &&
      outcome.errorCode === null &&
      outcome.total <= outcome.rows.length &&
      plan.scope === "assigned"
    );
  }

  /** Shared execution: one or more project ids, one plan, one condition set. */
  async #execute(
    targets: readonly JarvisProjectRow[],
    projectNames: ReadonlyMap<number, string>,
    plan: SearchPlan,
    conditions: JarvisBugCondition[],
    signal: AbortSignal | undefined,
    cappedByProjects: boolean,
    prefetched: FetchOutcome | null = null,
  ): Promise<JarvisBugSearchResult> {
    const scopes: boolean[] = plan.scope === "both" ? [false, true] : [plan.scope === "created"];
    const titles = plan.titles.length > 0 ? plan.titles : [null];
    const tasks = targets.flatMap((project) =>
      scopes.flatMap((createdByMe) =>
        titles.map(
          (title) => () =>
            signal?.aborted
              ? Promise.resolve({
                  rows: [],
                  total: 0,
                  capped: false,
                  failed: true,
                  errorCode: "cancelled",
                })
              : this.#fetch(project.id, createdByMe, plan, title),
        ),
      ),
    );
    let outcomes: FetchOutcome[];
    if (targets.length === 1 && !signal?.aborted && this.#reusesPrefetch(prefetched, plan)) {
      outcomes = [prefetched];
    } else {
      outcomes = await mapWithConcurrency(tasks, this.#concurrency, (task) => task());
    }
    const failed = outcomes.length > 0 && outcomes.every((outcome) => outcome.failed);
    const cappedByFetch = outcomes.some((outcome) => outcome.capped);

    const bugs = this.#filterAndSort(outcomes, projectNames, plan);
    const capped = cappedByFetch || bugs.length > JARVIS_MAX_SEARCH_BUGS || cappedByProjects;
    const serverTotal = outcomes.reduce((sum, outcome) => sum + outcome.total, 0);
    const total =
      cappedByFetch &&
      plan.severities === null &&
      plan.since === null &&
      plan.until === null &&
      scopes.length === 1 &&
      titles.length === 1
        ? Math.max(bugs.length, serverTotal)
        : bugs.length;
    return {
      available: true,
      source: "model",
      errorCode: failed
        ? (outcomes.find((outcome) => outcome.errorCode)?.errorCode ?? "cli_failed")
        : null,
      conditions,
      bugs: bugs.slice(0, JARVIS_MAX_SEARCH_BUGS),
      total,
      capped,
    };
  }

  #plan(query: JarvisBugQuery, omit: Set<string>): SearchPlan {
    const scopeOmitted = omit.has(`scope:${query.scope}`);
    const statuses = omit.has("status:any")
      ? []
      : query.statuses.filter((value) => !omit.has(`status:${value}`));
    const priorities = query.priorities.filter((value) => !omit.has(`priority:${value}`));
    const severities = query.severities.filter((value) => !omit.has(`severity:${value}`));
    const window = omit.has("time") ? null : query.timeWindow;
    return {
      scope: scopeOmitted ? "both" : query.scope,
      statuses: statuses.length ? statuses : null,
      priorities: priorities.length ? priorities : null,
      severities: severities.length ? severities : null,
      order: omit.has(`order:${query.order}`) ? "newest" : query.order,
      timeField: query.timeWindow?.field ?? (query.order === "oldest" ? "create" : "update"),
      since: window?.since ?? null,
      until: window?.until ?? null,
      timeLabel: timeLabel(window),
      titles: omit.has("title") ? [] : [...new Set(query.titleKeywords)],
      scopeOmitted,
      orderOmitted: omit.has(`order:${query.order}`),
    };
  }

  async #resolveProjects(
    names: readonly string[],
    known: readonly JarvisProjectRow[],
    omit: Set<string>,
  ): Promise<ProjectResolution> {
    const tokens: ProjectTokenMatch[] = [];
    const targets = new Map<number, JarvisProjectRow>();
    const active = [...new Set(names)].filter((name) => !omit.has(`project:${name}`));
    const results = await Promise.all(
      active.map(async (name) => {
        const normalized = name.toLocaleLowerCase();
        return uniqById([
          ...known.filter((project) => project.name.toLocaleLowerCase().includes(normalized)),
          ...(await this.#searchProjects(name)),
        ]);
      }),
    );
    active.forEach((token, index) => {
      const projects = results[index] ?? [];
      tokens.push({ token, projects });
      for (const project of projects) targets.set(project.id, project);
    });
    if (active.length === 0) {
      for (const project of known) {
        if (!omit.has(`project:${project.name}`)) targets.set(project.id, project);
      }
    }
    return { tokens, targets };
  }

  async #searchProjects(name: string): Promise<JarvisProjectRow[]> {
    const cacheKey = name.toLocaleLowerCase();
    const cached = this.#projectSearches.get(cacheKey);
    if (cached && cached.expiresAt > this.#now()) return cached.projects;
    const projects = await this.#cli.searchProjects(name);
    this.#projectSearches.set(cacheKey, {
      projects,
      expiresAt: this.#now() + this.#projectSearchTtlMs,
    });
    if (this.#projectSearches.size > MAX_PROJECT_SEARCH_CACHE) {
      const oldest = this.#projectSearches.keys().next().value;
      if (oldest !== undefined) this.#projectSearches.delete(oldest);
    }
    return projects;
  }

  #fetch(
    projectId: number,
    createdByMe: boolean,
    plan: SearchPlan,
    title: string | null,
  ): Promise<FetchOutcome> {
    return (async () => {
      const rows: Record<string, unknown>[] = [];
      let total = 0;
      let failed = false;
      let errorCode: string | null = null;
      for (let page = 1; page <= MAX_PAGES_PER_QUERY; page += 1) {
        try {
          const options: JarvisBugListOptions = { createdByMe, page, pageSize: PAGE_SIZE };
          if (plan.statuses) options.statuses = plan.statuses;
          if (plan.priorities) options.priorities = plan.priorities;
          if (title) options.title = title;
          const result = await this.#cli.bugList(projectId, options);
          if (result.errorCode) {
            errorCode = result.errorCode;
            failed = rows.length === 0;
            break;
          }
          rows.push(...result.list);
          total = result.total;
          if (result.list.length < PAGE_SIZE || page * PAGE_SIZE >= result.total) break;
        } catch {
          errorCode = "cli_failed";
          failed = rows.length === 0;
          break;
        }
      }
      const capped = total > rows.length;
      return { rows, total, capped, failed, errorCode };
    })();
  }

  #filterAndSort(
    outcomes: readonly FetchOutcome[],
    projectNames: ReadonlyMap<number, string>,
    plan: SearchPlan,
  ): JarvisBug[] {
    const seen = new Set<string>();
    const bugs: JarvisBug[] = [];
    for (const outcome of outcomes) {
      for (const row of outcome.rows) {
        const bug = bugFromJarvisRow(row, projectNames);
        if (!bug) continue;
        const key = `${bug.projectId}:${bug.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (plan.statuses && !plan.statuses.includes(bug.status ?? -1)) continue;
        if (plan.priorities && !plan.priorities.includes(bug.priority ?? -1)) continue;
        if (plan.severities && !plan.severities.includes(bug.severity ?? -1)) continue;
        if (
          plan.titles.length &&
          !plan.titles.some((title) =>
            bug.title.toLocaleLowerCase().includes(title.toLocaleLowerCase()),
          )
        )
          continue;
        if (plan.since !== null || plan.until !== null) {
          const value = plan.timeField === "create" ? bug.createdAt : bug.updatedAt;
          const at = timestamp(value);
          if (
            at === 0 ||
            (plan.since !== null && at < plan.since) ||
            (plan.until !== null && at >= plan.until)
          )
            continue;
        }
        bugs.push(bug);
      }
    }
    bugs.sort((left, right) => {
      const leftTime = timestamp(plan.timeField === "create" ? left.createdAt : left.updatedAt);
      const rightTime = timestamp(plan.timeField === "create" ? right.createdAt : right.updatedAt);
      if (leftTime !== rightTime) {
        return plan.order === "oldest" ? leftTime - rightTime : rightTime - leftTime;
      }
      return plan.order === "oldest" ? left.id - right.id : right.id - left.id;
    });
    return bugs;
  }

  #conditions(
    plan: SearchPlan,
    resolution: ProjectResolution,
    omit: Set<string>,
  ): JarvisBugCondition[] {
    const conditions: JarvisBugCondition[] = [];
    const push = (condition: JarvisBugCondition): void => {
      if (omit.has(condition.key)) return;
      if (conditions.some((existing) => existing.key === condition.key)) return;
      conditions.push(condition);
    };
    if (!plan.scopeOmitted) {
      push({
        key: `scope:${plan.scope}`,
        kind: "scope",
        label:
          plan.scope === "created" ? "我创建的" : plan.scope === "both" ? "指派或创建" : "指派给我",
      });
    }
    if (plan.statuses) {
      if (plan.statuses.length >= 3) {
        push({ key: "status:any", kind: "status", label: "全部状态" });
      } else {
        for (const status of plan.statuses) {
          push({
            key: `status:${status}`,
            kind: "status",
            label: conditionLabel(status, { 1: "未解决", 2: "已解决", 3: "已关闭" }),
          });
        }
      }
    }
    if (plan.priorities) {
      for (const priority of plan.priorities) {
        push({
          key: `priority:${priority}`,
          kind: "priority",
          label: conditionLabel(priority, { 1: "高优先级", 2: "中优先级", 3: "低优先级" }),
        });
      }
    }
    if (plan.severities) {
      for (const severity of plan.severities) {
        push({
          key: `severity:${severity}`,
          kind: "severity",
          label: conditionLabel(severity, { 1: "致命", 2: "严重", 3: "一般", 4: "低" }),
        });
      }
    }
    if (!plan.orderOmitted) {
      push({
        key: `order:${plan.order}`,
        kind: "order",
        label: plan.order === "oldest" ? "最早" : "最新",
      });
    }
    if (plan.timeLabel) {
      push({ key: "time", kind: "time", label: plan.timeLabel });
    }
    for (const token of resolution.tokens) {
      if (omit.has(`project:${token.token}`)) continue;
      push({
        key: `project:${token.token}`,
        kind: "project",
        label:
          token.projects.length > 1
            ? `${truncate(token.token, 20)} ×${token.projects.length} 个项目`
            : (token.projects[0]?.name ?? token.token),
      });
    }
    if (plan.titles.length > 0) {
      push({
        key: "title",
        kind: "title",
        label: `标题含「${truncate(plan.titles.join(" / "), 16)}」`,
      });
    }
    return conditions.slice(0, 24);
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  });
  await Promise.all(workers);
  return results;
}
