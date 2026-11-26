import assert from "node:assert/strict";
import { it } from "node:test";
import { formatHostExtensionMentionToken } from "@codexhost/shared-contracts";
import type { ChHostClient } from "../src/ch-host-client.ts";
import type { ChThread } from "../src/ch-thread-view.ts";
import { tryGenerateThreadTitle } from "../src/ch-thread-titles.ts";
import { threadListTitle } from "../src/ch-thread-title.ts";

const mention = formatHostExtensionMentionToken({
  extensionId: "workbench",
  sourceId: "dingtalk",
  itemId: "synthetic-messages",
  label: "合成测试群（2 条消息）",
});
for (const external of [false, true]) {
  for (const generated of [null, "合成待办摘要"]) {
    it(`${external ? "external Agent" : "native Codex"} ${generated ? "generated" : "fallback"} titles use visible mention labels and the user's own words`, async () => {
      const row = {
        id: "synthetic-thread",
        name: "",
        preview: "[codexhost DingTalk] 合成上下文",
        cwd: "/tmp/synthetic-project",
      } as ChThread;
      const calls: { method: string; params: Record<string, unknown> }[] = [];
      const host = {
        request: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params });
          if (method === "codexhost/thread/title/generate") return generated;
          if (method === "thread/read") return { thread: row };
          if (method === "thread/name/set") {
            row.name = String(params.name);
            return {};
          }
          throw new Error("unexpected request");
        },
      } as unknown as ChHostClient;
      assert.equal(
        await tryGenerateThreadTitle(
          host,
          { ...row },
          `${mention} 请总结待办`,
          external,
          () => true,
        ),
        true,
      );
      assert.equal(row.name, generated ?? "@合成测试群（2 条消息） 请总结待办");
      assert.equal(
        calls.find((call) => call.method === "codexhost/thread/title/generate")?.params.prompt,
        "@合成测试群（2 条消息） 请总结待办",
      );
      assert.equal(threadListTitle(row), row.name);
      assert.ok(
        !calls.some((call) => JSON.stringify(call.params).includes("codexhost-extension://")),
      );
      const name = row.name;
      assert.equal(
        await tryGenerateThreadTitle(host, { ...row, name: "" }, mention, external, () => true),
        false,
      );
      assert.equal(row.name, name, "a later/manual title must survive");
    });
  }
}
