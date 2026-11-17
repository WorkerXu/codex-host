/**
 * Deterministic Jarvis Bug query parsing and condition labels.
 */

export type JarvisBugScope = "assigned" | "created" | "both";
export type JarvisBugOrder = "newest" | "oldest";

export interface JarvisBugRuleMatch {
  scope: JarvisBugScope;
  statuses: number[] | null;
  priorities: number[] | null;
  severities: number[] | null;
  order: JarvisBugOrder;
  orderExplicit: boolean;
  timeField: "create" | "update";
  timeFieldExplicit: boolean;
  since: number | null;
  until: number | null;
  timeLabel: string | null;
  title: string | null;
  leftover: string;
  /** Fields without an explicit rule match. */
  unresolved: {
    scope: boolean;
    status: boolean;
    priority: boolean;
    severity: boolean;
    order: boolean;
    time: boolean;
  };
}

interface Consumed {
  text: string;
  values: string[];
}

function consume(text: string, patterns: readonly RegExp[]): Consumed {
  let remaining = text;
  const values: string[] = [];
  for (const pattern of patterns) {
    const matches = remaining.match(pattern);
    if (!matches) continue;
    for (const match of matches) {
      const trimmed = match.trim();
      if (trimmed) values.push(trimmed);
    }
    remaining = remaining.replace(pattern, "");
  }
  return { text: remaining, values };
}

function uniq<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function hits(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function startOfDay(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfWeek(value: number): number {
  const date = new Date(startOfDay(value));
  const day = date.getDay();
  const offset = day === 0 ? 6 : day - 1;
  date.setDate(date.getDate() - offset);
  return date.getTime();
}

const DAY_MS = 86_400_000;

interface TimeWindow {
  since: number;
  until: number | null;
  label: string;
}

function timeWindows(now: number): { match: RegExp; window: TimeWindow }[] {
  const today = startOfDay(now);
  const week = startOfWeek(now);
  const yesterday = today - DAY_MS;
  const lastWeek = week - 7 * DAY_MS;
  const month = (() => {
    const date = new Date(now);
    date.setDate(1);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  })();
  return [
    { match: /今天|今日/gu, window: { since: today, until: null, label: "今天" } },
    {
      match: /昨天|昨日/gu,
      window: { since: yesterday, until: today, label: "昨天" },
    },
    {
      match: /上周|上个?星期/gu,
      window: { since: lastWeek, until: week, label: "上周" },
    },
    { match: /本周|这周|本星期|这个?星期/gu, window: { since: week, until: null, label: "本周" } },
    { match: /本月|这个?月/gu, window: { since: month, until: null, label: "本月" } },
    {
      match: /最近\s*(一|1)\s*(?:个)?月|近\s*(一|1)\s*(?:个)?月|30\s*天内?/gu,
      window: { since: now - 30 * DAY_MS, until: null, label: "最近 30 天" },
    },
    {
      match: /最近\s*(一|1)\s*(?:个)?(?:周|星期)|近\s*(一|1)\s*(?:个)?(?:周|星期)|一周内/gu,
      window: { since: now - 7 * DAY_MS, until: null, label: "最近 7 天" },
    },
    {
      match: /最近\s*(\d{1,3})\s*天|近\s*(\d{1,3})\s*天|过去\s*(\d{1,3})\s*天/gu,
      window: { since: now - 1 * DAY_MS, until: null, label: "最近 N 天" },
    },
  ];
}

function daysWindow(match: string, now: number): TimeWindow | null {
  const digits = /(\d{1,3})/u.exec(match)?.[1];
  const days = digits ? Number(digits) : 1;
  if (!Number.isFinite(days) || days <= 0) return null;
  return { since: now - days * DAY_MS, until: null, label: `最近 ${days} 天` };
}

const SCOPE_PATTERNS = {
  created: [/(?:由)?(?:我|本人)(?:创建|提(?:交|出)?|报|建)(?:的)?/gu],
  assigned: [
    /(?:指派|分配|分派)(?:给|到|了)?(?:我|本人)/gu,
    /(?:我|本人)(?:的|名下|负责|处理|跟进|管)/gu,
  ],
  both: [/我(?:相关|参与)|与我相关|和我相关/gu],
} as const;

const STATUS_PATTERNS = {
  open: [/未关闭|没关闭|没关的|不是关闭/gu],
  active: [
    /(?:待|等待)(?:处理|解决|修复|完成)/gu,
    /(?:还没|还没有|没有|没|未)(?:有)?(?:处理|解决|修复|完成|搞定|关闭)(?:完成|完|好|掉)?/gu,
    /未解决|未处理|未修复|未完成|待修复|激活|进行中|处理中|还没好|open|active/gu,
  ],
  resolved: [/已解决|已经解决|解决了|已修复|修复了|待验收|待验证|resolved/gu],
  closed: [/已关闭|已经关闭|关闭了|closed/gu],
  any: [/所有状态|全部状态|不论状态|不管状态|不限状态/gu],
} as const;

const PRIORITY_PATTERNS = {
  high: [/高优先级|优先级高|紧急|加急|很急|尽快|重要/gu],
  medium: [/中优先级|优先级中|一般优先/gu],
  low: [/低优先级|优先级低|不急|不着急/gu],
} as const;

const SEVERITY_PATTERNS = {
  high: [/致命|崩溃|闪退|阻塞|卡死|无法使用|严重/gu],
  medium: [/中等严重|一般严重|有点严重|一般/gu],
  low: [/轻微|小问题|不严重|低严重|低/gu],
} as const;

const ORDER_PATTERNS = {
  oldest: [/最早|最旧|从旧到新|由旧到新|升序/gu],
  newest: [/最近|最新|近期|从新到旧|降序|刚刚/gu],
} as const;

const LEADING_REQUEST =
  /^\s*(?:帮我|帮忙|请|麻烦|给我|我想|我要|想要|需要|看看|查查|搜索|查询|列出|找出|找找|查一下|看一下|搜一下|列一下|找一下)\s*/u;

const FILLER_PATTERNS = [
  /(?:jarvis|贾维斯)/giu,
  /\bbug\b/giu,
  /(?:问题|缺陷|单子|单据|条目|记录)/gu,
  /(?:标题|题目|名称|内容|描述)(?:里面?|中)?\s*(?:包含|关于|有|含|带|是|叫)?/gu,
  /(?:项目|project)(?:里|中|下|里面)?/giu,
  /(?:所有|全部|相关|有关|关于|里面|其中)/gu,
  /(?:一下|下)(?=\s|$)/gu,
];

const PROJECT_STOP_WORD =
  /^(?:标题|题目|名称|内容|描述|bug|问题|缺陷|包含|关于|有|含|带|是|叫|在|里|里面|中|的)$/iu;

function extractTitle(text: string): { text: string; title: string | null } {
  const keywords: string[] = [];
  const collect = (_match: string, keyword: string): string => {
    const cleaned = keyword
      .trim()
      .replace(/["'“”‘’]/gu, "")
      .replace(/(?:(?:的|\bbug\b|问题)\s*)+$/giu, "")
      .trim();
    if (cleaned) keywords.push(cleaned);
    return " ";
  };
  const remaining = text
    .replace(
      /(?:标题|题目|名称)(?:里面?|中)?\s*(?:包含|关于|有|含|带|是|叫)\s*([^,，;；。！？!?]+)/gu,
      collect,
    )
    .replace(
      /([^的,，;；。！？!?]+?(?:的\s*(?:bug\b|问题)?)?)\s*在\s*(?:标题|题目|名称)(?:里面?|中)/giu,
      collect,
    );
  return { text: remaining, title: keywords.join(" ") || null };
}

function stripLeadingRequest(value: string): string {
  let text = value.trim();
  // Remove several stacked request words, e.g. 「帮我查一下」.
  for (;;) {
    const next = text.replace(LEADING_REQUEST, "");
    if (next === text) break;
    text = next;
  }
  return text;
}

function cleanLeftover(value: string): string {
  let text = stripLeadingRequest(value);
  for (const pattern of FILLER_PATTERNS) {
    text = text.replace(pattern, " ");
  }
  // Repeat because 「示例买的的bug」 leaves two trailing particles in one pass.
  for (;;) {
    const next = text
      .replace(/^\s*(?:的|了|吧|呢|吗|啊|呀|呗|哦|嘛)\s*/u, "")
      .replace(/(?:的|了|吧|呢|吗|啊|呀|呗|哦|嘛)(?=\s|$)/gu, " ");
    if (next === text) break;
    text = next;
  }
  return ` ${text} `
    .replace(/\s(?:和|或|与|以及)(?=\s)/gu, " ")
    .replace(/[,，、;；/|:：()（）[\]【】"'“”‘’!！?？.。]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseJarvisBugRules(query: string, now = Date.now()): JarvisBugRuleMatch {
  const title = extractTitle(`${stripLeadingRequest(query)} `);
  let text = title.text;

  // Time windows run first so 「最近 3 天」 is not read as an ordering word.
  let timeLabel: string | null = null;
  let since: number | null = null;
  let until: number | null = null;
  for (const entry of timeWindows(now)) {
    const matches = text.match(entry.match);
    if (!matches || matches.length === 0) continue;
    const window =
      entry.window.label === "最近 N 天" ? daysWindow(matches[0] ?? "", now) : entry.window;
    if (!window) continue;
    timeLabel = window.label;
    since = window.since;
    until = window.until;
    text = text.replace(entry.match, " ");
    break;
  }

  const status = consume(text, [
    ...STATUS_PATTERNS.any,
    ...STATUS_PATTERNS.open,
    ...STATUS_PATTERNS.active,
    ...STATUS_PATTERNS.resolved,
    ...STATUS_PATTERNS.closed,
  ]);
  text = status.text;
  const statusValues = uniq(
    status.values.some((value) => STATUS_PATTERNS.any.some((pattern) => hits(pattern, value)))
      ? ["any"]
      : status.values.flatMap((value) => {
          if (STATUS_PATTERNS.open.some((pattern) => hits(pattern, value))) return ["open"];
          if (STATUS_PATTERNS.active.some((pattern) => hits(pattern, value))) return ["active"];
          if (STATUS_PATTERNS.resolved.some((pattern) => hits(pattern, value))) return ["resolved"];
          if (STATUS_PATTERNS.closed.some((pattern) => hits(pattern, value))) return ["closed"];
          return [];
        }),
  );
  let statuses: number[] | null = null;
  if (statusValues.includes("any")) statuses = null;
  else if (statusValues.length > 0) {
    statuses = uniq(
      statusValues.flatMap((value) =>
        value === "open"
          ? [1, 2]
          : value === "active"
            ? [1]
            : value === "resolved"
              ? [2]
              : value === "closed"
                ? [3]
                : [],
      ),
    ).sort((left, right) => left - right);
  }

  const scope = consume(text, [
    ...SCOPE_PATTERNS.both,
    ...SCOPE_PATTERNS.created,
    ...SCOPE_PATTERNS.assigned,
  ]);
  text = scope.text;
  const scopeKinds = uniq(
    scope.values.flatMap((value) => {
      if (SCOPE_PATTERNS.both.some((pattern) => hits(pattern, value))) return ["both"];
      if (SCOPE_PATTERNS.created.some((pattern) => hits(pattern, value))) return ["created"];
      if (SCOPE_PATTERNS.assigned.some((pattern) => hits(pattern, value))) return ["assigned"];
      return [];
    }),
  );
  const scopeValue: JarvisBugScope =
    scopeKinds.includes("both") ||
    (scopeKinds.includes("created") && scopeKinds.includes("assigned"))
      ? "both"
      : scopeKinds.includes("created")
        ? "created"
        : "assigned";

  const priority = consume(text, [
    ...PRIORITY_PATTERNS.high,
    ...PRIORITY_PATTERNS.medium,
    ...PRIORITY_PATTERNS.low,
  ]);
  text = priority.text;
  const priorities = uniq(
    priority.values.flatMap((value) =>
      PRIORITY_PATTERNS.high.some((pattern) => hits(pattern, value))
        ? [1]
        : PRIORITY_PATTERNS.medium.some((pattern) => hits(pattern, value))
          ? [2]
          : PRIORITY_PATTERNS.low.some((pattern) => hits(pattern, value))
            ? [3]
            : [],
    ),
  ).sort((left, right) => left - right);

  const severity = consume(text, [
    ...SEVERITY_PATTERNS.high,
    ...SEVERITY_PATTERNS.medium,
    ...SEVERITY_PATTERNS.low,
  ]);
  text = severity.text;
  const severities = uniq(
    severity.values.flatMap((value) =>
      SEVERITY_PATTERNS.high.some((pattern) => hits(pattern, value))
        ? [1, 2]
        : SEVERITY_PATTERNS.medium.some((pattern) => hits(pattern, value))
          ? [3]
          : SEVERITY_PATTERNS.low.some((pattern) => hits(pattern, value))
            ? [4]
            : [],
    ),
  ).sort((left, right) => left - right);

  // A time window or an explicit order word selects the timestamp it uses.
  let timeField: "create" | "update" = "update";
  let timeFieldExplicit = false;
  const mentionsOrder = /最近|最新|最早|最旧/u.test(text);
  if (timeLabel || mentionsOrder) {
    if (/创建|提出|提交|报的/u.test(text)) {
      timeField = "create";
      timeFieldExplicit = true;
      text = text.replace(/(?:创建|提出|提交|报)的?/gu, " ");
    } else if (/更新|处理过|改过|动过/u.test(text)) {
      timeField = "update";
      timeFieldExplicit = true;
      text = text.replace(/(?:更新|处理过|改过|动过)的?/gu, " ");
    }
  }
  if (/按(?:更新|处理)时间/u.test(text)) {
    timeField = "update";
    timeFieldExplicit = true;
    text = text.replace(/按(?:更新|处理)时间/gu, " ");
  } else if (/按(?:创建|提出|提交)时间/u.test(text)) {
    timeField = "create";
    timeFieldExplicit = true;
    text = text.replace(/按(?:创建|提出|提交)时间/gu, " ");
  }

  const order = consume(text, [...ORDER_PATTERNS.oldest, ...ORDER_PATTERNS.newest]);
  text = order.text;
  const orderExplicit = order.values.length > 0;
  const oldest = order.values.some((value) =>
    ORDER_PATTERNS.oldest.some((pattern) => hits(pattern, value)),
  );
  const orderValue: JarvisBugOrder = oldest ? "oldest" : "newest";
  if (oldest && !timeFieldExplicit) timeField = "create";

  const leftover = cleanLeftover(text);

  return {
    scope: scopeValue,
    statuses,
    priorities: priorities.length > 0 ? priorities : null,
    severities: severities.length > 0 ? severities : null,
    order: orderValue,
    orderExplicit,
    timeField,
    timeFieldExplicit,
    since,
    until,
    timeLabel,
    title: title.title,
    leftover,
    unresolved: {
      scope: scopeKinds.length === 0,
      status: statusValues.length === 0,
      priority: priority.values.length === 0,
      severity: severity.values.length === 0,
      order: !orderExplicit,
      time: timeLabel === null,
    },
  };
}

/** Split the leftover text into the phrases tried against project names. */
export function jarvisProjectPhrases(leftover: string): string[] {
  return uniq(
    leftover
      .split(/[\s,，、;；/|]+/u)
      .map((value) => value.trim())
      .filter((value) => [...value].length >= 2 && !PROJECT_STOP_WORD.test(value)),
  ).sort((left, right) => [...right].length - [...left].length);
}

export function jarvisScopeLabel(scope: JarvisBugScope): string {
  return scope === "created" ? "我创建的" : scope === "both" ? "指派或创建" : "指派给我";
}

function labelsOf(values: readonly number[], labels: Readonly<Record<number, string>>): string {
  const parts: string[] = [];
  for (const value of values) {
    const label = labels[value];
    if (label) parts.push(label);
  }
  return parts.join(" / ");
}

export function jarvisStatusLabel(statuses: readonly number[]): string {
  if (statuses.length >= 3) return "全部状态";
  return labelsOf(statuses, { 1: "未解决", 2: "已解决", 3: "已关闭" });
}

export function jarvisPriorityLabel(values: readonly number[]): string {
  return labelsOf(values, { 1: "高优先级", 2: "中优先级", 3: "低优先级" });
}

export function jarvisSeverityLabel(values: readonly number[]): string {
  return labelsOf(values, { 1: "致命", 2: "严重", 3: "一般", 4: "低" });
}
