import {
  DINGTALK_MAX_CONVERSATIONS,
  type DingTalkConversation,
  type DingTalkDecideResult,
} from "@codexhost/shared-contracts";

export const DINGTALK_DECISIONS_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/decisions";
export const DINGTALK_DECISIONS_MODEL = "gemini-decision-1";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_CACHE_ENTRIES = 200;
const CACHE_TTL_MS = 60_000;
const MAX_SCORED = 50;
const MIN_SCORE = 1.05;

export class DingTalkDecisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DingTalkDecisionError";
  }
}

export interface DingTalkDecisionsOptions {
  readApiKey(): Promise<string | null>;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  now?: () => number;
}

export interface DingTalkDecisionRequest {
  model: string;
  input: string;
  questions: Record<string, Record<string, unknown>>;
}

const ROUTE_INSTRUCTIONS =
  "判断用户想如何在钉钉里查找。用户要找某个会话、某个人、某个群，或问“谁最近给我发消息”时选择 conversations；" +
  "用户要按内容关键词、发送人、@我或时间范围查找聊天记录时选择 messages；与钉钉无关时选择 none。";
const ROUTE_CRITERIA = {
  conversations: "查找会话或人",
  messages: "查找聊天记录内容",
  none: "与钉钉无关",
} as const;
const FROM_ME_INSTRUCTIONS = "用户是否明确要求查找自己发送的聊天记录。";
const AT_ME_INSTRUCTIONS = "用户是否明确要求查找 @我 的消息。";
const RANGE_INSTRUCTIONS = "用户要求的时间范围；未说明时选择 30 天。";
const RECENT_INSTRUCTIONS =
  "用户是否只是按时间找最近的会话（例如“最新给我发消息的”“谁刚找我”“最近的聊天”），" +
  "而没有指定会话名称、人名、群名或内容关键词。";
const RANGE_CRITERIA = { "7": "最近一周", "30": "最近一个月", "90": "最近三个月" } as const;
const SCORE_INSTRUCTIONS =
  "判断该钉钉会话是否就是用户想找的会话。标题语义最重要，其次参考最近消息摘要、单聊/群聊和最近消息时间。" +
  "不要因为都是群聊或都最近活跃就给高分。";
const SCORE_CRITERIA = ["不相关", "有点相关", "高度相关"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildDingTalkDecideRequest(
  query: string,
  conversations: readonly DingTalkConversation[],
): DingTalkDecisionRequest {
  const lines = [
    `用户查询：${query}`,
    "候选会话（仅供 conversations 路由参考）：",
    ...conversations
      .slice(0, DINGTALK_MAX_CONVERSATIONS)
      .map(
        (conversation, index) =>
          `${index + 1}. ${conversation.singleChat ? "单聊" : "群聊"} ${JSON.stringify(
            conversation.title,
          )}${conversation.preview ? ` 最近消息=${JSON.stringify(conversation.preview)}` : ""}`,
      ),
  ];
  return {
    model: DINGTALK_DECISIONS_MODEL,
    input: lines.join("\n"),
    questions: {
      route: { type: "choice", instructions: ROUTE_INSTRUCTIONS, criteria: ROUTE_CRITERIA },
      from_me: { type: "noul", instructions: FROM_ME_INSTRUCTIONS },
      at_me: { type: "noul", instructions: AT_ME_INSTRUCTIONS },
      range: { type: "choice", instructions: RANGE_INSTRUCTIONS, criteria: RANGE_CRITERIA },
      by_recency: { type: "noul", instructions: RECENT_INSTRUCTIONS },
    },
  };
}

/** One score question per candidate keeps the response shape flat and ordered. */
export function buildDingTalkScoreRequest(
  query: string,
  conversations: readonly DingTalkConversation[],
): DingTalkDecisionRequest {
  const candidates = conversations.slice(0, MAX_SCORED);
  const questions: Record<string, Record<string, unknown>> = {};
  candidates.forEach((conversation, index) => {
    questions[`rel_${index}`] = {
      type: "score",
      instructions: `${SCORE_INSTRUCTIONS}\n候选：${conversation.singleChat ? "单聊" : "群聊"} ${JSON.stringify(
        conversation.title,
      )}${conversation.preview ? ` 最近消息=${JSON.stringify(conversation.preview)}` : ""}`,
      criteria: [...SCORE_CRITERIA],
    };
  });
  return {
    model: DINGTALK_DECISIONS_MODEL,
    input: `用户查询：${query}`,
    questions,
  };
}

function unit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export interface DingTalkDecideAnswers {
  route: DingTalkDecideResult["route"];
  fromMe: boolean;
  atMe: boolean;
  days: number;
  /** The user wants the most recent conversations, not a named one. */
  byRecency: boolean;
}

export function parseDingTalkDecideAnswers(value: unknown): DingTalkDecideAnswers {
  const answers = record(value) && record(value.answers) ? value.answers : null;
  const route = answers && record(answers.route) ? answers.route : null;
  const choice = typeof route?.choice === "string" ? route.choice : "none";
  const validRoute = choice === "messages" || choice === "conversations" || choice === "none";
  const range = answers && record(answers.range) ? answers.range : null;
  const rangeChoice = typeof range?.choice === "string" ? Number(range.choice) : 30;
  const fromMe = answers && record(answers.from_me) ? answers.from_me : null;
  const atMe = answers && record(answers.at_me) ? answers.at_me : null;
  const byRecency = answers && record(answers.by_recency) ? answers.by_recency : null;
  return {
    route: validRoute ? (choice as DingTalkDecideResult["route"]) : "none",
    fromMe: unit(fromMe?.noul) >= 0.5,
    atMe: unit(atMe?.noul) >= 0.5,
    days: rangeChoice === 7 || rangeChoice === 90 ? rangeChoice : 30,
    byRecency: unit(byRecency?.noul) >= 0.5,
  };
}

/** Conversations someone else spoke in last, newest first; used for time-only queries. */
export function dingtalkRecentConversationIds(
  conversations: readonly DingTalkConversation[],
): string[] {
  return [...conversations]
    .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0))
    .map(({ conversationId }) => conversationId)
    .slice(0, 8);
}

export function parseDingTalkScoreResponse(value: unknown, count: number): number[] {
  const answers = record(value) && record(value.answers) ? value.answers : null;
  return Array.from({ length: count }, (_unused, index) => {
    const answer = answers && record(answers[`rel_${index}`]) ? answers[`rel_${index}`] : null;
    if (!record(answer)) return 0;
    return typeof answer.score === "number" && Number.isFinite(answer.score) ? answer.score : 0;
  });
}

const STOP_WORDS = [
  "帮我",
  "请",
  "搜索",
  "查找",
  "查一下",
  "找一下",
  "找",
  "看看",
  "聊天记录",
  "聊天",
  "消息",
  "记录",
  "钉钉",
  "最近",
  "里",
  "的",
  "关于",
  "一下",
  "谁",
  "给我发",
  "发过",
] as const;

/** A conservative keyword fallback for `+search-msg --query`. */
export function dingtalkMessageKeyword(query: string): string {
  let text = query.trim();
  for (const word of STOP_WORDS) text = text.split(word).join(" ");
  return text
    .replace(/[\s,，。.!！?？:：;；"'“”‘’]+/gu, " ")
    .trim()
    .slice(0, 100);
}

export interface DingTalkDecisionResult extends DingTalkDecideResult {
  keywords: string;
}

export interface DingTalkDecisions {
  decide(
    query: string,
    conversations: readonly DingTalkConversation[],
  ): Promise<DingTalkDecisionResult>;
  score(
    query: string,
    conversations: readonly DingTalkConversation[],
  ): Promise<DingTalkConversation[]>;
  clear(): void;
}

export function createDingTalkDecisions(options: DingTalkDecisionsOptions): DingTalkDecisions {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? DINGTALK_DECISIONS_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: unknown; expiresAt: number }>();

  const request = async (body: DingTalkDecisionRequest): Promise<unknown> => {
    const key = await options.readApiKey();
    if (!key) throw new DingTalkDecisionError("missing_key", "Gemini API key is not configured");
    const cacheKey = JSON.stringify(body);
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.value;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        throw new DingTalkDecisionError(
          controller.signal.aborted ? "timeout" : "network",
          error instanceof Error ? error.message : "Decisions request failed",
        );
      }
      if (!response.ok) {
        throw new DingTalkDecisionError(
          response.status === 401 || response.status === 403
            ? "unauthorized"
            : `http_${response.status}`,
          `Decisions request failed with ${response.status}`,
        );
      }
      const value: unknown = await response.json().catch(() => {
        throw new DingTalkDecisionError("invalid_response", "Decisions response is not JSON");
      });
      cache.set(cacheKey, { value, expiresAt: now() + CACHE_TTL_MS });
      if (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = [...cache.entries()].sort(
          (left, right) => left[1].expiresAt - right[1].expiresAt,
        )[0];
        if (oldest) cache.delete(oldest[0]);
      }
      return value;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async decide(query, conversations) {
      const answers = parseDingTalkDecideAnswers(
        await request(buildDingTalkDecideRequest(query, conversations)),
      );
      const keywords = dingtalkMessageKeyword(query);
      if (answers.byRecency && !answers.fromMe && !answers.atMe) {
        return {
          available: true,
          route: "conversations",
          messageQuery: keywords,
          fromMe: false,
          atMe: false,
          days: answers.days,
          conversationIds: dingtalkRecentConversationIds(conversations),
          errorCode: null,
          keywords,
        };
      }
      if (answers.route === "conversations") {
        const scored = await this.score(query, conversations);
        return {
          available: true,
          route: "conversations",
          messageQuery: keywords,
          fromMe: answers.fromMe,
          atMe: answers.atMe,
          days: answers.days,
          conversationIds: scored.map(({ conversationId }) => conversationId).slice(0, 8),
          errorCode: null,
          keywords,
        };
      }
      return {
        available: true,
        route: answers.route,
        messageQuery: keywords,
        fromMe: answers.fromMe,
        atMe: answers.atMe,
        days: answers.days,
        conversationIds: [],
        errorCode: null,
        keywords,
      };
    },
    async score(query, conversations) {
      const candidates = conversations.slice(0, MAX_SCORED);
      if (candidates.length === 0) return [];
      const scores = parseDingTalkScoreResponse(
        await request(buildDingTalkScoreRequest(query, candidates)),
        candidates.length,
      );
      return candidates
        .flatMap((conversation, index) => {
          const score = scores[index] ?? 0;
          return score >= MIN_SCORE ? [{ conversation, score }] : [];
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, 8)
        .map(({ conversation }) => conversation);
    },
    clear() {
      cache.clear();
    },
  };
}
