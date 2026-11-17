/**
 * Structured Jarvis bug search behind the `@` entry.
 *
 * Rules parse the query first, the Decisions client is asked only about the
 * fields the rules did not settle, and project names are resolved on demand
 * (never by preloading every visible project). The search returns the whole
 * matching set up to the documented cap, not a similarity top-N.
 */
import {
  JARVIS_MAX_SEARCH_BUGS,
  JARVIS_MAX_SEARCH_PROJECTS,
  type JarvisBug,
  type JarvisBugCondition,
  type JarvisBugSearchParams,
  type JarvisBugSearchResult,
} from "@codexhost/shared-contracts";

import {
  jarvisDecisionTimeWindow,
  jarvisPriorityLabel,
  jarvisProjectPhrases,
  jarvisScopeLabel,
  jarvisSeverityLabel,
  jarvisStatusLabel,
  parseJarvisBugRules,
  type JarvisBugOrder,
  type JarvisBugScope,
} from "./jarvis-bug-query.js";
import {
  bugFromJarvisRow,
  type JarvisBugListOptions,
  type JarvisProjectRow,
} from "./jarvis-cli.js";
import type {
  JarvisBugInterpretation,
  JarvisDecisionField,
  JarvisDecisions,
} from "./jarvis-decisions.js";

const PAGE_SIZE = 100;
const MAX_PAGES_PER_QUERY = 2;
const PROJECT_SEARCH_TTL_MS = 5 * 60_000;
const MAX_PROJECT_SEARCH_CACHE = 64;
const MAX_AMBIGUOUS_PROJECT_MATCHES = 3;

export interface JarvisBugSearchCli {
  user(): Promise<{ id: number; name: string } | null>;
  projects(): Promise<JarvisProjectRow[]>;
  searchProjects(name: string): Promise<JarvisProjectRow[]>;
  bugs(
    projectId: number,
    options?: JarvisBugListOptions,
  ): Promise<{
    list: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
  }>;
}

export interface JarvisBugSearchOptions {
  cli: JarvisBugSearchCli;
  decisions: Pick<JarvisDecisions, "interpret" | "orderBugs">;
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
  keyword: string | null;
}

interface SearchPlan {
  scope: JarvisBugScope;
  statuses: number[] | null;
  priorities: number[] | null;
  severities: number[] | null;
  order: JarvisBugOrder;
  orderExplicit: boolean;
  timeField: "create" | "update";
  since: number | null;
  until: number | null;
  timeLabel: string | null;
  title: string | null;
  /** Scope chip is hidden after the user removes it. */
  scopeOmitted: boolean;
  timeOmitted: boolean;
  orderOmitted: boolean;
}

interface FetchOutcome {
  rows: Record<string, unknown>[];
  total: number;
  capped: boolean;
  failed: boolean;
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
  const parsed = Date.parse(value.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(1, limit - 1))}…` : value;
}

function containsMatch(name: string, phrase: string): boolean {
  const normalizedName = name.toLocaleLowerCase();
  const normalizedPhrase = phrase.toLocaleLowerCase();
  return normalizedName.includes(normalizedPhrase) || normalizedPhrase.includes(normalizedName);
}

function isBroadProjectMatch(phrase: string, projects: readonly JarvisProjectRow[]): boolean {
  return (
    uniqById(projects).length > MAX_AMBIGUOUS_PROJECT_MATCHES &&
    !projects.some((project) =>
      phrase.toLocaleLowerCase().includes(project.name.toLocaleLowerCase()),
    )
  );
}

/**
 * Match the leftover text against the projects linked to my bugs before any
 * network search. A project name contained in the phrase is removed so the
 * rest can still become the title keyword.
 */
function matchKnownProjects(
  phrase: string,
  known: readonly JarvisProjectRow[],
): { projects: JarvisProjectRow[]; remainder: string } {
  const matches = known
    .filter((project) => [...project.name].length >= 2 && containsMatch(project.name, phrase))
    .sort((left, right) => right.name.length - left.name.length);
  if (matches.length === 0) return { projects: [], remainder: phrase };
  let remainder = phrase;
  for (const project of matches) {
    remainder = remainder.replace(project.name, " ");
    // The phrase may be a prefix of the project name, in which case the phrase
    // itself is consumed.
    if (remainder === phrase) remainder = "";
  }
  return { projects: matches, remainder: remainder.trim() };
}

function searchVariants(phrase: string): string[] {
  const chars = [...phrase];
  if (chars.length <= 2) return [];
  const variants: string[] = [];
  for (let length = chars.length - 1; length >= 2 && variants.length < 4; length -= 1) {
    variants.push(chars.slice(0, length).join(""));
  }
  for (let start = 1; start <= chars.length - 2 && variants.length < 6; start += 1) {
    variants.push(chars.slice(start).join(""));
  }
  return variants;
}

export class JarvisBugSearcher {
  readonly #cli: JarvisBugSearchCli;
  readonly #decisions: Pick<JarvisDecisions, "interpret" | "orderBugs">;
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
    this.#decisions = options.decisions;
    this.#isLocalHost = options.isLocalHost;
    this.#now = options.now ?? Date.now;
    this.#concurrency = options.concurrency ?? 8;
    this.#projectSearchTtlMs = options.projectSearchTtlMs ?? PROJECT_SEARCH_TTL_MS;
  }

  async search(params: JarvisBugSearchParams, threshold?: number): Promise<JarvisBugSearchResult> {
    const now = this.#now();
    const rules = parseJarvisBugRules(params.query, now);
    const omit = new Set(params.omit ?? []);
    // Auth, the project list and the project-name search are independent; all
    // start before the (local-only) Gemini interpretation is awaited.
    const userPromise = this.#cli.user();
    const knownPromise = this.#cli.projects().catch(() => []);
    const projectSearchesPromise = this.#prefetchProjectSearches(rules.leftover, omit);
    const interpretation = this.#isLocalHost
      ? await this.#interpret(params.query, rules, threshold)
      : { available: false, values: {} as JarvisBugInterpretation };
    this.#applyInterpretation(rules, interpretation.values, now);

    const [user, known, prefetched] = await Promise.all([
      userPromise,
      knownPromise,
      projectSearchesPromise,
    ]);
    if (!user) {
      return {
        available: false,
        errorCode: "not_logged_in",
        conditions: [],
        bugs: [],
        total: 0,
        capped: false,
      };
    }

    const resolution = await this.#resolveProjects(rules.leftover, known, omit, prefetched);
    const plan = this.#plan(rules, resolution, omit);
    const projectNames = new Map<number, string>();
    for (const project of [...known, ...resolution.targets.values()]) {
      projectNames.set(project.id, project.name);
    }

    const targets = [...resolution.targets.values()].slice(0, JARVIS_MAX_SEARCH_PROJECTS);
    const scopes: boolean[] = plan.scope === "both" ? [false, true] : [plan.scope === "created"];
    const tasks = targets.flatMap((project) =>
      scopes.map((createdByMe) => () => this.#fetch(project.id, createdByMe, plan)),
    );
    const outcomes = await mapWithConcurrency(tasks, this.#concurrency, (task) => task());
    const failed = outcomes.length > 0 && outcomes.every((outcome) => outcome.failed);
    const cappedByFetch = outcomes.some((outcome) => outcome.capped);

    const bugs = this.#filterAndSort(outcomes, projectNames, plan);
    const capped = cappedByFetch || bugs.length > JARVIS_MAX_SEARCH_BUGS;
    const serverTotal = outcomes.reduce((sum, outcome) => sum + outcome.total, 0);
    const total =
      capped && plan.severities === null && plan.since === null
        ? Math.max(bugs.length, serverTotal)
        : bugs.length;
    let visible = bugs.slice(0, JARVIS_MAX_SEARCH_BUGS);

    if (this.#isLocalHost && plan.title !== null && !plan.orderExplicit && visible.length >= 10) {
      const ordered = await this.#decisions
        .orderBugs(params.query, visible)
        .catch(() => ({ available: false, bugs: visible }));
      if (ordered.available) visible = ordered.bugs;
    }

    return {
      available: true,
      errorCode: failed ? "cli_failed" : null,
      conditions: this.#conditions(plan, resolution, omit),
      bugs: visible,
      total,
      capped,
    };
  }

  async #interpret(
    query: string,
    rules: ReturnType<typeof parseJarvisBugRules>,
    threshold: number | undefined,
  ): Promise<{ available: boolean; values: JarvisBugInterpretation }> {
    const fields: JarvisDecisionField[] = [];
    if (rules.unresolved.scope) fields.push("scope");
    if (rules.unresolved.status) fields.push("status");
    if (rules.unresolved.priority) fields.push("priority");
    if (rules.unresolved.severity) fields.push("severity");
    if (rules.unresolved.order) fields.push("order");
    if (rules.unresolved.time) fields.push("time");
    if (fields.length === 0) return { available: true, values: {} };
    try {
      return await this.#decisions.interpret(query, fields, threshold);
    } catch {
      return { available: false, values: {} };
    }
  }

  #applyInterpretation(
    rules: ReturnType<typeof parseJarvisBugRules>,
    values: JarvisBugInterpretation,
    now: number,
  ): void {
    if (rules.unresolved.scope && values.scope) rules.scope = values.scope;
    if (rules.unresolved.status && values.statuses !== undefined) {
      rules.statuses = values.statuses;
    }
    if (rules.unresolved.priority && values.priorities !== undefined) {
      rules.priorities = values.priorities;
    }
    if (rules.unresolved.severity && values.severities !== undefined) {
      rules.severities = values.severities;
    }
    if (rules.unresolved.order && values.order) rules.order = values.order;
    if (rules.unresolved.time && values.timeWindow && values.timeWindow !== "any") {
      const window = jarvisDecisionTimeWindow(values.timeWindow, now);
      rules.since = window.since;
      rules.until = window.until;
      rules.timeLabel = window.label;
    }
  }

  #plan(
    rules: ReturnType<typeof parseJarvisBugRules>,
    resolution: ProjectResolution,
    omit: Set<string>,
  ): SearchPlan {
    const scopeOmitted = omit.has(`scope:${rules.scope}`);
    const statuses =
      rules.statuses && !omit.has("status:any")
        ? rules.statuses.filter((status) => !omit.has(`status:${status}`))
        : null;
    const priorities =
      rules.priorities?.filter((priority) => !omit.has(`priority:${priority}`)) ?? null;
    const severities =
      rules.severities?.filter((severity) => !omit.has(`severity:${severity}`)) ?? null;
    const orderOmitted = omit.has(`order:${rules.order}`);
    const timeOmitted = omit.has("time");
    return {
      scope: scopeOmitted ? "both" : rules.scope,
      statuses: statuses && statuses.length > 0 ? statuses : null,
      priorities: priorities && priorities.length > 0 ? priorities : null,
      severities: severities && severities.length > 0 ? severities : null,
      order: orderOmitted ? "newest" : rules.order,
      orderExplicit: rules.orderExplicit && !orderOmitted,
      timeField: rules.timeField,
      since: timeOmitted ? null : rules.since,
      until: timeOmitted ? null : rules.until,
      timeLabel: timeOmitted ? null : rules.timeLabel,
      title: omit.has("title")
        ? null
        : [rules.title, resolution.keyword].filter(Boolean).join(" ") || null,
      scopeOmitted,
      timeOmitted,
      orderOmitted,
    };
  }

  /**
   * Start the project-name searches in parallel with auth, `project list` and
   * Gemini. Project resolution itself never depends on the Gemini answer.
   */
  async #prefetchProjectSearches(
    leftover: string,
    omit: Set<string>,
  ): Promise<Map<string, JarvisProjectRow[]>> {
    const phrases = jarvisProjectPhrases(leftover)
      .filter((phrase) => !omit.has(`project:${phrase}`))
      .slice(0, 8);
    const results = new Map<string, JarvisProjectRow[]>();
    await Promise.all(
      phrases.map(async (phrase) => {
        results.set(phrase, await this.#searchProjects(phrase));
      }),
    );
    return results;
  }

  async #resolveProjects(
    leftover: string,
    known: readonly JarvisProjectRow[],
    omit: Set<string>,
    prefetched: ReadonlyMap<string, JarvisProjectRow[]>,
  ): Promise<ProjectResolution> {
    const tokens: ProjectTokenMatch[] = [];
    const targets = new Map<number, JarvisProjectRow>();
    const remainders: string[] = [];
    let searchBudget = 6;

    for (const phrase of jarvisProjectPhrases(leftover)) {
      if (omit.has(`project:${phrase}`)) continue;
      const knownMatch = matchKnownProjects(phrase, known);
      const direct = prefetched.get(phrase) ?? (await this.#searchProjects(phrase));
      if (isBroadProjectMatch(phrase, [...knownMatch.projects, ...direct])) {
        remainders.push(phrase);
        continue;
      }
      if (knownMatch.projects.length > 0) {
        const matched = uniqById(knownMatch.projects);
        tokens.push({ token: phrase, projects: matched });
        for (const project of matched) targets.set(project.id, project);
        if (knownMatch.remainder) remainders.push(knownMatch.remainder);
        continue;
      }
      let matched: JarvisProjectRow[] = [];
      let consumed = phrase;
      if (direct.length > 0) {
        matched = direct;
      } else if (searchBudget > 0) {
        for (const variant of searchVariants(phrase).filter(
          (value) => jarvisProjectPhrases(value).length > 0,
        )) {
          if (searchBudget <= 0) break;
          searchBudget -= 1;
          const result = await this.#searchProjects(variant);
          if (result.length > 0) {
            if (isBroadProjectMatch(variant, result)) break;
            if (omit.has(`project:${variant}`)) break;
            matched = result;
            consumed = variant;
            const index = phrase.indexOf(variant);
            const rest = `${phrase.slice(0, index)} ${phrase
              .slice(index + variant.length)
              .trim()}`.trim();
            if (rest) remainders.push(rest);
            break;
          }
        }
      }
      if (matched.length > 0) {
        const unique = uniqById(matched);
        tokens.push({ token: consumed, projects: unique });
        for (const project of unique) targets.set(project.id, project);
      } else {
        remainders.push(phrase);
      }
    }

    if (targets.size === 0) {
      for (const project of known) {
        if (omit.has(`project:${project.name}`)) continue;
        targets.set(project.id, project);
      }
    }
    const keyword = remainders.join(" ").trim() || null;
    return { tokens, targets, keyword };
  }

  async #searchProjects(name: string): Promise<JarvisProjectRow[]> {
    const cacheKey = name.toLocaleLowerCase();
    const cached = this.#projectSearches.get(cacheKey);
    if (cached && cached.expiresAt > this.#now()) return cached.projects;
    const projects = await this.#cli.searchProjects(name).catch(() => []);
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

  #fetch(projectId: number, createdByMe: boolean, plan: SearchPlan): Promise<FetchOutcome> {
    return (async () => {
      const rows: Record<string, unknown>[] = [];
      let total = 0;
      let failed = false;
      for (let page = 1; page <= MAX_PAGES_PER_QUERY; page += 1) {
        try {
          const options: JarvisBugListOptions = { createdByMe, page, pageSize: PAGE_SIZE };
          if (plan.statuses) options.statuses = plan.statuses;
          if (plan.priorities) options.priorities = plan.priorities;
          if (plan.title) options.title = plan.title;
          const result = await this.#cli.bugs(projectId, options);
          rows.push(...result.list);
          total = result.total;
          if (result.list.length < PAGE_SIZE || page * PAGE_SIZE >= result.total) break;
        } catch {
          failed = rows.length === 0;
          break;
        }
      }
      const capped = total > rows.length;
      return { rows, total, capped, failed };
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
        if (plan.since !== null) {
          const value = plan.timeField === "create" ? bug.createdAt : bug.updatedAt;
          const at = timestamp(value);
          if (at === 0 || at < plan.since || (plan.until !== null && at >= plan.until)) continue;
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
      push({ key: `scope:${plan.scope}`, kind: "scope", label: jarvisScopeLabel(plan.scope) });
    }
    if (plan.statuses) {
      if (plan.statuses.length >= 3) {
        push({ key: "status:any", kind: "status", label: "全部状态" });
      } else {
        for (const status of plan.statuses) {
          push({
            key: `status:${status}`,
            kind: "status",
            label: jarvisStatusLabel([status]),
          });
        }
      }
    }
    if (plan.priorities) {
      for (const priority of plan.priorities) {
        push({
          key: `priority:${priority}`,
          kind: "priority",
          label: jarvisPriorityLabel([priority]),
        });
      }
    }
    if (plan.severities) {
      for (const severity of plan.severities) {
        push({
          key: `severity:${severity}`,
          kind: "severity",
          label: jarvisSeverityLabel([severity]),
        });
      }
    }
    if (plan.orderExplicit) {
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
    if (plan.title) {
      push({
        key: "title",
        kind: "title",
        label: `标题含「${truncate(plan.title, 16)}」`,
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
