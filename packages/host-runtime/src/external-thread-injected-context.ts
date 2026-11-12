/**
 * Desktop injects model-visible context into a Thread with `thread/inject_items`
 * (the side-chat boundary after a fork, app context before a Turn). External
 * Harnesses take text Turns only, so the Host keeps the injected text and
 * prefixes it to the next Turn sent to the Harness. The visible user input is
 * not changed.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_INJECTED_CONTEXT_CHARS = 64 * 1024;

/** Text of the message items, in order. Throws when `items` is not an array. */
export function injectedContextText(items: unknown): string[] {
  if (!Array.isArray(items)) throw new Error("items must be an array");
  const texts: string[] = [];
  for (const item of items) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    const text = item.content
      .map((part) =>
        isRecord(part) &&
        (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
        typeof part.text === "string"
          ? part.text
          : "",
      )
      .filter((part) => part.trim().length > 0)
      .join("\n");
    if (text.trim().length > 0) texts.push(text);
  }
  return texts;
}

export class ExternalThreadInjectedContext {
  readonly #pending = new Map<string, string[]>();

  add(threadId: string, texts: readonly string[]): void {
    if (texts.length === 0) return;
    const next = [...(this.#pending.get(threadId) ?? []), ...texts];
    let total = next.reduce((sum, text) => sum + text.length, 0);
    // Keep the newest context when Desktop keeps injecting into an idle Thread.
    while (next.length > 1 && total > MAX_INJECTED_CONTEXT_CHARS) {
      total -= next.shift()?.length ?? 0;
    }
    this.#pending.set(threadId, next);
  }

  /** Take the pending context; call the returned restore if the Turn is rejected. */
  take(threadId: string): { prefix: string; restore(): void } | null {
    const texts = this.#pending.get(threadId);
    if (!texts?.length) return null;
    this.#pending.delete(threadId);
    return {
      prefix: texts.join("\n\n"),
      restore: () => {
        const later = this.#pending.get(threadId) ?? [];
        this.#pending.set(threadId, [...texts, ...later]);
      },
    };
  }

  delete(threadId: string): void {
    this.#pending.delete(threadId);
  }
}

export function withInjectedContext(prefix: string | undefined, text: string): string {
  return prefix ? `${prefix}\n\n---\n\n${text}` : text;
}
