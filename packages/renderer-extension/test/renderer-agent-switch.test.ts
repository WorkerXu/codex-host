import { afterEach, describe, expect, it, vi } from "vitest";

import { THREAD_AGENT_SWITCH_METHOD } from "@codexhost/shared-contracts";

import {
  rendererAgentPickerTooltip,
  rendererAgentPickerView,
} from "../src/renderer-agent-picker.js";
import {
  createAgentSwitchTurnStarter,
  pendingAgentSwitches,
} from "../src/renderer-agent-switch.js";

afterEach(() => {
  pendingAgentSwitches.clear("remote", "thread-1");
  pendingAgentSwitches.clear("local", "thread-1");
});

describe("Agent picker of an existing conversation", () => {
  const agents = ["codex", "claude-code", "grok"];
  const availability = { "claude-code": "ready", grok: "notInstalled" } as const;

  it("stays locked unless the conversation can switch", () => {
    const view = rendererAgentPickerView(
      { agent: "claude-code", phase: "locked" },
      "ready",
      false,
      agents,
      availability,
    );
    expect(view.triggerDisabled).toBe(true);
    expect(Object.values(view.optionDisabled).every(Boolean)).toBe(true);
    expect(rendererAgentPickerTooltip({ agent: "codex", phase: "locked" }, undefined)).toContain(
      "(locked)",
    );
  });

  it("opens for a switchable conversation with only ready Agents selectable", () => {
    const view = rendererAgentPickerView(
      { agent: "claude-code", phase: "locked", switchable: true },
      "ready",
      false,
      agents,
      availability,
    );
    expect(view.triggerDisabled).toBe(false);
    expect(view.optionDisabled).toEqual({ codex: false, "claude-code": false, grok: true });
    expect(
      rendererAgentPickerTooltip({ agent: "codex", phase: "locked", switchable: true }, undefined),
    ).not.toContain("(locked)");
  });

  it("stays closed while a switch is running", () => {
    const view = rendererAgentPickerView(
      { agent: "claude-code", phase: "locked", switchable: true },
      "ready",
      true,
      agents,
      availability,
    );
    expect(view.triggerDisabled).toBe(true);
  });
});

describe("the next message of a conversation switching Agents", () => {
  function starter(hostId: string, response: unknown) {
    const sendRequest = vi.fn(async (method: string, params: unknown) => {
      void method;
      void params;
      return response;
    });
    const target = { sendRequest };
    const next = vi.fn((params: unknown, send: (params: unknown) => unknown) => send(params));
    const start = createAgentSwitchTurnStarter(target, hostId, () => true, next);
    return { start, next, sendRequest };
  }

  it("goes to the Host as a switch and settles the source Turn", async () => {
    const { start, next, sendRequest } = starter("remote", { threadId: "new-thread" });
    pendingAgentSwitches.set("remote", "thread-1", { agent: "grok", label: "Grok" });
    const input = [{ type: "text", text: "继续第三版", text_elements: [] }];
    const send = vi.fn();

    const result = (await start({ threadId: "thread-1", input }, send)) as {
      turn: { status: string };
    };

    expect(sendRequest).toHaveBeenCalledWith(THREAD_AGENT_SWITCH_METHOD, {
      threadId: "thread-1",
      agent: "grok",
      input,
    });
    expect(send).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(result.turn.status).toBe("completed");
    expect(pendingAgentSwitches.get("remote", "thread-1")).toBeNull();
  });

  it("keeps the pending switch when the Host refuses, so the person can retry", async () => {
    const sendRequest = vi.fn(async () => {
      throw new Error("这段对话还在运行，等它结束后再切换");
    });
    const start = createAgentSwitchTurnStarter({ sendRequest }, "local", () => true, vi.fn());
    pendingAgentSwitches.set("local", "thread-1", { agent: "grok", label: "Grok" });

    await expect(
      Promise.resolve(
        start({ threadId: "thread-1", input: [{ type: "text", text: "x" }] }, vi.fn()),
      ),
    ).rejects.toThrow("这段对话还在运行");
    expect(pendingAgentSwitches.get("local", "thread-1")).toEqual({ agent: "grok", label: "Grok" });
  });

  it("leaves every other Turn to the existing senders", () => {
    const { start, next, sendRequest } = starter("local", { threadId: "unused" });
    pendingAgentSwitches.set("remote", "thread-1", { agent: "grok", label: "Grok" });
    const send = vi.fn(() => "sent");
    const params = { threadId: "thread-1", input: [{ type: "text", text: "x" }] };

    expect(start(params, send)).toBe("sent");
    expect(next).toHaveBeenCalledWith(params, send);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("notifies listeners when a switch is chosen or cancelled", () => {
    const listener = vi.fn();
    const unsubscribe = pendingAgentSwitches.subscribe(listener);
    pendingAgentSwitches.set("local", "thread-1", { agent: "grok", label: "Grok" });
    pendingAgentSwitches.clear("local", "thread-1");
    pendingAgentSwitches.clear("local", "thread-1");
    unsubscribe();
    pendingAgentSwitches.set("local", "thread-1", { agent: "grok", label: "Grok" });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
