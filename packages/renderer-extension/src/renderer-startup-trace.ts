/** Bounded milestones of the Renderer's own startup, readable without hooks so a cold
 * start can be measured from the DevTools-free Desktop console. Presentation only:
 * no Session content, no request params, no stored history. */

const MAX_HOSTS = 8;
const MAX_COMPOSERS = 8;
const MAX_REQUESTS = 24;

export type RendererStartupRequestPriority = "interactive" | "background";

export interface RendererStartupRequestSample {
  method: string;
  hostId: string;
  priority: RendererStartupRequestPriority;
  /** `performance.now()` when the request left the Renderer. */
  startedAtMs: number;
  durationMs: number;
  ok: boolean;
}

export interface RendererStartupComposerSample {
  agent: string;
  /** First time the footer could name this Composer's Model, from cache or inspection. */
  namedAtMs?: number;
  /** First time a fresh Host inspection confirmed the footer's Model. */
  readyAtMs?: number;
}

export interface RendererStartupStatus {
  startedAtMs: number;
  /** First time each Host's routing object answered. */
  routingReadyMs: Record<string, number>;
  /** First time sidebar rows existed. */
  firstRowsMs?: number;
  /** First time every live sidebar row displayed its Agent icon. */
  allIconsMs?: number;
  composers: Record<string, RendererStartupComposerSample>;
  requests: RendererStartupRequestSample[];
}

export interface RendererStartupTrace {
  routingReady(hostId: string): void;
  firstRows(count: number): void;
  iconsRendered(rendered: number, live: number): void;
  modelControl(composerId: string, agent: string, source: "cache" | "inspect"): void;
  measureRequest<T>(
    input: {
      method: string;
      hostId: string;
      priority: RendererStartupRequestPriority;
    },
    run: () => Promise<T>,
  ): Promise<T>;
  snapshot(): RendererStartupStatus;
}

const roundMs = (value: number): number => Math.round(value);

export function createRendererStartupTrace(
  now: () => number = () => performance.now(),
): RendererStartupTrace {
  const startedAtMs = roundMs(now());
  const routingReadyMs: Record<string, number> = {};
  const composers: Record<string, RendererStartupComposerSample> = {};
  const requests: RendererStartupRequestSample[] = [];
  let firstRowsMs: number | undefined;
  let allIconsMs: number | undefined;
  let composerCount = 0;
  let hostCount = 0;

  return {
    routingReady(hostId) {
      if (routingReadyMs[hostId] !== undefined || hostCount >= MAX_HOSTS) return;
      routingReadyMs[hostId] = roundMs(now());
      hostCount += 1;
    },
    firstRows(count) {
      if (firstRowsMs !== undefined || count === 0) return;
      firstRowsMs = roundMs(now());
    },
    iconsRendered(rendered, live) {
      if (allIconsMs !== undefined || live === 0 || rendered < live) return;
      allIconsMs = roundMs(now());
    },
    modelControl(composerId, agent, source) {
      let sample = composers[composerId];
      if (!sample) {
        if (composerCount >= MAX_COMPOSERS) return;
        sample = { agent };
        composers[composerId] = sample;
        composerCount += 1;
      }
      sample.agent = agent;
      if (source === "cache") sample.namedAtMs ??= roundMs(now());
      else sample.readyAtMs ??= roundMs(now());
    },
    async measureRequest(input, run) {
      const startedAtMs = now();
      let ok = false;
      try {
        const result = await run();
        ok = true;
        return result;
      } finally {
        requests.push({
          method: input.method,
          hostId: input.hostId,
          priority: input.priority,
          startedAtMs: roundMs(startedAtMs),
          durationMs: roundMs(now() - startedAtMs),
          ok,
        });
        if (requests.length > MAX_REQUESTS) requests.shift();
      }
    },
    snapshot() {
      return {
        startedAtMs,
        routingReadyMs: { ...routingReadyMs },
        ...(firstRowsMs !== undefined ? { firstRowsMs } : {}),
        ...(allIconsMs !== undefined ? { allIconsMs } : {}),
        composers: Object.fromEntries(
          Object.entries(composers).map(([composerId, sample]) => [composerId, { ...sample }]),
        ),
        requests: requests.map((sample) => ({ ...sample })),
      };
    },
  };
}
