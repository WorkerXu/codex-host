import type { DingTalkMessage } from "@codexhost/shared-contracts";

type Resource = NonNullable<DingTalkMessage["resources"]>[number];

/** Measures the initial transcript and only images requested for its first viewport. */
export function createDingTalkOpenTimings(options: {
  view: Window;
  report(
    conversationId: string,
    paintMs: number,
    renderMs: number | null,
    imagesMs: number | null,
  ): void;
}) {
  const { view } = options;
  interface Probe {
    conversationId: string;
    startedAt: number;
    messages: Set<DingTalkMessage>;
    pending: Set<Resource>;
    hadImages: boolean;
    imagesMs: number | null;
    paintMs: number | null;
    renderMs: number | null;
    timer: number;
  }
  let current: Probe | null = null;
  const elapsed = (probe: Probe): number =>
    Math.max(0, Math.round(view.performance.now() - probe.startedAt));
  const flush = (force = false): void => {
    const probe = current;
    if (!probe || probe.paintMs === null || (!force && probe.pending.size > 0)) return;
    view.clearTimeout(probe.timer);
    current = null;
    options.report(
      probe.conversationId,
      probe.paintMs,
      probe.renderMs,
      probe.hadImages && probe.pending.size === 0 ? probe.imagesMs : null,
    );
  };
  return {
    begin(conversationId: string, messages: readonly DingTalkMessage[], startedAt: number) {
      flush(true);
      if (current) view.clearTimeout(current.timer);
      const probe: Probe = {
        conversationId,
        startedAt,
        messages: new Set(messages),
        pending: new Set(),
        hadImages: false,
        imagesMs: null,
        paintMs: null,
        renderMs: null,
        timer: view.setTimeout(() => {
          if (current === probe) flush(true);
        }, 20_000),
      };
      current = probe;
    },
    imageStarted(message: DingTalkMessage, resource: Resource) {
      if (!current || current.paintMs !== null || !current.messages.has(message)) return;
      current.pending.add(resource);
      current.hadImages = true;
      current.imagesMs = null;
    },
    imageSettled(message: DingTalkMessage, resource: Resource) {
      if (!current?.messages.has(message) || !current.pending.delete(resource)) return;
      if (current.pending.size === 0) current.imagesMs = elapsed(current);
      flush();
    },
    rendered(renderMs: number) {
      const probe = current;
      if (!probe) return;
      probe.renderMs = Math.round(renderMs);
      // The first callback precedes paint. The next frame confirms that text
      // had a paint opportunity and lets the initial image observer run.
      view.requestAnimationFrame(() =>
        view.requestAnimationFrame(() => {
          if (current !== probe) return;
          probe.paintMs = elapsed(probe);
          flush();
        }),
      );
    },
    dispose() {
      flush(true);
      if (current) view.clearTimeout(current.timer);
      current = null;
    },
  };
}
