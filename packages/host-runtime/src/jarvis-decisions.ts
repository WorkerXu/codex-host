import {
  DEFAULT_JARVIS_THRESHOLD,
  JARVIS_MAX_RANK_CANDIDATES,
  JARVIS_MAX_SUGGESTIONS,
  JARVIS_MIN_SUGGESTION_SCORE,
  type JarvisCandidate,
  type JarvisClassifyResult,
  type JarvisKind,
  type JarvisSuggestion,
  type JarvisUser,
} from "@codexhost/shared-contracts";

export const JARVIS_DECISIONS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/decisions";
export const JARVIS_DECISIONS_MODEL = "gemini-decision-1";

const DEFAULT_TIMEOUT_MS = 8_000;
const CLASSIFY_CACHE_TTL_MS = 5 * 60_000;
const RANK_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 200;

export class JarvisDecisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JarvisDecisionError";
  }
}

export interface JarvisDecisionsOptions {
  readApiKey(): Promise<string | null>;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  now?: () => number;
}

export interface JarvisDecisions {
  classify(
    query: string,
    threshold?: number,
  ): Promise<JarvisClassifyResult & { available: boolean }>;
  rank(
    query: string,
    kind: JarvisKind,
    candidates: readonly JarvisCandidate[],
    user: JarvisUser | null,
  ): Promise<{ available: boolean; suggestions: JarvisSuggestion[] }>;
  test(): Promise<{ ok: boolean; latencyMs: number | null; errorCode: string | null }>;
  clear(): void;
}

const CLASSIFY_INSTRUCTIONS =
  "判断用户输入是否在指代 Jarvis 项目管理系统中的条目（项目、需求、任务或 Bug）。" +
  "普通代码、文件、命令或闲聊不是 Jarvis 条目。";
const KIND_INSTRUCTIONS =
  "判断用户想引用的 Jarvis 条目类型；无法判断或不是 Jarvis 条目时选择 none。";
const KIND_CRITERIA = {
  project: "项目",
  requirement: "需求",
  task: "任务",
  bug: "Bug",
  none: "不是 Jarvis 条目",
} as const;
const RANK_INSTRUCTIONS =
  "结合用户查询、当前用户与当前日期，判断该候选是否就是用户所指的 Jarvis 条目。" +
  "标题语义最重要，其次参考状态、创建人/指派人和创建时间。不要因为类型相同就给高分。" +
  "如果用户说“新提给我”，近期创建、尚未解决且创建人不是当前用户的条目更相关；" +
  "如果用户点名创建人、模块、状态或时间，只有符合这些条件的候选才给高分。";
const SCORE_CRITERIA = ["不相关", "有点相关", "高度相关"] as const;

export interface JarvisDecisionRequest {
  model: string;
  input: string;
  questions: Record<string, Record<string, unknown>>;
}

export function buildClassifyRequest(query: string): JarvisDecisionRequest {
  return {
    model: JARVIS_DECISIONS_MODEL,
    input: query,
    questions: {
      is_jarvis: { type: "noul", instructions: CLASSIFY_INSTRUCTIONS },
      kind: { type: "choice", instructions: KIND_INSTRUCTIONS, criteria: KIND_CRITERIA },
    },
  };
}

function candidateLine(candidate: JarvisCandidate, index: number): string {
  const parts = [
    `${index + 1}.`,
    `类型=${candidate.kind}`,
    `id=${candidate.id}`,
    `标题=${JSON.stringify(candidate.title)}`,
  ];
  if (candidate.statusLabel) parts.push(`状态=${candidate.statusLabel}`);
  else if (candidate.status !== undefined) parts.push(`状态=${candidate.status}`);
  if (candidate.projectName) parts.push(`项目=${JSON.stringify(candidate.projectName)}`);
  if (candidate.creatorName) parts.push(`创建人=${JSON.stringify(candidate.creatorName)}`);
  else if (candidate.creatorId !== undefined) parts.push(`创建人ID=${candidate.creatorId}`);
  if (candidate.assigneeName) parts.push(`指派给=${JSON.stringify(candidate.assigneeName)}`);
  else if (candidate.assigneeId !== undefined) parts.push(`指派给ID=${candidate.assigneeId}`);
  if (candidate.createdAt) parts.push(`创建时间=${candidate.createdAt}`);
  return parts.join(" ");
}

/** One score question per candidate keeps the response shape flat and ordered. */
export function buildRankRequest(input: {
  query: string;
  kind: JarvisKind;
  candidates: readonly JarvisCandidate[];
  user: JarvisUser | null;
  today?: string;
}): JarvisDecisionRequest {
  const candidates = input.candidates.slice(0, JARVIS_MAX_RANK_CANDIDATES);
  const lines = [
    `用户查询：${input.query}`,
    `当前日期：${input.today ?? new Date().toISOString().slice(0, 10)}`,
    `当前用户：${input.user ? `${input.user.name} (ID ${input.user.id})` : "未知"}`,
    `候选类型：${input.kind}`,
    "候选列表：",
    ...candidates.map(candidateLine),
  ];
  const questions: Record<string, Record<string, unknown>> = {};
  candidates.forEach((candidate, index) => {
    // The Decisions API applies one question to the whole input, so each
    // score question must describe the candidate it is scoring.
    questions[`rel_${index}`] = {
      type: "score",
      instructions: `${RANK_INSTRUCTIONS}\n候选项：${candidateLine(candidate, index)}`,
      criteria: [...SCORE_CRITERIA],
    };
  });
  return {
    model: JARVIS_DECISIONS_MODEL,
    input: lines.join("\n"),
    questions,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export interface JarvisClassifyAnswers {
  noul: number;
  kind: JarvisClassifyResult["kind"];
  confidence: number;
}

/** Raw model answers, so the caller can apply its configured threshold. */
export function parseClassifyAnswers(value: unknown): JarvisClassifyAnswers {
  const answers = record(value) && record(value.answers) ? value.answers : null;
  const isJarvis = answers && record(answers.is_jarvis) ? answers.is_jarvis : null;
  const kind = answers && record(answers.kind) ? answers.kind : null;
  const choice = typeof kind?.choice === "string" ? kind.choice : "none";
  const valid =
    choice === "project" ||
    choice === "requirement" ||
    choice === "task" ||
    choice === "bug" ||
    choice === "none";
  return {
    noul: unit(isJarvis?.noul),
    kind: valid ? (choice as JarvisClassifyResult["kind"]) : "none",
    confidence: unit(kind?.confidence ?? isJarvis?.confidence),
  };
}

export function parseClassifyResponse(value: unknown): JarvisClassifyResult {
  const answers = parseClassifyAnswers(value);
  return {
    available: true,
    isJarvis: answers.noul >= DEFAULT_JARVIS_THRESHOLD && answers.kind !== "none",
    kind: answers.kind,
    confidence: answers.confidence,
  };
}

export function parseRankResponse(value: unknown, count: number): number[] {
  const answers = record(value) && record(value.answers) ? value.answers : null;
  return Array.from({ length: count }, (_unused, index) => {
    const answer = answers && record(answers[`rel_${index}`]) ? answers[`rel_${index}`] : null;
    if (!record(answer)) return 0;
    const score = answer.score;
    return typeof score === "number" && Number.isFinite(score) ? score : 0;
  });
}

export function createJarvisDecisions(options: JarvisDecisionsOptions): JarvisDecisions {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? JARVIS_DECISIONS_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const classifyCache = new Map<string, { value: JarvisClassifyResult; expiresAt: number }>();
  const rankCache = new Map<string, { value: JarvisSuggestion[]; expiresAt: number }>();

  const remember = <T>(
    cache: Map<string, { value: T; expiresAt: number }>,
    key: string,
    value: T,
    ttl: number,
  ): void => {
    cache.set(key, { value, expiresAt: now() + ttl });
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = [...cache.entries()].sort(
        (left, right) => left[1].expiresAt - right[1].expiresAt,
      )[0];
      if (oldest) cache.delete(oldest[0]);
    }
  };

  const request = async (body: JarvisDecisionRequest): Promise<unknown> => {
    const key = await options.readApiKey();
    if (!key) throw new JarvisDecisionError("missing_key", "Gemini API key is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": key,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        throw new JarvisDecisionError(
          controller.signal.aborted ? "timeout" : "network",
          error instanceof Error ? error.message : "Decisions request failed",
        );
      }
      if (!response.ok) {
        throw new JarvisDecisionError(
          response.status === 401 || response.status === 403
            ? "unauthorized"
            : `http_${response.status}`,
          `Decisions request failed with ${response.status}`,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new JarvisDecisionError("invalid_response", "Decisions response is not JSON");
      }
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async classify(query, threshold = DEFAULT_JARVIS_THRESHOLD) {
      const cacheKey = `${threshold}\u0000${query}`;
      const cached = classifyCache.get(cacheKey);
      if (cached && cached.expiresAt > now()) return cached.value;
      const answers = parseClassifyAnswers(await request(buildClassifyRequest(query)));
      const value: JarvisClassifyResult = {
        available: true,
        isJarvis: answers.noul >= threshold && answers.kind !== "none",
        kind: answers.kind,
        confidence: answers.confidence,
      };
      remember(classifyCache, cacheKey, value, CLASSIFY_CACHE_TTL_MS);
      return value;
    },
    async rank(query, kind, candidates, user) {
      const capped = candidates.slice(0, JARVIS_MAX_RANK_CANDIDATES);
      if (capped.length === 0) return { available: true, suggestions: [] };
      const cacheKey = `${query}\u0000${kind}\u0000${user?.id ?? ""}\u0000${capped
        .map((candidate) => `${candidate.kind}:${candidate.id}`)
        .join(",")}`;
      const cached = rankCache.get(cacheKey);
      if (cached && cached.expiresAt > now()) return { available: true, suggestions: cached.value };
      const scores = parseRankResponse(
        await request(buildRankRequest({ query, kind, candidates: capped, user })),
        capped.length,
      );
      const suggestions = capped
        .flatMap((candidate, index) => {
          const score = scores[index] ?? 0;
          return score >= JARVIS_MIN_SUGGESTION_SCORE
            ? [{ ...candidate, score: Math.round(score * 1000) / 1000 }]
            : [];
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, JARVIS_MAX_SUGGESTIONS);
      remember(rankCache, cacheKey, suggestions, RANK_CACHE_TTL_MS);
      return { available: true, suggestions };
    },
    async test() {
      const started = now();
      try {
        await request({
          model: JARVIS_DECISIONS_MODEL,
          input: "测试连接",
          questions: { is_jarvis: { type: "noul", instructions: CLASSIFY_INSTRUCTIONS } },
        });
        return { ok: true, latencyMs: now() - started, errorCode: null };
      } catch (error) {
        return {
          ok: false,
          latencyMs: null,
          errorCode: error instanceof JarvisDecisionError ? error.code : "network",
        };
      }
    },
    clear() {
      classifyCache.clear();
      rankCache.clear();
    },
  };
}
