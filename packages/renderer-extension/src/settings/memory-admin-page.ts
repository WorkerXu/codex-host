import type { HubMemory, HubResult } from "@codexhost/shared-contracts";
import { hubErrorText } from "../renderer-hub-admin-client.js";
import type { RendererSettingsPageDefinition } from "./core.js";
import type { HubAdminPageOptions } from "./mcp-admin-page.js";
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
      const ui = createHubPage(context, label, "oracle-main", client);
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
      const openMemory = async (memory: HubMemory) => {
        const host = ui.hosts.value;
        const revision = ui.revision();
        const modal = ui.dialog("记忆详情");
        modal.content.textContent = "正在加载…";
        try {
          const value = await client.request(host, {
            op: "memory",
            id: memory.id,
            kind: memory.kind,
            variant: memory.variant,
          });
          if (!ui.valid(host, revision) || !modal.root.isConnected) return;
          modal.content.replaceChildren(
            hubElement(document, "h4", "", value.title),
            hubElement(document, "p", "hub-muted", `${value.source} · ${hubDate(value.time)}`),
            hubElement(document, "div", "hub-memory-text", value.text),
            hubElement(document, "p", "hub-muted", `关联对话：${value.conversation ?? "无"}`),
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
      const search = async () => {
        const host = ui.hosts.value;
        const revision = ui.revision();
        const generation = ++searchGeneration;
        await ui.load(async () => {
          const value = await client.request(host, {
            op: "search",
            query,
            source,
            offset,
            ...(windowId ? { windowId } : {}),
          });
          if (!ui.valid(host, revision) || generation !== searchGeneration) return;
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
        });
      };
      const render = () => {
        if (!summary) return;
        ui.body.replaceChildren();
        const overview = hubElement(document, "div", "hub-overview");
        for (const [label, value] of [
          ["记忆总数", String(summary.total)],
          [
            "整理状态",
            { idle: "已完成", running: "整理中", blocked: "已暂停", waiting: "等待处理" }[
              summary.consolidation
            ],
          ],
          ["最近更新", hubDate(summary.updatedAt)],
        ]) {
          const card = hubElement(document, "div", "hub-overview-card");
          card.append(
            hubElement(document, "span", "hub-muted", label),
            hubElement(document, "strong", "", value),
          );
          overview.append(card);
        }
        ui.body.append(overview, hubElement(document, "h3", "hub-section-head", "最近更新"));
        const recent = hubElement(document, "div", "hub-recent");
        for (const memory of summary.recent) {
          const button = hubButton(document, memory.title, () => {
            void openMemory(memory);
          });
          button.className = "hub-recent-link";
          const item = hubElement(document, "div", "hub-row");
          item.append(button, hubElement(document, "span", "hub-muted", hubDate(memory.time)));
          recent.append(item);
        }
        if (!summary.recent.length)
          recent.append(hubElement(document, "p", "hub-empty", "暂无记忆"));
        ui.body.append(recent, hubElement(document, "h3", "hub-section-head", "搜索记忆"));
        const form = hubElement(document, "form", "hub-row");
        const input = hubElement(document, "input");
        input.type = "search";
        input.placeholder = "搜索记忆";
        input.setAttribute("aria-label", "搜索记忆");
        const sources = hubSelect(document, "来源", [
          ["", "全部来源"],
          ...summary.sources.map((source) => [source.id, source.label] as const),
        ]);
        const submit = hubElement(document, "button", "agent-primary", "搜索");
        submit.type = "submit";
        form.append(input, sources, submit);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          query = input.value;
          source = sources.value;
          offset = 0;
          windowId = undefined;
          void search();
        });
        sources.addEventListener("change", () => {
          query = input.value;
          source = sources.value;
          offset = 0;
          windowId = undefined;
          void search();
        });
        ui.body.append(form, results);
      };
      const refresh = async () => {
        ++searchGeneration;
        const host = ui.hosts.value;
        const revision = ui.revision();
        if (!host) return;
        summary = null;
        query = "";
        source = "";
        offset = 0;
        windowId = undefined;
        await ui.load(async () => {
          const result = await client.request(host, { op: "overview" });
          if (!ui.valid(host, revision)) return;
          summary = result;
          render();
        });
        if (ui.valid(host, revision) && summary) await search();
      };
      void ui.initialize(() => {
        void refresh();
      });
    },
  });
}
