/**
 * Readable one-line summaries for DingTalk bodies the workbench cannot render
 * as text: group-chain cards, interactive cards and raw JSON payloads. The
 * Host list preview, the transcript and the dispatch panel share this so the
 * same message reads the same everywhere.
 */

export interface DingTalkCardSummary {
  /** Short type label such as 群接龙 or 卡片. */
  label: string;
  title: string;
  description: string;
}

const URL_PATTERN = /(?:dingtalk|https?):\/\/\S+/iu;
const CHAIN_HEADER = /^\s*chains\s*$/iu;
const JSON_LINE = /^\s*[[{]/u;
const TYPED_TEXT =
  /"text"\s*:\s*\{\s*"zh_Hans"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}\s*,\s*"type"\s*:\s*"([A-Z]+)"/gu;
const ZH_TEXT = /"zh_Hans"\s*:\s*"((?:\\.|[^"\\])*)"/gu;
const CHAIN_MARKER = /(?:enroll_chains|"id"\s*:\s*"chains")/iu;
const SPACE = /\s+/gu;
const MAX_TITLE = 60;
const MAX_DESCRIPTION = 80;

function decoded(value: string): string {
  return value
    .replace(/\\"/gu, '"')
    .replace(/\\n/gu, " ")
    .replace(/\\u([\da-f]{4})/giu, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(SPACE, " ")
    .trim();
}

function clamp(value: string, limit: number): string {
  const text = value.replace(SPACE, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function jsonValue(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function textIn(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const text = (value as { text?: unknown }).text;
  if (typeof text !== "object" || text === null) return "";
  const zh = (text as { zh_Hans?: unknown }).zh_Hans;
  return typeof zh === "string" ? decoded(zh) : "";
}

/** Typed texts such as TITLE / DESCRIPTION, in payload order. */
function typedTexts(value: unknown, out: { type: string; text: string }[]): void {
  if (Array.isArray(value)) {
    for (const item of value) typedTexts(item, out);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const text = textIn(record);
  if (type && text) out.push({ type, text });
  for (const [key, child] of Object.entries(record)) {
    if (key === "text" || typeof child !== "object" || child === null) continue;
    typedTexts(child, out);
  }
}

/** Every `zh_Hans` value in a line, in order; the fallback for untyped cards. */
function zhTexts(line: string): string[] {
  const texts: string[] = [];
  const parsed = jsonValue(line);
  if (parsed !== null) {
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      const zh = record.zh_Hans;
      if (typeof zh === "string" && zh.trim()) texts.push(decoded(zh));
      for (const [key, child] of Object.entries(record)) {
        if (key === "zh_Hans" || typeof child !== "object" || child === null) continue;
        walk(child);
      }
    };
    walk(parsed);
  }
  if (texts.length === 0) {
    for (const match of line.matchAll(ZH_TEXT)) {
      const text = decoded(match[1] ?? "");
      if (text) texts.push(text);
    }
  }
  return texts;
}

/** `陈忆莲发起，已有15人参加` → `已有15人参加`; the initiator is not the payload. */
function chainDescription(value: string): string {
  const match = /^.+发起[，,]\s*(.+)$/u.exec(value);
  return clamp(match?.[1] ?? value, MAX_DESCRIPTION);
}

/**
 * The compact summary for a group-chain or interactive card body, or null
 * when the body is ordinary text. Never returns raw JSON or a URL.
 */
export function parseDingTalkCardSummary(body: string): DingTalkCardSummary | null {
  const lines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const chain = CHAIN_HEADER.test(lines[0] ?? "");
  const typed: { type: string; text: string }[] = [];
  const untyped: string[] = [];
  let mentionsChain = false;
  for (const line of lines) {
    const value = jsonValue(line);
    if (value !== null) typedTexts(value, typed);
    for (const match of line.matchAll(TYPED_TEXT)) {
      typed.push({ type: match[2] ?? "", text: decoded(match[1] ?? "") });
    }
    const texts = zhTexts(line);
    untyped.push(...texts);
    if (CHAIN_MARKER.test(line) || texts.some((text) => /群接龙/u.test(text))) {
      mentionsChain = true;
    }
  }

  let title = typed.find((entry) => entry.type === "TITLE")?.text ?? "";
  let description = typed.find((entry) => entry.type === "DESCRIPTION")?.text ?? "";
  if (!title) {
    // A generic card may expose only `zh_Hans` text, without a TITLE block.
    const unique = [...new Set(untyped)].filter((text) => !/^群接龙$/u.test(text));
    title = unique[0] ?? "";
    description = description || (unique[1] ?? "");
  }

  if (chain || mentionsChain) {
    return {
      label: "群接龙",
      title: clamp(title || "群接龙", MAX_TITLE),
      description: chainDescription(description),
    };
  }
  if (!title) return null;
  return {
    label: "卡片",
    title: clamp(title, MAX_TITLE),
    description: clamp(description, MAX_DESCRIPTION),
  };
}

/** `[群接龙] 嗑瓜子大赛报名接龙 · 已有15人参加`. */
export function formatDingTalkCardSummary(summary: DingTalkCardSummary): string {
  const body = [summary.title, summary.description].filter(Boolean).join(" · ");
  return body ? `[${summary.label}] ${body}` : `[${summary.label}] 在手机上查看`;
}

function isPayloadLine(line: string): boolean {
  return JSON_LINE.test(line) || URL_PATTERN.test(line) || CHAIN_HEADER.test(line);
}

/**
 * Collapses a body to one readable line. Card payloads become their summary;
 * JSON lines and long links are dropped rather than displayed.
 */
export function compactDingTalkPreview(body: string, limit = 160): string {
  const card = parseDingTalkCardSummary(body);
  if (card) return formatDingTalkCardSummary(card);
  const kept = body
    .split(/\r?\n/u)
    .map((line) => line.replace(URL_PATTERN, " ").replace(SPACE, " ").trim())
    .filter((line) => line.length > 0 && !isPayloadLine(line));
  const text = clamp(kept.join(" "), limit);
  return text || "在手机上查看";
}
