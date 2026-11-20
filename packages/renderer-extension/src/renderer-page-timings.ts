export type RendererPageName = "accounts" | "connections" | "usage-statistics";

export interface RendererPageTiming {
  page: RendererPageName;
  hostId: string | null;
  /** Time the page showed its first frame, measured from the page mount. */
  firstPaintMs: number;
  atMs: number;
}

const MAX_TIMINGS = 24;
const timings: RendererPageTiming[] = [];

function publish(): void {
  try {
    (
      globalThis as {
        __codexhostPageTimingsV1?: readonly RendererPageTiming[];
      }
    ).__codexhostPageTimingsV1 = timings;
  } catch {
    /* Diagnostics must never break a settings page. */
  }
}

/**
 * Records mount-to-first-frame time for a settings page. The first frame is
 * scheduled through `requestAnimationFrame`, so it includes the browser paint
 * rather than only the synchronous render work. Bounded; display data only.
 */
export function recordRendererPageOpen(
  page: RendererPageName,
  startedAt: number,
  hostId: string | null = null,
): void {
  const finish = (): void => {
    const now = performance.now();
    timings.push({
      page,
      hostId,
      firstPaintMs: Math.round(now - startedAt),
      atMs: Math.round(now),
    });
    while (timings.length > MAX_TIMINGS) timings.shift();
    publish();
  };
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(finish);
  } else {
    queueMicrotask(finish);
  }
}

export function rendererPageTimings(): readonly RendererPageTiming[] {
  return timings;
}
