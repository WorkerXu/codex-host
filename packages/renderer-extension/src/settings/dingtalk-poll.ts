/** Event notifications are primary; this only covers a missed or stopped stream. */
export const DINGTALK_POLL_CONVERSATION_MS = 10_000;
export const DINGTALK_POLL_LIST_MS = 30_000;

export interface DingTalkPollOptions {
  isVisible(): boolean;
  pollConversation(): void | Promise<void>;
  pollList(): void | Promise<void>;
  setTimer?(run: () => void, milliseconds: number): number;
  clearTimer?(id: number): void;
  conversationMs?: number;
  listMs?: number;
}

export interface DingTalkPoll {
  /** Immediate refresh, used when the page becomes visible again. */
  pollNow(): void;
  stop(): void;
}

/**
 * Lightweight visible-page polling. Each tick reads the Host; nothing is
 * cached, and a slow request never starts a second overlapping read.
 */
export function startDingTalkPoll(options: DingTalkPollOptions): DingTalkPoll {
  const setTimer =
    options.setTimer ??
    ((run, milliseconds) => globalThis.setInterval(run, milliseconds) as unknown as number);
  const clearTimer =
    options.clearTimer ?? ((id) => globalThis.clearInterval(id as unknown as number));
  const conversationMs = options.conversationMs ?? DINGTALK_POLL_CONVERSATION_MS;
  const listMs = options.listMs ?? DINGTALK_POLL_LIST_MS;
  let conversationBusy = false;
  let listBusy = false;
  let stopped = false;

  const tickConversation = (): void => {
    if (stopped || conversationBusy || !options.isVisible()) return;
    conversationBusy = true;
    void Promise.resolve()
      .then(() => options.pollConversation())
      .catch(() => undefined)
      .finally(() => {
        conversationBusy = false;
      });
  };

  const tickList = (): void => {
    if (stopped || listBusy || !options.isVisible()) return;
    listBusy = true;
    void Promise.resolve()
      .then(() => options.pollList())
      .catch(() => undefined)
      .finally(() => {
        listBusy = false;
      });
  };

  const conversationTimer = setTimer(tickConversation, conversationMs);
  const listTimer = setTimer(tickList, listMs);

  return {
    pollNow() {
      tickConversation();
      tickList();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(conversationTimer);
      clearTimer(listTimer);
    },
  };
}
