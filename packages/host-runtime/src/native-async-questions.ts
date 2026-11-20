import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "@codexhost/protocol-core";
import { DelegationControlError } from "./delegation-types.js";

type Question = { id: string; prompt: string };
export type NativeQuestionReply =
  { result: JsonValue } | { error: { code: number; message: string } };

/** Preserve native protocol errors and reject an unconfirmed delivery. */
export function nativeQuestionReply(value: JsonObject): NativeQuestionReply {
  if (
    object(value.error) &&
    typeof value.error.code === "number" &&
    typeof value.error.message === "string"
  )
    return { error: { code: value.error.code, message: value.error.message } };
  if ("result" in value) return { result: value.result as JsonValue };
  throw new Error("Codex did not confirm the question reply; delivery outcome is unknown");
}

type Pending = { threadId: string; turnId?: string; request: JsonObject; question: Question };
const object = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keyOf = (threadId: string, questionId: string) => JSON.stringify([threadId, questionId]);
const publicId = (prefix: string, pending: Pending) =>
  `${prefix}async:${keyOf(pending.threadId, pending.question.id)}`;

/** Async questions are native messages, not server requests waiting for a tool result.
 * Keep only a volatile interaction projection; native history remains authoritative. */
export class NativeAsyncQuestions {
  readonly #pending = new Map<string, Pending>();
  readonly #settled = new Map<string, Set<string>>();
  readonly #unconfirmed = new Set<string>();

  #settle(threadId: string, questionId: string): void {
    let settled = this.#settled.get(threadId);
    if (!settled) this.#settled.set(threadId, (settled = new Set()));
    settled.add(questionId);
    this.#pending.delete(keyOf(threadId, questionId));
  }

  #observeItem(threadId: string, item: JsonObject, turnId?: string): void {
    if (item.type === "userMessage" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!object(part) || part.type !== "text" || typeof part.text !== "string") continue;
        const match =
          /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/u.exec(
            part.text,
          );
        const body = match?.[1];
        if (body === undefined) continue;
        try {
          const replies: unknown = JSON.parse(body);
          if (!Array.isArray(replies)) continue;
          for (const reply of replies)
            if (
              object(reply) &&
              typeof reply.questionItemId === "string" &&
              typeof reply.answer === "string"
            )
              this.#settle(threadId, reply.questionItemId);
        } catch {
          // Ordinary or malformed user text cannot resolve a structured question.
        }
      }
    }
    if (
      item.type !== "agentMessage" ||
      item.delivery !== "async" ||
      typeof item.id !== "string" ||
      !Array.isArray(item.questions)
    )
      return;
    const itemId = item.id;
    item.questions.forEach((value, index) => {
      if (!object(value) || typeof value.title !== "string" || !value.title.trim()) return;
      if (
        value.options !== undefined &&
        (!Array.isArray(value.options) ||
          value.options.some((option) => typeof option !== "string" || !option.trim()))
      )
        return;
      const id = JSON.stringify(["request_user_input_async", itemId, index]);
      if (this.#settled.get(threadId)?.has(id)) return;
      const question: Question = { id, prompt: value.title };
      this.#pending.set(keyOf(threadId, id), {
        threadId,
        ...(turnId !== undefined ? { turnId } : {}),
        request: {
          ...value,
          threadId,
          ...(turnId !== undefined ? { turnId } : {}),
          itemId,
          questionItemId: id,
        },
        question,
      });
    });
  }

  observe(method: string, params: JsonObject): boolean {
    if (typeof params.threadId !== "string") return false;
    const before = this.#pending.size;
    if (method === "thread/closed") {
      this.#settled.delete(params.threadId);
      for (const [key, pending] of this.#pending)
        if (pending.threadId === params.threadId) this.#pending.delete(key);
    } else if ((method === "item/started" || method === "item/completed") && object(params.item)) {
      this.#observeItem(
        params.threadId,
        params.item,
        typeof params.turnId === "string" ? params.turnId : undefined,
      );
    }
    return this.#pending.size !== before;
  }

  observeTurns(threadId: string, turns: JsonValue[]): void {
    for (const turn of turns)
      if (object(turn) && Array.isArray(turn.items))
        for (const item of turn.items)
          if (object(item))
            this.#observeItem(threadId, item, typeof turn.id === "string" ? turn.id : undefined);
  }

  pending(threadId: string, prefix: string): (Pending & { requestId: string })[] {
    return [...this.#pending.values()]
      .filter(
        (pending) =>
          pending.threadId === threadId &&
          !this.#unconfirmed.has(keyOf(pending.threadId, pending.question.id)),
      )
      .map((pending) => ({ ...pending, requestId: publicId(prefix, pending) }));
  }

  find(requestId: string, prefix: string): (Pending & { claimed: boolean }) | undefined {
    const pending = [...this.#pending.values()].find(
      (value) => publicId(prefix, value) === requestId,
    );
    return pending
      ? {
          ...pending,
          claimed: this.#unconfirmed.has(keyOf(pending.threadId, pending.question.id)),
        }
      : undefined;
  }

  async respond(
    requestId: string,
    threadId: string,
    result: JsonValue,
    prefix: string,
    request: (method: string, params: JsonObject) => Promise<NativeQuestionReply>,
  ): Promise<boolean> {
    const receiptKey = requestId.startsWith(`${prefix}async:`)
      ? requestId.slice(`${prefix}async:`.length)
      : undefined;
    if (receiptKey !== undefined && this.#unconfirmed.has(receiptKey))
      throw new Error("Native interaction delivery outcome is unknown; do not resend the response");
    const pending = this.find(requestId, prefix);
    if (!pending) return false;
    const key = keyOf(pending.threadId, pending.question.id);
    if (pending.threadId !== threadId)
      throw new Error("Interaction does not belong to this Thread");
    const answers = object(result) && object(result.answers) ? result.answers : undefined;
    const answer = answers?.[pending.question.id];
    if (
      !answers ||
      Object.keys(answers).length !== 1 ||
      !object(answer) ||
      !Array.isArray(answer.answers) ||
      answer.answers.length !== 1 ||
      (answer.answers.length === 1 &&
        (typeof answer.answers[0] !== "string" || !answer.answers[0].trim()))
    )
      throw new Error("Provide one answer to the native async question");

    // Desktop may have answered since the question was read. Refresh before claiming;
    // concurrent responders then compete in one synchronous claim below.
    const page = await request("thread/turns/list", {
      threadId,
      limit: 5,
      sortDirection: "desc",
      itemsView: "full",
    });
    if ("error" in page)
      throw new DelegationControlError("DELEGATION_FAILED", page.error.message, {
        nativeCode: page.error.code,
      });
    if (!object(page.result) || !Array.isArray(page.result.data))
      throw new Error("Codex returned an invalid Turn page");
    this.observeTurns(threadId, page.result.data);
    if (!this.#pending.has(keyOf(threadId, pending.question.id)) || this.#unconfirmed.has(key))
      return false;
    this.#unconfirmed.add(key);
    const active = page.result.data.find(
      (turn) => object(turn) && turn.status === "inProgress" && typeof turn.id === "string",
    );
    const text = `<send_user_message_question_reply>\n${JSON.stringify([
      {
        questionItemId: pending.question.id,
        question: pending.question.prompt,
        answer: answer.answers[0],
      },
    ])}\n</send_user_message_question_reply>\n`;
    const sent = await request(object(active) ? "turn/steer" : "turn/start", {
      threadId,
      ...(object(active) ? { expectedTurnId: active.id } : {}),
      input: [{ type: "text", text, text_elements: [] }],
      clientUserMessageId: randomUUID(),
    });
    if ("error" in sent) {
      // Native validation refusals did not accept input; a refreshed question can be answered again.
      // Transport and generation failures retain the claim because delivery is uncertain.
      if (sent.error.code === -32600 || sent.error.code === -32602) this.#unconfirmed.delete(key);
      throw new DelegationControlError("DELEGATION_FAILED", sent.error.message, {
        nativeCode: sent.error.code,
      });
    }
    if (
      !object(sent.result) ||
      (object(active)
        ? sent.result.turnId !== active.id
        : !object(sent.result.turn) || typeof sent.result.turn.id !== "string")
    )
      throw new Error("Codex did not confirm the question reply; delivery outcome is unknown");
    this.#settle(threadId, pending.question.id);
    this.#unconfirmed.delete(key);
    return true;
  }

  clear(): void {
    this.#pending.clear();
    this.#settled.clear();
    this.#unconfirmed.clear();
  }
}
