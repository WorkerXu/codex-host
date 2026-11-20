import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runDwsRaw } from "../src/dingtalk-cli.js";
import { requestPeerRoute } from "../src/peer-transport.js";
import type * as DingTalkCliModule from "../src/dingtalk-cli.js";
import type * as PeerTransportModule from "../src/peer-transport.js";

import {
  isDwsWriteCommand,
  parseDingTalkCliArguments,
  runDingTalkCli,
} from "../src/dingtalk-cli-command.js";

vi.mock("../src/dingtalk-cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DingTalkCliModule>()),
  runDwsRaw: vi.fn(),
}));
vi.mock("../src/peer-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PeerTransportModule>()),
  requestPeerRoute: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runDwsRaw).mockResolvedValue({
    exitCode: 0,
    stdout: "fake dws output\n",
    stderr: "",
    timedOut: false,
    truncated: false,
  });
});

async function run(
  args: string[],
  options: { dispatch?: boolean; yes?: boolean; host?: string } = {},
) {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += String(chunk);
  });
  const exitCode = await runDingTalkCli({
    arguments: [
      "dws",
      "--host",
      options.host ?? "local",
      ...(options.yes ? ["--yes"] : []),
      "--",
      ...args,
    ],
    environment: options.dispatch ? { CODEXHOST_DINGTALK_DISPATCH: "1" } : {},
    output,
    diagnosticOutput: new PassThrough(),
  });
  return { exitCode, text };
}

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
    expect(runDwsRaw).not.toHaveBeenCalled();
    expect(requestPeerRoute).not.toHaveBeenCalled();
  });

  const oaWrites = [
    "approve",
    "reject",
    "revoke",
    "transfer",
    "redirect-task",
    "revert-task",
    "append-task",
    "create-instance",
    "oa-comments",
    "oa-cc-noticer",
    "template",
    "image",
    "attachment",
    "future-state-change",
  ];
  it.each(oaWrites)(
    "always refuses OA %s, including consent and dispatch calls",
    async (command) => {
      for (const dispatch of [false, true]) {
        for (const yes of [false, true]) {
          await expect(
            run(["oa", "approval", command, ...(yes ? ["--yes"] : [])], {
              dispatch,
              yes,
              host: "unconfigured",
            }),
          ).rejects.toThrow("审批状态只能由你本人在钉钉里处理");
        }
      }
      expect(runDwsRaw).not.toHaveBeenCalled();
      expect(requestPeerRoute).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["--profile", "chat", "oa", "approval", "approve"],
    ["--profile=chat", "oa", "approval", "reject"],
    ["-fjson", "oa", "--profile", "chat", "approval", "revoke"],
    ["--dry-run", "oa", "approval", "transfer"],
    ["oa", "another-approval-api", "approve"],
    ["approval", "approve"],
  ])("cannot hide OA writes using global options: %j", async (...args) => {
    await expect(run(args, { yes: true, host: "unconfigured" })).rejects.toThrow(
      "审批状态只能由你本人在钉钉里处理",
    );
    expect(runDwsRaw).not.toHaveBeenCalled();
    expect(requestPeerRoute).not.toHaveBeenCalled();
  });

  it.each([
    ["--unknown", "chat", "oa", "approval", "approve"],
    ["--", "oa", "approval", "approve"],
    ["--profile", "--yes", "oa", "approval", "approve"],
  ])("rejects ambiguous command paths before executing: %j", async (...args) => {
    await expect(run(args, { yes: true, host: "unconfigured" })).rejects.toThrow(
      /option|requires a value/u,
    );
    expect(runDwsRaw).not.toHaveBeenCalled();
    expect(requestPeerRoute).not.toHaveBeenCalled();
  });

  it.each([
    ["chat", "message", "send"],
    ["chat", "+messages-reply"],
    ["chat", "+messages-send-card"],
    ["chat", "+messages-update-card"],
    ["chat", "message", "recall"],
    ["chat", "group", "create"],
    ["contact", "user", "update"],
    ["auth", "login"],
    ["event", "consume"],
    ["some-new-command"],
  ])("refuses dispatch writes even with consent: %j", async (...args) => {
    for (const yes of [false, true]) {
      await expect(
        run([...args, ...(yes ? ["--yes"] : [])], { dispatch: true, yes, host: "unconfigured" }),
      ).rejects.toThrow("派发对话只能读取钉钉数据");
    }
    expect(runDwsRaw).not.toHaveBeenCalled();
    expect(requestPeerRoute).not.toHaveBeenCalled();
  });

  it.each([
    ["chat", "+search-msg", "--query", "oa approval approve"],
    ["--profile", "oa", "chat", "+unread-chats"],
    ["oa", "approval", "list-pending"],
    ["oa", "approval", "detail", "--id", "x"],
    ["oa", "approval", "records"],
    ["oa", "approval", "tasks"],
    ["oa", "approval", "revert-activities"],
  ])("still permits read-only commands in dispatch Threads: %j", async (...args) => {
    expect(await run(args, { dispatch: true })).toEqual({ exitCode: 0, text: "fake dws output\n" });
    expect(runDwsRaw).toHaveBeenCalledWith(args, expect.objectContaining({ timeoutMs: 60_000 }));
  });

  it("keeps explicitly confirmed non-OA writes available outside dispatch", async () => {
    const args = ["chat", "message", "send", "--content", "fake only"];
    expect(await run(args, { yes: true })).toMatchObject({ exitCode: 0 });
    expect(runDwsRaw).toHaveBeenCalledWith(
      [...args, "--yes"],
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it("does not accept a dws-level consent flag as a way around either hard restriction", async () => {
    await expect(
      run(["oa", "approval", "approve", "--yes"], { host: "unconfigured" }),
    ).rejects.toThrow("审批状态只能由你本人在钉钉里处理");
    await expect(
      run(["--yes", "chat", "message", "send"], { dispatch: true, host: "unconfigured" }),
    ).rejects.toThrow("派发对话只能读取钉钉数据");
    expect(runDwsRaw).not.toHaveBeenCalled();
    expect(requestPeerRoute).not.toHaveBeenCalled();
  });
});
