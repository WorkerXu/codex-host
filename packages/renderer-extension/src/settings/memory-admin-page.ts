import type { HubMemory, HubResult } from "@codexhost/shared-contracts";
import { hubErrorText } from "../renderer-hub-admin-client.js";
import type { RendererSettingsPageDefinition } from "./core.js";
import type { HubAdminPageOptions } from "./mcp-admin-page.js";
import { HubCacheController, hubAgeLabel, type HubCacheView } from "./hub-cache.js";
import { createHubPage, hubButton, hubDate, hubElement, hubSelect } from "./hub-admin-ui.js";

export function createMemoryAdminPage(
  options: HubAdminPageOptions,
  label = "记忆",
): RendererSettingsPageDefinition {
  return Object.freeze<RendererSettingsPageDefinition>({
    id: "memory",
    label,
    icon: "logs",
    mount(context) {
      const client = options.createClient();
      const ui = createHubPage(context, label, client);
      if (!client) {
        ui.status.textContent = "连接失败";
        return;
      }
      const document = ui.document;
      let query = "";
      let source = "";
      let offset = 0;
      let windowId: string | undefined;
      let summary: HubResult<"overview"> | null = null;
      let searchGeneration = 0;
      const results = hubElement(document, "div", "hub-memory-results");
      const heading = hubElement(document, "h3", "hub-section-head", "最近更新");
      const openMemory = async (memory: HubMemory) => {
        const host = ui.hostId;
        const revision = ui.revision();
        const modal = ui.dialog(memory.title, true);
        modal.content.textContent = "正在加载…";
        try {
          const value = await client.request(host, {
            op: "memory",
            id: memory.id,
            kind: memory.kind,
            variant: memory.variant,
          });
          if (!ui.valid(host, revision) || !modal.root.isConnected) return;
          modal.heading.textContent = value.title;
          modal.root.setAttribute("aria-label", value.title);
          modal.content.replaceChildren(
            hubElement(
              document,
              "p",
              "hub-muted hub-memory-meta",
              `${value.source} · ${hubDate(value.time)}`,
            ),
            hubElement(document, "div", "hub-memory-text", value.text),
          );
        } catch (error) {
          modal.content.textContent = hubErrorText(error);
        }
      };
      const row = (memory: HubMemory) => {
        const item = hubElement(document, "article", "hub-memory-row");
        const title = hubButton(document, memory.title, () => {
          void openMemory(memory);
        });
        title.className = "hub-memory-title";
        item.append(
          title,
          hubElement(document, "p", "hub-snippet", memory.text),
          hubElement(document, "p", "hub-muted", `${memory.source} · ${hubDate(memory.time)}`),
        );
        return item;
      };
      const search = async (quiet = false) => {
        const host = ui.hostId;
        const revision = ui.revision();
        const generation = ++searchGeneration;
        const run = async () => {
          const value = await client.request(host, {
            op: "search",
            query,
            source,
            offset,
            ...(windowId ? { windowId } : {}),
          });
          if (!ui.valid(host, revision) || generation !== searchGeneration) return;
          heading.textContent =
            query.trim() || source ? `搜索结果 · ${value.total} 条` : "最近更新";
          offset = value.offset;
          windowId = value.windowId ?? undefined;
          results.replaceChildren();
          for (const memory of value.memories) results.append(row(memory));
          if (!value.memories.length)
            results.append(hubElement(document, "p", "hub-empty", "没有匹配的记忆"));
          const pagination = hubElement(document, "div", "hub-row hub-pagination");
          const previous = hubButton(document, "上一页", () => {
            offset = Math.max(0, offset - 10);
            void search();
          });
          previous.disabled = offset === 0;
          const next = hubButton(document, "下一页", () => {
            offset += 10;
            void search();
          });
          next.disabled = offset + 10 >= value.total;
          pagination.append(
            hubElement(
              document,
              "span",
              "hub-muted",
              `共 ${value.total} 条 · 第 ${Math.floor(offset / 10) + 1} 页`,
            ),
            previous,
            next,
          );
          results.append(pagination);
        };
        if (quiet) {
          try {
            await run();
          } catch (error) {
            ui.status.textContent = hubErrorText(error);
          }
        } else await ui.load(run);
      };
      let mounted = false;
      const statValues: HTMLElement[] = [];
      const renderRecent = () => {
        if (!summary) return;
        results.replaceChildren();
        if (!summary.recent.length) {
          results.append(hubElement(document, "p", "hub-empty", "暂无记忆"));
          return;
        }
        for (const memory of summary.recent) results.append(row(memory));
      };
      const updateSummary = () => {
        if (!summary) return;
        const values = [
          String(summary.total),
          { idle: "已完成", running: "整理中", blocked: "已暂停", waiting: "等待处理" }[
            summary.consolidation
          ],
          hubDate(summary.updatedAt),
        ];
        values.forEach((value, index) => {
          const target = statValues[index];
          if (target) target.textContent = value;
        });
        ui.updated.hidden = false;
      };
      const render = () => {
        if (!summary || mounted) return;
        mounted = true;
        ui.body.replaceChildren();
        const overview = hubElement(document, "div", "hub-overview");
        for (const label of ["记忆总数", "整理状态", "最近更新"]) {
          const card = hubElement(document, "div", "hub-overview-card");
          card.append(
            hubElement(document, "span", "hub-muted", label),
            hubElement(document, "strong", "hub-stat-value", ""),
          );
          statValues.push(card.lastElementChild as HTMLElement);
          overview.append(card);
        }
        updateSummary();
        ui.body.append(overview);
        heading.textContent = "最近更新";
        ui.body.append(heading);
        const form = hubElement(document, "form", "hub-row hub-memory-search");
        const input = hubElement(document, "input");
        input.type = "search";
        input.placeholder = "搜索记忆";
        input.setAttribute("aria-label", "搜索记忆");
        const sources = hubSelect(document, "来源", [
          ["", "全部来源"],
          ...summary.sources.map((source) => [source.id, source.label] as const),
        ]);
        const submit = hubElement(document, "button", "hub-primary", "搜索");
        submit.type = "submit";
        const searchBox = hubElement(document, "div", "hub-search-box");
        searchBox.append(input, sources);
        form.append(searchBox, submit);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          heading.textContent = input.value.trim() || sources.value ? "搜索结果" : "最近更新";
          query = input.value;
          source = sources.value;
          offset = 0;
          windowId = undefined;
          void search();
        });
        sources.addEventListener("change", () => {
          heading.textContent = input.value.trim() || sources.value ? "搜索结果" : "最近更新";
          query = input.value;
          source = sources.value;
          offset = 0;
          windowId = undefined;
          void search();
        });
        ui.body.append(form, results);
        renderRecent();
      };
      const applyView = (view: HubCacheView<HubResult<"overview">>) => {
        summary = view.value;
        render();
        updateSummary();
        ui.updated.textContent = `更新于 ${hubAgeLabel(view.updatedAt)}`;
        if (!query.trim() && !source) renderRecent();
        ui.status.textContent = "";
      };
      const controller = new HubCacheController<HubResult<"overview">>(
        "hub-memory",
        () => client.request(ui.hostId, { op: "overview" }),
        applyView,
      );
      const afterOverview = () => {
        if (!query.trim() && !source) void search(true);
      };
      const refresh = async (pending?: string) => {
        await ui.load(async () => {
          await controller.refresh();
        }, pending);
        afterOverview();
      };
      let retry: ReturnType<typeof setTimeout> | null = null;
      const background = () => {
        void controller
          .refresh()
          .then(afterOverview)
          .catch((error: unknown) => {
            ui.status.textContent = hubErrorText(error);
            const code = (error as { message?: string } | null)?.message;
            if (code !== "connecting" && code !== "retrying") return;
            if (retry) clearTimeout(retry);
            retry = setTimeout(() => {
              retry = null;
              background();
            }, 3_000);
          });
      };
      context.signal.addEventListener(
        "abort",
        () => {
          if (retry) clearTimeout(retry);
          retry = null;
        },
        { once: true },
      );
      const tick = setInterval(() => {
        const view = controller.peek();
        if (view && !ui.updated.hidden)
          ui.updated.textContent = `更新于 ${hubAgeLabel(view.updatedAt)}`;
      }, 30_000);
      context.signal.addEventListener("abort", () => clearInterval(tick), { once: true });
      void ui.initialize(() => {
        const cached = controller.peek();
        if (cached) {
          applyView(cached);
          background();
        } else void refresh("正在连接 India…");
      });
    },
  });
}
