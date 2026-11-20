import { z } from "zod";
import type { HubAdminParams, HubMemory } from "@codexhost/shared-contracts";
import { HubAdminError } from "./hub-admin-http.js";

const record = z.object({
  memory_id: z.string(),
  content: z.string(),
  source: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  memory_at: z.number().nullable().optional(),
  updated_at: z.number().nullable().optional(),
  created_at: z.number().nullable().optional(),
  gmt_created: z.number().nullable().optional(),
  kind: z.enum(["chat", "experience", "fact"]).default("chat"),
  variant: z.enum(["working", "coding"]).nullable().default(null),
});
function memory(value: z.infer<typeof record>, full = false): HubMemory {
  const text = value.content;
  return {
    id: value.memory_id,
    kind: value.kind,
    variant: value.variant,
    title:
      text
        .split(/\r?\n/u)
        .find((line) => line.trim())
        ?.slice(0, 100) ?? "无标题",
    text: full ? text : text.slice(0, 240),
    source: value.source ?? "未知来源",
    time: value.updated_at ?? value.memory_at ?? value.created_at ?? value.gmt_created ?? null,
    conversation: value.session_id ?? null,
  };
}
const page = z.object({
  memories: z.array(record),
  total: z.number(),
  offset: z.number(),
  window_id: z.string().nullable().optional(),
});
export async function runMemAdmin(
  get: (path: string) => Promise<unknown>,
  params: HubAdminParams,
): Promise<unknown> {
  switch (params.op) {
    case "overview": {
      const [summary, processing, recent, sources] = await Promise.all([
        get("/api/v2/home-summary").then((value) =>
          z.object({ memory_count: z.number(), latest: record.nullable() }).parse(value),
        ),
        get("/api/v1/memory-processing").then((value) =>
          z
            .object({
              running: z.number(),
              pending: z.number(),
              suspended: z.number(),
              waiting_for_model: z.number(),
              blocked_stages: z.array(z.unknown()),
            })
            .parse(value),
        ),
        get("/api/v2/memory-library?limit=4&scene=all").then((value) => page.parse(value)),
        get("/api/v1/sources").then((value) =>
          z.array(z.object({ source_id: z.string(), display_name: z.string() })).parse(value),
        ),
      ]);
      return {
        total: summary.memory_count,
        consolidation:
          processing.blocked_stages.length || processing.suspended
            ? "blocked"
            : processing.running
              ? "running"
              : processing.pending || processing.waiting_for_model
                ? "waiting"
                : "idle",
        updatedAt: summary.latest ? memory(summary.latest).time : null,
        recent: recent.memories.map((value) => memory(value)),
        sources: sources.map((source) => ({ id: source.source_id, label: source.display_name })),
      };
    }
    case "search": {
      const query = new URLSearchParams({
        limit: "10",
        offset: String(params.offset),
        scene: "all",
      });
      if (params.query.trim()) {
        query.set("query", params.query.trim());
        if (params.windowId) query.set("window_id", params.windowId);
      }
      if (params.source) query.set("source", params.source);
      const value = page.parse(await get(`/api/v2/memory-library?${query}`));
      return {
        total: value.total,
        offset: value.offset,
        windowId: value.window_id ?? null,
        memories: value.memories.map((value) => memory(value)),
      };
    }
    case "memory": {
      const query = new URLSearchParams({ kind: params.kind });
      if (params.variant) query.set("variant", params.variant);
      return memory(
        record.parse(await get(`/api/v2/memories/${encodeURIComponent(params.id)}?${query}`)),
        true,
      );
    }
    default:
      throw new HubAdminError("invalid");
  }
}
