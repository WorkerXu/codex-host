import type { DingTalkCardInput, DingTalkCardResult, DingTalkCardUpdate } from "./dingtalk-cli.js";

interface CardService {
  sendCard(input: DingTalkCardInput): Promise<DingTalkCardResult>;
  updateCard(input: DingTalkCardUpdate): Promise<{ ok: boolean }>;
}

/** Serial writes to one server-created card; any uncertain result stops further writes. */
export class DingTalkProgressCard {
  #bizId: string | null = null;
  #stopped = false;
  #finished = false;
  #queue = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastWrite = Date.now();
  #steps: string[] = [];
  constructor(readonly service: CardService) {}

  async create(input: Omit<DingTalkCardInput, "content">): Promise<boolean> {
    const result = await this.service.sendCard({ ...input, content: "思考中…" }).catch(() => null);
    if (!result?.ok || !result.bizId) {
      this.#stopped = true;
      return false;
    }
    this.#bizId = result.bizId;
    this.#lastWrite = Date.now();
    return true;
  }

  progress(text: string): void {
    if (this.#finished || this.#stopped || !text.trim()) return;
    const step = text.trim().slice(0, 300);
    if (this.#steps.at(-1) === step) return;
    this.#steps.push(step);
    if (this.#timer) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.#enqueue("INPUTTING", () => this.#steps.join("\n\n"));
      },
      Math.max(0, 5_000 - (Date.now() - this.#lastWrite)),
    );
    this.#timer.unref?.();
  }

  #enqueue(flowStatus: "INPUTTING" | "FINISH", content: () => string): void {
    this.#queue = this.#queue.then(async () => {
      if (this.#stopped || !this.#bizId) return;
      const result = await this.service
        .updateCard({ bizId: this.#bizId, content: content(), flowStatus })
        .catch(() => null);
      this.#lastWrite = Date.now();
      if (!result?.ok) this.#stopped = true;
    });
  }

  async finish(content: string, success: boolean): Promise<boolean> {
    this.#finished = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#enqueue("FINISH", () => (success ? content : [...this.#steps, content].join("\n\n")));
    await this.#queue;
    return !this.#stopped;
  }

  dispose(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
