import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const items = [
  { itemId: "alpha", label: "Alpha", description: "第一个合成条目" },
  { itemId: "beta", label: "Beta", description: "第二个合成条目" },
  { itemId: "unicode", label: "中文条目", description: "中文提及" },
];

export async function activate(ctx) {
  const jobs = new Map();
  let cancelled = 0;
  const log = async (name, value) => {
    await mkdir(ctx.dataDir, { recursive: true });
    await appendFile(path.join(ctx.dataDir, name), `${JSON.stringify(value)}\n`);
  };
  ctx.handle("mentions/search", ({ requestId, sourceId, query, limit, cursor }) => {
    if (!["demo", "two-step", "multi"].includes(sourceId)) throw new Error("Unknown source");
    if (sourceId !== "demo" || query === "slow") {
      const key = `${requestId}:${sourceId}`;
      if (!cursor) jobs.set(key, { readyAt: Date.now() + 15_000, cursor: key });
      const job = jobs.get(key);
      if (!job || (cursor && cursor !== job.cursor)) throw new Error("Search cancelled");
      if (Date.now() < job.readyAt) return { pending: { cursor: job.cursor, retryAfterMs: 250 } };
      jobs.delete(key);
      if (sourceId !== "demo")
        return {
          items: [
            { itemId: "project-a", label: "示例项目", description: "第一步已完成，可进入第二步" },
          ],
        };
    }
    const needle = query === "slow" ? "" : query.trim().toLocaleLowerCase();
    return {
      items: items
        .filter((item) => `${item.label} ${item.description}`.toLocaleLowerCase().includes(needle))
        .slice(0, limit),
    };
  });
  ctx.handle("picker/items", () => ({ items }));
  ctx.handle("fixture/status", () => ({ pid: process.pid, activeJobs: jobs.size, cancelled }));
  ctx.handle("mentions/cancel", async ({ requestId }) => {
    let stopped = false;
    for (const key of jobs.keys())
      if (key.startsWith(`${requestId}:`)) {
        jobs.delete(key);
        stopped = true;
        cancelled++;
      }
    await log("cancel.log", { requestId, stopped });
    return { cancelled: stopped };
  });
  ctx.handle("mentions/expand", async ({ mentions }) => {
    const expansions = mentions.map(({ sourceId, itemId, label }) => {
      if (!["demo", "two-step", "multi"].includes(sourceId)) throw new Error("Unknown source");
      return {
        sourceId,
        itemId,
        text: `[Demo mention] ${items.find((item) => item.itemId === itemId)?.label ?? label}\nSource: tests/fixtures/host-extension-mentions.`,
      };
    });
    await log("mentions.log", { mentions, expansions });
    return { expansions };
  });
  return () => jobs.clear();
}
