// @vitest-environment jsdom
import { threadOwnershipListParamsSchema } from "@codexhost/shared-contracts";
import { assert, expect, it, vi } from "vitest";

import { installRendererBindingProbe } from "../src/renderer-binding-probe.js";
import {
  createRendererModelClient,
  HARNESS_PLUGIN_LIST_METHOD,
  THREAD_OWNERSHIP_LIST_METHOD,
} from "../src/renderer-model-client.js";
import { SIDEBAR_AGENT_ICON_ATTRIBUTE } from "../src/renderer-sidebar-agent-icons.js";

it.each([false, true])(
  "renders sidebar Agent icons with the probe option enabled = %s",
  async (enabled) => {
    document.body.innerHTML = `
    <aside>
      <div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:thread-a"
           data-app-action-sidebar-thread-host-id="local">
        <div data-thread-title-trigger><span data-thread-title>Conversation</span></div>
      </div>
      <div data-sidebar-cycle-item role="button" aria-labelledby="schedule-title">
        <span data-thread-title id="schedule-title">Scheduled conversation</span>
      </div>
    </aside>`;
    const row = document.querySelector("[data-app-action-sidebar-thread-row]");
    const schedule = document.querySelector("[data-sidebar-cycle-item]");
    assert(row && schedule);
    Reflect.set(row, "__reactFiber$fixture", {
      memoizedProps: {
        conversationId: "thread-a",
        dataAttributes: Object.fromEntries(
          Array.from(row.attributes, ({ name, value }) => [name, value]),
        ),
      },
    });
    Reflect.set(schedule, "__reactFiber$fixture", {
      memoizedProps: { "data-selected-scheduled-task": false },
      return: {
        memoizedProps: {
          automation: { kind: "heartbeat", id: "task-a", targetThreadId: "thread-b" },
        },
      },
    });
    const queried = new Set<string>();
    const client = createRendererModelClient([
      {
        async sendRequest(method, params) {
          if (method === HARNESS_PLUGIN_LIST_METHOD) return { plugins: [] };
          if (method !== THREAD_OWNERSHIP_LIST_METHOD) throw new Error(`Unexpected RPC: ${method}`);
          const { threadIds } = threadOwnershipListParamsSchema.parse(params);
          threadIds.forEach((threadId) => queried.add(threadId));
          return {
            threads: threadIds.map((threadId) => ({
              threadId,
              owner: "external",
              harnessId: "pi",
            })),
          };
        },
      },
    ]);
    assert(client);
    vi.useFakeTimers();
    const probe = installRendererBindingProbe(enabled ? {} : { sidebarAgentIcons: false });
    try {
      probe.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
        undefined,
        undefined,
        client,
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(queried).toEqual(new Set(enabled ? ["thread-a", "thread-b"] : []));
      for (const sidebarRow of [row, schedule]) {
        expect(
          sidebarRow
            .querySelector(`[${SIDEBAR_AGENT_ICON_ATTRIBUTE}]`)
            ?.getAttribute(SIDEBAR_AGENT_ICON_ATTRIBUTE),
        ).toBe(enabled ? "pi" : undefined);
      }
    } finally {
      probe.dispose();
      vi.useRealTimers();
      document.body.replaceChildren();
    }
  },
);
