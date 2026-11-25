import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const items = [
  {
    itemId: "alpha",
    label: "Alpha",
    description: "First synthetic mention",
  },
  {
    itemId: "beta",
    label: "Beta",
    description: "Second synthetic mention",
  },
  {
    itemId: "unicode",
    label: "中文条目",
    description: "Unicode label round-trip",
  },
];

function delay(signal, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("Search cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function activate(ctx) {
  const pending = new Map();

  ctx.handle("mentions/search", async ({ requestId, sourceId, query, limit }) => {
    if (sourceId !== "demo") throw new Error(`Unknown mention source: ${sourceId}`);
    const controller = new AbortController();
    pending.set(requestId, controller);
    try {
      await delay(controller.signal, 80);
      const needle = query.trim().toLocaleLowerCase();
      return {
        items: items
          .filter((item) =>
            `${item.label} ${item.description}`.toLocaleLowerCase().includes(needle),
          )
          .slice(0, limit),
      };
    } finally {
      if (pending.get(requestId) === controller) pending.delete(requestId);
    }
  });

  ctx.handle("mentions/cancel", ({ requestId }) => {
    const controller = pending.get(requestId);
    controller?.abort();
    return { cancelled: controller !== undefined };
  });

  ctx.handle("mentions/expand", async ({ mentions }) => {
    const expansions = mentions.map(({ sourceId, itemId, label }) => {
      if (sourceId !== "demo") throw new Error(`Unknown mention source: ${sourceId}`);
      const item = items.find((candidate) => candidate.itemId === itemId);
      return {
        sourceId,
        itemId,
        text: `[Demo mention] ${item?.label ?? label}\nSource: tests/fixtures/host-extension-mentions.`,
      };
    });
    await mkdir(ctx.dataDir, { recursive: true });
    await appendFile(
      path.join(ctx.dataDir, "mentions.log"),
      `${JSON.stringify({ at: new Date().toISOString(), mentions })}\n`,
    );
    return { expansions };
  });
}
