import type {
  DingTalkDispatchAgentStatus,
  DingTalkDispatchStatus,
} from "@codexhost/shared-contracts";

/** Manual dispatch results live only for this Host process, bounded to 64 agents. */
export class DingTalkDispatchStateStore {
  #status: DingTalkDispatchStatus = {};

  async status(): Promise<DingTalkDispatchStatus> {
    return this.#status;
  }

  async setStatus(fileName: string, value: DingTalkDispatchAgentStatus): Promise<void> {
    this.#status[fileName] = value;
    this.#status = Object.fromEntries(
      Object.entries(this.#status)
        .sort((a, b) => b[1].lastDispatchAt - a[1].lastDispatchAt)
        .slice(0, 64),
    );
  }
}
