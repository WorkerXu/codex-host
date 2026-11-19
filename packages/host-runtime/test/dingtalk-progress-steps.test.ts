import { describe, expect, it } from "vitest";
import {
  dingtalkProgressStatus,
  dingtalkProgressStep,
  dingtalkStatusText,
  sanitizeProgressText,
} from "../src/dingtalk-progress-steps.js";

describe("DingTalk progress step mapping", () => {
  it("maps a command to one step and keeps only its first line", () => {
    expect(
      dingtalkProgressStep(
        {
          id: "cmd-1",
          type: "commandExecution",
          command:
            "codexhost dingtalk dws -- chat message list --conversation-id cid --limit 5\nsecond line",
        },
        true,
      ),
    ).toEqual({
      id: "item:cmd-1",
      kind: "command",
      title: "执行命令",
      detail: "codexhost dingtalk dws -- chat message list --conversation-id cid --limit 5",
      status: "done",
    });
  });

  it("marks failed commands from status or exit code", () => {
    expect(
      dingtalkProgressStep(
        { id: "c", type: "commandExecution", command: "ls", status: "failed" },
        true,
      )?.status,
    ).toBe("failed");
    expect(
      dingtalkProgressStep({ id: "c", type: "commandExecution", command: "ls", exitCode: 2 }, true)
        ?.status,
    ).toBe("failed");
    expect(
      dingtalkProgressStep(
        { id: "c", type: "commandExecution", command: "ls", status: "inProgress" },
        false,
      )?.status,
    ).toBe("running");
  });

  it("maps tools, files, search, and the final answer", () => {
    expect(
      dingtalkProgressStep(
        { id: "t", type: "mcpToolCall", server: "dws", tool: "chat_message_list" },
        true,
      ),
    ).toMatchObject({ kind: "tool", detail: "dws · chat_message_list", title: "调用工具" });
    expect(
      dingtalkProgressStep(
        { id: "f", type: "fileChange", changes: [{ path: "a.md" }, { path: "b.md" }] },
        true,
      ),
    ).toMatchObject({ kind: "file", detail: "a.md、b.md", title: "修改文件" });
    expect(
      dingtalkProgressStep({ id: "w", type: "webSearch", query: "钉钉审批" }, true),
    ).toMatchObject({ kind: "search", detail: "钉钉审批", title: "搜索资料" });
    expect(
      dingtalkProgressStep(
        { id: "m", type: "agentMessage", phase: "final_answer", text: "答案" },
        true,
      ),
    ).toMatchObject({ kind: "answer", title: "撰写回答", status: "done" });
  });

  it("never turns private reasoning or commentary into a step", () => {
    expect(dingtalkProgressStep({ id: "r", type: "reasoning", text: "内部推理" }, true)).toBeNull();
    expect(
      dingtalkProgressStep(
        { id: "a", type: "agentMessage", phase: "commentary", text: "公开进度" },
        true,
      ),
    ).toBeNull();
    expect(dingtalkProgressStep({ type: "unknown" }, true)).toBeNull();
  });

  it("returns a short Chinese status only for public commentary", () => {
    expect(
      dingtalkProgressStatus({
        type: "agentMessage",
        phase: "commentary",
        text: "正在核对资料\n\n并整理结论",
      }),
    ).toBe("正在核对资料 并整理结论");
    expect(
      dingtalkProgressStatus({ type: "agentMessage", phase: "commentary", text: "Reading files" }),
    ).toBeNull();
    expect(
      dingtalkProgressStatus({ type: "agentMessage", phase: "final_answer", text: "答案" }),
    ).toBeNull();
  });
});

describe("DingTalk progress sanitization", () => {
  it("collapses whitespace and bounds long values", () => {
    expect(sanitizeProgressText("  a\n\n b\tc  ")).toBe("a b c");
    expect(sanitizeProgressText("x".repeat(200), 20)).toBe(`${"x".repeat(19)}…`);
  });

  it("redacts credentials from a command line", () => {
    expect(sanitizeProgressText("curl --token=abcd1234 https://example.test")).toBe(
      "curl --token=*** https://example.test",
    );
    expect(sanitizeProgressText("curl --api-key abcd1234 https://example.test")).toBe(
      "curl --api-key *** https://example.test",
    );
    expect(sanitizeProgressText("API_KEY=abcd1234 dws status")).toBe("API_KEY=*** dws status");
    expect(sanitizeProgressText("curl -H 'Authorization: Bearer abcdefghijklmnop'")).toBe(
      "curl -H 'Authorization: Bearer ***'",
    );
    expect(sanitizeProgressText("export KEY=sk-abcdefghijklmnop")).toBe("export KEY=***");
  });

  it("drops English-only status text that must not reach DingTalk", () => {
    expect(dingtalkStatusText("Reading files")).toBeNull();
    expect(dingtalkStatusText("正在读取文件")).toBe("正在读取文件");
  });
});
