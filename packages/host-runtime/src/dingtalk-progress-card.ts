import {
  dingtalkMentionLine,
  dingtalkStepStatus,
  type DingTalkCardPhase,
  type DingTalkCardState,
  type DingTalkCardStep,
} from "./dingtalk-a2ui.js";
import type { DingTalkCardInput, DingTalkCardResult, DingTalkCardUpdate } from "./dingtalk-cli.js";
import type { DingTalkProgressEvent, DingTalkProgressStep } from "./dingtalk-dispatch-types.js";

interface CardService {
  sendCard(input: DingTalkCardInput): Promise<DingTalkCardResult>;
  updateCard(input: DingTalkCardUpdate): Promise<{ ok: boolean }>;
}

/** A stopped step ends without a success check or a false loading indicator. */
function settleSteps(steps: readonly DingTalkCardStep[], completed: boolean): DingTalkCardStep[] {
  return steps.map((step) =>
    step.status === "running" ? { ...step, status: completed ? "done" : "stopped" } : step,
  );
}

/** Serial writes to one server-created card; any uncertain result stops further writes. */
export class DingTalkProgressCard {
  #bizId: string | null = null;
  #stopped = false;
  #finished = false;
  #queue = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastWrite = Date.now();
  #state: DingTalkCardState = {
    phase: "running",
    steps: [],
    status: "正在准备…",
    answer: "",
    mentions: null,
  };
  #revision = 0;
  #written = 0;
  #writing = false;

  constructor(readonly service: CardService) {}

  async create(
    input: Omit<DingTalkCardInput, "state">,
    first: DingTalkProgressStep,
  ): Promise<boolean> {
    this.#state = {
      phase: "running",
      steps: [{ ...first }],
      status: dingtalkStepStatus(first.kind),
      answer: "",
      mentions:
        "group" in input.target
          ? dingtalkMentionLine(
              input.atOpenDingTalkIds ?? [],
              input.atAll === true,
              input.atNames ?? {},
            )
          : null,
    };
    this.#revision = 1;
    const result = await this.service
      .sendCard({
        ...input,
        state: this.#state,
      })
      .catch(() => null);
    if (!result?.ok || !result.bizId) {
      this.#stopped = true;
      return false;
    }
    this.#bizId = result.bizId;
    this.#lastWrite = Date.now();
    return true;
  }

  /** Marks the context read that the Host performs before the Turn starts. */
  contextRead(count: number): void {
    if (this.#finished || this.#stopped) return;
    const previous = this.#state.steps.find((step) => step.id === "context");
    this.#updateStep({
      id: "context",
      kind: "context",
      title: previous?.title ?? "读取会话上下文",
      detail: count > 0 ? `已读取 ${count} 条更早消息` : "没有更早的消息",
      status: "done",
    });
    this.#state = { ...this.#state, status: "正在启动智能体…" };
    this.#touch();
  }

  progress(event: DingTalkProgressEvent): void {
    if (this.#finished || this.#stopped) return;
    if (event.type === "status") {
      if (!event.text.trim()) return;
      this.#state = { ...this.#state, status: event.text.trim().slice(0, 80) };
      this.#touch();
      return;
    }
    this.#updateStep(event.step);
    if (event.step.status === "running") {
      this.#state = { ...this.#state, status: dingtalkStepStatus(event.step.kind) };
    }
    this.#touch();
  }

  #updateStep(step: DingTalkProgressStep): void {
    const index = this.#state.steps.findIndex((entry) => entry.id === step.id);
    if (index >= 0) {
      const steps = [...this.#state.steps];
      steps[index] = { ...step };
      this.#state = { ...this.#state, steps };
      return;
    }
    this.#state = { ...this.#state, steps: [...this.#state.steps, { ...step }] };
  }

  #touch(): void {
    this.#revision += 1;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer || this.#writing || this.#finished || this.#stopped) return;
    if (this.#revision === this.#written) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        void this.#flush();
      },
      Math.max(0, 5_000 - (Date.now() - this.#lastWrite)),
    );
    this.#timer.unref?.();
  }

  async #flush(): Promise<void> {
    if (this.#stopped || this.#finished || !this.#bizId) return;
    const revision = this.#revision;
    this.#writing = true;
    await this.#enqueue("INPUTTING", this.#state);
    this.#writing = false;
    this.#written = revision;
    if (this.#revision > revision) this.#schedule();
  }

  #enqueue(flowStatus: "INPUTTING" | "FINISH", state: DingTalkCardState): Promise<void> {
    this.#queue = this.#queue.then(async () => {
      if (this.#stopped || !this.#bizId) return;
      const result = await this.service
        .updateCard({ bizId: this.#bizId, state, flowStatus })
        .catch(() => null);
      this.#lastWrite = Date.now();
      if (!result?.ok) this.#stopped = true;
    });
    return this.#queue;
  }

  async finish(phase: Exclude<DingTalkCardPhase, "running">, answer: string): Promise<boolean> {
    this.#finished = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#state = {
      ...this.#state,
      phase,
      answer,
      steps: settleSteps(this.#state.steps, phase === "completed"),
    };
    this.#revision += 1;
    await this.#enqueue("FINISH", this.#state);
    return !this.#stopped;
  }

  dispose(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
