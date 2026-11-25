import {
  HOST_EXTENSION_MENTION_CANCEL_METHOD,
  HOST_EXTENSION_MENTION_EXPAND_METHOD,
  HOST_EXTENSION_MENTION_MAX_EXPANDED_CHARS,
  HOST_EXTENSION_MENTION_MAX_TOTAL_EXPANDED_CHARS,
  HOST_EXTENSION_MENTION_SEARCH_METHOD,
  HOST_EXTENSIONS_RPC as RPC,
  hostExtensionMentionCancelResultSchema,
  hostExtensionMentionExpandResultSchema,
  hostExtensionMentionSearchResultSchema,
  parseHostExtensionMentions,
  type HostExtensionMentionSource,
  type HostExtensionMentionToken,
  type HostExtensionsRpcParams,
  type HostExtensionsRpcResult,
} from "@codexhost/shared-contracts";
import { errorMessage } from "./desktop-rpc.js";

const DEFAULT_SEARCH_TIMEOUT_MS = 3_000;

export interface HostExtensionMentionBackend {
  readonly id: string;
  readonly sources: readonly HostExtensionMentionSource[];
  invoke(method: string, params: unknown): Promise<unknown>;
}

export type HostExtensionMentionBackendResolution =
  { readonly backend: HostExtensionMentionBackend } | { readonly error: string };

export interface HostExtensionMentionsOptions {
  listBackends(): Promise<readonly HostExtensionMentionBackend[]>;
  resolveBackend(id: string): Promise<HostExtensionMentionBackendResolution>;
  diagnose(message: string): void;
  searchTimeoutMs?: number;
}

class MentionSearchTimeoutError extends Error {}
class MentionExpansionError extends Error {}

function mentionKey(mention: Pick<HostExtensionMentionToken, "sourceId" | "itemId">): string {
  return `${mention.sourceId}\u0000${mention.itemId}`;
}

function describeMention(mention: Pick<HostExtensionMentionToken, "label">): string {
  return `"@${mention.label}"`;
}

/**
 * Extension-provided @ mentions: search is request/response with best-effort
 * cancellation, while expansion happens inside the Host before any Turn starts.
 */
export class HostExtensionMentions {
  readonly #options: HostExtensionMentionsOptions;
  readonly #searchTimeoutMs: number;

  constructor(options: HostExtensionMentionsOptions) {
    this.#options = options;
    this.#searchTimeoutMs = options.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  }

  async search(
    input: HostExtensionsRpcParams<typeof RPC.mentionsSearch>,
  ): Promise<HostExtensionsRpcResult<typeof RPC.mentionsSearch>> {
    const backends = await this.#options.listBackends();
    const groups = await Promise.all(
      backends.flatMap((backend) =>
        backend.sources.map(async (source) => {
          try {
            const result = hostExtensionMentionSearchResultSchema.parse(
              await this.#withTimeout(
                backend.invoke(HOST_EXTENSION_MENTION_SEARCH_METHOD, {
                  requestId: input.requestId,
                  sourceId: source.id,
                  query: input.query,
                  limit: input.limit ?? 20,
                }),
                this.#searchTimeoutMs,
              ),
            );
            return {
              extensionId: backend.id,
              sourceId: source.id,
              label: source.label,
              items: result.items.slice(0, input.limit ?? 20),
            };
          } catch (error) {
            if (error instanceof MentionSearchTimeoutError) {
              this.#cancelSearch(backend, input.requestId);
              return undefined;
            }
            return {
              extensionId: backend.id,
              sourceId: source.id,
              label: source.label,
              items: [],
              error: errorMessage(error).slice(0, 2048),
            };
          }
        }),
      ),
    );
    return { groups: groups.filter((group) => group !== undefined) };
  }

  async cancel(
    input: HostExtensionsRpcParams<typeof RPC.mentionsCancel>,
  ): Promise<HostExtensionsRpcResult<typeof RPC.mentionsCancel>> {
    const backends = await this.#options.listBackends();
    await Promise.allSettled(
      backends.map((backend) =>
        backend.invoke(HOST_EXTENSION_MENTION_CANCEL_METHOD, { requestId: input.requestId }),
      ),
    );
    return { cancelled: true };
  }

  /** Expand every carrier, or reject the whole submission without partial output. */
  async expandTexts(texts: readonly string[]): Promise<string[]> {
    const parsed = texts.map(parseHostExtensionMentions);
    if (parsed.some(({ invalid }) => invalid))
      throw new MentionExpansionError(
        "Cannot expand Host extension mentions: the message contains a malformed mention token. The message was not sent.",
      );
    const mentions = parsed.flatMap(({ mentions }) => mentions);
    if (mentions.length === 0) return [...texts];

    const byExtension = new Map<string, typeof mentions>();
    for (const mention of mentions) {
      const group = byExtension.get(mention.extensionId) ?? [];
      group.push(mention);
      byExtension.set(mention.extensionId, group);
    }

    const expansions = new Map<string, string>();
    await Promise.all(
      [...byExtension].map(async ([extensionId, references]) => {
        const resolution = await this.#options.resolveBackend(extensionId);
        if ("error" in resolution)
          throw new MentionExpansionError(
            `Cannot expand ${describeMention(references[0]!)}: ${resolution.error}. The message was not sent.`,
          );
        const backend = resolution.backend;
        for (const reference of references) {
          if (!backend.sources.some(({ id }) => id === reference.sourceId))
            throw new MentionExpansionError(
              `Cannot expand ${describeMention(reference)}: extension "${extensionId}" does not declare mention source "${reference.sourceId}". The message was not sent.`,
            );
        }
        const requested = new Map(
          references.map((reference) => [
            mentionKey(reference),
            {
              sourceId: reference.sourceId,
              itemId: reference.itemId,
              label: reference.label,
            },
          ]),
        );
        let result: ReturnType<typeof hostExtensionMentionExpandResultSchema.parse>;
        try {
          result = hostExtensionMentionExpandResultSchema.parse(
            await backend.invoke(HOST_EXTENSION_MENTION_EXPAND_METHOD, {
              mentions: [...requested.values()],
            }),
          );
        } catch (error) {
          throw new MentionExpansionError(
            `Cannot expand ${describeMention(references[0]!)}: ${errorMessage(error)}. The message was not sent.`,
          );
        }
        if (result.expansions.length !== requested.size)
          throw new MentionExpansionError(
            `Cannot expand ${describeMention(references[0]!)}: extension "${extensionId}" returned an incomplete expansion. The message was not sent.`,
          );
        const returned = new Set<string>();
        for (const expansion of result.expansions) {
          const key = mentionKey(expansion);
          if (!requested.has(key) || returned.has(key))
            throw new MentionExpansionError(
              `Cannot expand ${describeMention(references[0]!)}: extension "${extensionId}" returned an unexpected expansion. The message was not sent.`,
            );
          if (expansion.text.length > HOST_EXTENSION_MENTION_MAX_EXPANDED_CHARS)
            throw new MentionExpansionError(
              `Cannot expand ${describeMention(references[0]!)}: the expansion exceeds ${HOST_EXTENSION_MENTION_MAX_EXPANDED_CHARS.toLocaleString()} characters. The message was not sent.`,
            );
          returned.add(key);
          expansions.set(key, expansion.text);
        }
      }),
    );

    let totalCharacters = 0;
    const output = texts.map((text, index) => {
      let cursor = 0;
      let expanded = "";
      for (const reference of parsed[index]!.mentions) {
        const replacement = expansions.get(mentionKey(reference));
        if (replacement === undefined)
          throw new MentionExpansionError(
            `Cannot expand ${describeMention(reference)}: the expansion is missing. The message was not sent.`,
          );
        totalCharacters += replacement.length;
        if (totalCharacters > HOST_EXTENSION_MENTION_MAX_TOTAL_EXPANDED_CHARS)
          throw new MentionExpansionError(
            `Cannot expand Host extension mentions: the combined expansion exceeds ${HOST_EXTENSION_MENTION_MAX_TOTAL_EXPANDED_CHARS.toLocaleString()} characters. The message was not sent.`,
          );
        expanded += text.slice(cursor, reference.start) + replacement;
        cursor = reference.end;
      }
      return expanded + text.slice(cursor);
    });
    this.#options.diagnose(
      `Host extension mentions: expanded ${mentions.length} mention(s) across ${byExtension.size} extension(s), ${totalCharacters} characters`,
    );
    return output;
  }

  #cancelSearch(backend: HostExtensionMentionBackend, requestId: string): void {
    try {
      void backend
        .invoke(HOST_EXTENSION_MENTION_CANCEL_METHOD, { requestId })
        .then((value) => hostExtensionMentionCancelResultSchema.parse(value))
        .catch((error: unknown) =>
          this.#options.diagnose(
            `Host extension mention search cancel (${backend.id}): ${errorMessage(error)}`,
          ),
        );
    } catch (error) {
      this.#options.diagnose(
        `Host extension mention search cancel (${backend.id}): ${errorMessage(error)}`,
      );
    }
  }

  async #withTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new MentionSearchTimeoutError()), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
