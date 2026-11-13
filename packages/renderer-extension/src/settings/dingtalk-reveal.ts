/** Notifies a mounted page, or queues the target for the next mount. */
const PENDING_KEY = "__codexhostDingTalkRevealV1";

export interface DingTalkRevealTarget {
  conversationId?: string;
  messageIds?: string[];
}

export function requestDingTalkReveal(target: DingTalkRevealTarget): void {
  (window as Window & { [PENDING_KEY]?: DingTalkRevealTarget })[PENDING_KEY] = target;
  window.dispatchEvent(new CustomEvent("codexhost:dingtalk-reveal", { detail: target }));
}

export function consumeDingTalkReveal(): DingTalkRevealTarget | null {
  const holder = window as Window & { [PENDING_KEY]?: DingTalkRevealTarget };
  const target = holder[PENDING_KEY] ?? null;
  Reflect.deleteProperty(holder, PENDING_KEY);
  return target;
}
