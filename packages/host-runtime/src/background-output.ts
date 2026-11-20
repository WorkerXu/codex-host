import type { JsonObject } from "@codexhost/protocol-core";
import { REASONING_TRANSCRIPT_COMMAND } from "@codexhost/shared-contracts";

export function backgroundItemText(item: JsonObject): string | null {
  if (item.type === "agentMessage" && typeof item.text === "string") return item.text;
  if (item.type === "reasoning" && Array.isArray(item.summary)) {
    return item.summary.every((part) => typeof part === "string") ? item.summary.join("") : null;
  }
  return null;
}

function longestSuffixPrefixOverlap(historical: string, live: string): number {
  for (let size = Math.min(historical.length, live.length); size > 0; size -= 1) {
    if (historical.endsWith(live.slice(0, size))) return size;
  }
  return 0;
}

function withBackgroundItemText(item: JsonObject, text: string): JsonObject {
  if (item.type !== "reasoning") return { ...item, text: `${item.text}${text}` };
  const summary = Array.isArray(item.summary) ? item.summary : [];
  const last = summary.at(-1);
  return {
    ...item,
    summary:
      typeof last === "string" ? [...summary.slice(0, -1), `${last}${text}`] : [...summary, text],
  };
}

interface BackgroundTextRunItem {
  index: number;
  text: string;
  start: number;
}

interface BackgroundTextRun {
  items: BackgroundTextRunItem[];
  text: string;
}

function backgroundTextCandidates(
  items: readonly JsonObject[],
  count: number,
  type: string,
): BackgroundTextRun | null {
  const run: BackgroundTextRunItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = items[index];
    if (item?.type === "commandExecution" && item.command === REASONING_TRANSCRIPT_COMMAND)
      continue;
    const itemText = item && item.type === type ? backgroundItemText(item) : null;
    if (itemText !== null) run.push({ index, text: itemText, start: 0 });
  }
  if (run.length === 0) return null;
  let start = 0;
  for (const item of run) {
    item.start = start;
    start += item.text.length;
  }
  return { items: run, text: backgroundTextRun(run) };
}

function backgroundTextRun(items: readonly BackgroundTextRunItem[]): string {
  return items.map((item) => item.text).join("");
}

export function alignBackgroundTextRun(
  items: JsonObject[],
  historicalCount: number,
  type: string,
  liveText: string,
  consumedEnd: number,
  foregroundItems: readonly JsonObject[],
  allowPartialTail: boolean,
): number | null {
  const run = backgroundTextCandidates(items, historicalCount, type);
  if (!run) return null;
  const foregroundRun = backgroundTextCandidates(foregroundItems, foregroundItems.length, type);
  const foregroundText = foregroundRun?.text ?? "";
  if (!run.text.startsWith(foregroundText)) return null;
  const searchStart = Math.max(consumedEnd, foregroundText.length);
  const exactStart = run.text.indexOf(liveText, searchStart);
  if (exactStart >= 0) return exactStart + liveText.length;

  // A short prefix is unambiguous only at the next unread position in the
  // final replay Item, with no earlier live Item left unmatched.
  const tail = run.items.at(-1);
  if (allowPartialTail && tail && searchStart >= tail.start) {
    const lastIndex = items.findLastIndex(
      (item) => item.type !== "commandExecution" || item.command !== REASONING_TRANSCRIPT_COMMAND,
    );
    const prefix = run.text.slice(searchStart);
    const historical = items[lastIndex];
    if (tail.index === lastIndex && historical && prefix && liveText.startsWith(prefix)) {
      const suffix = liveText.slice(prefix.length);
      items[lastIndex] = withBackgroundItemText(historical, suffix);
      const transcript = items[lastIndex + 1];
      if (type === "reasoning" && transcript?.command === REASONING_TRANSCRIPT_COMMAND) {
        items[lastIndex + 1] = { ...transcript, aggregatedOutput: tail.text + suffix };
      }
      return searchStart + liveText.length;
    }
  }

  for (const item of run.items) {
    if (item.start < searchStart) continue;
    const overlap = longestSuffixPrefixOverlap(item.text, liveText);
    if (overlap < 2) continue;
    const historical = items[item.index];
    if (!historical) return null;
    items[item.index] = withBackgroundItemText(historical, liveText.slice(overlap));
    return item.start + item.text.length + liveText.length - overlap;
  }
  return null;
}
