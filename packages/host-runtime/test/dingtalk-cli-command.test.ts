import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  isDwsWriteCommand,
  parseDingTalkCliArguments,
  runDingTalkCli,
} from "../src/dingtalk-cli-command.js";

describe("codexhost dingtalk CLI", () => {
  it("keeps read-only commands outside consent gating", () => {
    expect(isDwsWriteCommand(["chat", "+unread-chats"])).toBe(false);
    expect(isDwsWriteCommand(["chat", "+search-msg", "--query", "支付"])).toBe(false);
    expect(isDwsWriteCommand(["chat", "message", "list", "--group", "cid"])).toBe(false);
    expect(isDwsWriteCommand(["auth", "status", "--readonly"])).toBe(false);
  });

  it("requires consent for writes and unknown commands", () => {
    expect(isDwsWriteCommand(["chat", "message", "send", "--content", "x"])).toBe(true);
    expect(isDwsWriteCommand(["chat", "+messages-reply", "--content", "x"])).toBe(true);
    expect(isDwsWriteCommand(["approval", "approve", "--id", "1"])).toBe(true);
    expect(isDwsWriteCommand(["some-new-command"])).toBe(true);
  });

  it("parses host, consent and the dws argument tail", () => {
    expect(
      parseDingTalkCliArguments(["--host", "tencent", "--yes", "--", "chat", "+unread-chats"]),
    ).toEqual({ host: "tencent", yes: true, dws: ["chat", "+unread-chats"] });
    expect(parseDingTalkCliArguments(["--host=tencent", "--", "chat"])).toEqual({
      host: "tencent",
      yes: false,
      dws: ["chat"],
    });
    expect(() => parseDingTalkCliArguments(["chat", "+unread-chats"])).toThrow(/must follow '--'/u);
  });

  it("refuses a write before any dws process starts", async () => {
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    await expect(
      runDingTalkCli({
        arguments: ["dws", "--", "chat", "message", "send", "--content", "hi"],
        output,
        diagnosticOutput: diagnostics,
      }),
    ).rejects.toThrow(/consent_required/u);
  });
});
