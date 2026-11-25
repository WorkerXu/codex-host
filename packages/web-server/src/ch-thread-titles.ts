import {
  THREAD_NAME_AUTO_SOURCE_PARAM,
  threadTitleResultSchema,
  parseHostExtensionMentions,
} from "@codexhost/shared-contracts";
import type { ChHostClient } from "./ch-host-client.ts";
import type { ChThread } from "./ch-thread-view.ts";

function firstPromptTitle(prompt: string): string {
  const characters = Array.from(prompt.replace(/\s+/gu, " ").trim());
  return characters.length > 60 ? `${characters.slice(0, 60).join("")}…` : characters.join("");
}

/** An optional title request never changes the result of the accepted first message. */
export async function tryGenerateThreadTitle(
  host: ChHostClient,
  row: ChThread,
  prompt: string,
  external: boolean,
  isCurrent: () => boolean,
): Promise<boolean> {
  const expectedName = row.name ?? "";
  const parsed = parseHostExtensionMentions(prompt);
  // Keep the whole carrier until parsing completes; a bounded title input may cut its payload.
  let cursor = 0;
  let display = "";
  for (const mention of parsed.mentions) {
    display += prompt.slice(cursor, mention.start) + `@${mention.label}`;
    cursor = mention.end;
  }
  display += prompt.slice(cursor);
  const input = display.trim().slice(0, 2000);
  const hasMentions = parsed.mentions.length > 0 && !parsed.invalid;
  if (!input || !isCurrent() || (external && expectedName)) return false;
  let generated: string | null;
  try {
    generated = threadTitleResultSchema.parse(
      await host.request("codexhost/thread/title/generate", {
        prompt: input,
        cwd: row.cwd || null,
      }),
    );
  } catch {
    generated = null;
  }
  // A native thread's own preview is the expanded mention context, so a message with mentions
  // falls back to its user-facing text (labels plus the user's words) when no title is generated.
  const title = generated ?? (external || hasMentions ? firstPromptTitle(input) : null);
  if (!title || !isCurrent()) return false;
  try {
    const { thread } = await host.request<{ thread: ChThread }>("thread/read", {
      threadId: row.id,
      includeTurns: false,
    });
    if (!isCurrent() || (thread.name ?? "") !== expectedName) return false;
    await host.request("thread/name/set", {
      threadId: row.id,
      name: title,
      ...(external
        ? { [THREAD_NAME_AUTO_SOURCE_PARAM]: generated === null ? "fallback" : "generated" }
        : {}),
    });
    return true;
  } catch {
    // An unknown write outcome must not trigger a second name write.
    return false;
  }
}
