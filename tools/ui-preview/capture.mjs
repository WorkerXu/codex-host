#!/usr/bin/env node
/* global document, getComputedStyle, window, CSSStyleSheet */
/**
 * Captures every preview scenario in light and dark with the installed
 * Playwright Chromium and records basic DOM assertions next to the images.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { chromium } from "@playwright/test";

const previewRoot = import.meta.dirname;
const port = Number(process.env.UI_PREVIEW_PORT ?? 4417);
const baseUrl = `http://127.0.0.1:${port}`;
const allScenarios = [
  "dingtalk-heavy",
  "dingtalk-list",
  "dingtalk-status-connected",
  "dingtalk-status-not-logged-in",
  "dingtalk-status-unreachable",
  "dingtalk-open",
  "dingtalk-direct",
  "dingtalk-scrolled-top",
  "dingtalk-search",
  "dingtalk-search-more",
  "dingtalk-empty",
  "dingtalk-error",
  "agents-cards",
  "agents-cards-narrow",
  "agents-empty",
  "agents-menu",
  "agents-delete-confirm",
  "agents-edit",
  "agents-edit-dingtalk-on",
  "agents-edit-dingtalk-off",
  "agents-name-error",
  "agents-dingtalk-threshold",
  "jarvis-settings",
  "group-plus-menu",
  "group-add-machine",
  "project-group-empty-machine",
  "project-group-all-empty",
  "group-add-machine-busy",
  "group-add-machine-error",
  "at-entry",
  "at-entry-native",
  "at-entry-native-visible",
  "jarvis-entry",
  "jarvis-entry-query",
  "jarvis-mode-prefilled",
  "jarvis-mode-detached",
  "jarvis-mode-loading",
  "jarvis-mode-results",
  "jarvis-mode-empty",
  "jarvis-mode-error",
  "jarvis-mode-slow",
  "jarvis-mode-conditions",
  "jarvis-mode-chip-removed",
];

const args = process.argv.slice(2);
let outputDirectory = path.join(previewRoot, "captures");
const requested = [];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--out") {
    index += 1;
    if (args[index]) outputDirectory = path.resolve(args[index]);
  } else {
    requested.push(argument);
  }
}
const scenarios = requested.length > 0 ? requested : allScenarios;

if (!process.env.CODEX_SHADOW_CONTEXT) {
  throw new Error(
    "Set CODEX_SHADOW_CONTEXT to the exported shadow-context.json before capturing previews",
  );
}

async function serverIsUp() {
  try {
    const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

let server = null;
if (!(await serverIsUp())) {
  server = spawn(process.execPath, [path.join(previewRoot, "serve.mjs")], {
    stdio: "inherit",
    detached: false,
  });
  const started = Date.now();
  while (!(await serverIsUp())) {
    if (Date.now() - started > 10_000) throw new Error("Preview server did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const browser = await chromium.launch({
  args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
});
await mkdir(outputDirectory, { recursive: true });
const shadowContext = await fetch(`${baseUrl}/shadow-context.json`).then((response) =>
  response.json(),
);
const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  shadowContext,
  captures: [],
};

for (const scenario of scenarios) {
  for (const theme of ["light", "dark"]) {
    const width = scenario === "agents-cards-narrow" ? 720 : 1440;
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: theme,
      locale: "zh-CN",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/?scenario=${scenario}&theme=${theme}`, {
      waitUntil: "load",
    });
    await page.waitForSelector('body[data-ready="true"]', { timeout: 20_000 });
    if (scenario === "agents-cards") {
      await page.hover(".agent-card[data-agent-name]");
    }
    const failure = await page.evaluate(() => document.body.dataset.error ?? null);
    if (failure) throw new Error(`${scenario}/${theme}: ${failure}`);
    await page.waitForTimeout(200);

    const checks = await page.evaluate(() => {
      const shell = document.querySelector("[data-codexhost-settings-shell]")?.shadowRoot;
      const query = (selector) =>
        shell?.querySelector(selector) ?? document.querySelector(selector);
      const queryAll = (selector) => [
        ...(shell?.querySelectorAll(selector) ?? []),
        ...document.querySelectorAll(selector),
      ];
      const result = [];
      const check = (name, ok, detail = "") => result.push({ name, ok: Boolean(ok), detail });
      const visible = (element) => Boolean(element) && element.getBoundingClientRect().height > 0;

      // Every custom property used by the workbench must resolve inside the
      // shadow root, or carry an explicit fallback.
      if (shell) {
        const unresolved = new Set();
        const collectRules = (rules) => {
          for (const rule of rules) {
            if (rule.cssRules) collectRules(rule.cssRules);
            if (!rule.selectorText || !rule.style) continue;
            let sample;
            if (rule.selectorText.includes(":host")) {
              sample = shell.host;
            } else {
              try {
                sample = shell.querySelector(rule.selectorText);
              } catch {
                continue;
              }
            }
            if (!sample) continue;
            for (const property of rule.style) {
              const value = rule.style.getPropertyValue(property);
              const pattern = /var\(\s*(--[\w-]+)\s*(,)?/gu;
              let match;
              while ((match = pattern.exec(value))) {
                if (match[2]) continue;
                const resolved = getComputedStyle(sample).getPropertyValue(match[1]).trim();
                if (!resolved) unresolved.add(`${match[1]} @ ${rule.selectorText}`);
              }
            }
          }
        };
        for (const style of shell.querySelectorAll("style")) {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(style.textContent ?? "");
          collectRules(sheet.cssRules);
        }
        check(
          "shadow-vars-resolved",
          unresolved.size === 0,
          [...unresolved].slice(0, 8).join(" | "),
        );
      }

      if (document.querySelector(".dingtalk-workbench")) {
        const list = query(".dingtalk-conversation-list");
        check("conversation-list-visible", visible(list));
        const sidebar = query(".settings-sidebar");
        check(
          "dingtalk-full-width",
          Boolean(sidebar) && getComputedStyle(sidebar).display === "none",
        );
        check("default-conversation-open", queryAll(".dingtalk-message").length > 0);
        check("no-view-switch", !query(".dingtalk-list-switch"));
        const firstRow = query(".dingtalk-conversation");
        const firstRowStyle = firstRow ? getComputedStyle(firstRow) : null;
        const firstRowRect = firstRow?.getBoundingClientRect();
        check(
          "row-native-height",
          Boolean(firstRowRect) && Math.abs(firstRowRect.height - 64) <= 1,
          firstRowRect ? `${Math.round(firstRowRect.height)}px` : "missing",
        );
        check(
          "row-native-padding",
          firstRowStyle?.paddingLeft === "12px",
          firstRowStyle?.paddingLeft ?? "missing",
        );
        const avatar = query(".dingtalk-conversation .dingtalk-avatar");
        const avatarRect = avatar?.getBoundingClientRect();
        check(
          "avatar-native-size",
          Boolean(avatarRect) && Math.abs(avatarRect.width - 40) <= 1,
          avatarRect ? `${Math.round(avatarRect.width)}px` : "missing",
        );
        check(
          "avatar-native-radius",
          Boolean(avatar) && getComputedStyle(avatar).borderRadius === "10px",
          avatar ? getComputedStyle(avatar).borderRadius : "missing",
        );
        check("muted-bell-icon", Boolean(query(".dingtalk-conversation-muted")));
        if (firstRow && firstRowRect) {
          const listRect = query(".dingtalk-conversation-list")?.getBoundingClientRect();
          check(
            "row-inset",
            Boolean(listRect) && Math.abs(firstRowRect.left - listRect.left - 6) <= 1,
            listRect ? `${Math.round(firstRowRect.left - listRect.left)}px` : "missing",
          );
        }
      }
      if (document.body.dataset.scenario.startsWith("dingtalk-status-")) {
        const text = query(".dingtalk-menu-status-text")?.textContent ?? "";
        const retry = query(".dingtalk-menu-retry");
        check("status-menu-open", Boolean(query(".dingtalk-page-menu:not([hidden])")));
        check("status-no-host-select", !query(".dingtalk-host-select"));
        check("status-no-login-label", !query(".dingtalk-menu-label"));
        if (document.body.dataset.scenario === "dingtalk-status-connected") {
          check(
            "status-connected",
            text.includes("已连接") && text.includes("示例用户") && text.includes("示例科技"),
            text,
          );
          check("status-retry-hidden", Boolean(retry?.hidden));
        } else if (document.body.dataset.scenario === "dingtalk-status-not-logged-in") {
          check("status-not-logged-in", text === "钉钉未登录", text);
          check("status-retry-visible", Boolean(retry) && !retry.hidden);
        } else {
          check("status-unreachable", text === "无法连接钉钉服务", text);
          check("status-retry-visible", Boolean(retry) && !retry.hidden);
        }
      }
      if (document.body.dataset.scenario === "dingtalk-list") {
        check("internal-group-tag", queryAll(".dingtalk-conversation-tag").length > 0);
        check(
          "unread-count-prefix",
          Boolean(query(".dingtalk-conversation-count")?.textContent?.includes("条")),
        );
        check("at-me-prefix", Boolean(query(".dingtalk-conversation-at-me")));
        const badge = query(".dingtalk-unread-badge");
        const badgeStyle = badge ? getComputedStyle(badge) : null;
        check(
          "unread-badge-visible",
          Boolean(badge) &&
            badgeStyle.backgroundColor !== "rgba(0, 0, 0, 0)" &&
            badgeStyle.color !== "rgba(0, 0, 0, 0)",
          badgeStyle ? `${badgeStyle.backgroundColor} / ${badgeStyle.color}` : "missing",
        );
        const dot = query(".dingtalk-avatar-unread");
        check(
          "muted-dot-visible",
          Boolean(dot) && getComputedStyle(dot).backgroundColor !== "rgba(0, 0, 0, 0)",
        );
        const avatar = query(".dingtalk-conversation .dingtalk-avatar");
        check(
          "avatar-two-characters",
          Boolean(avatar) && [...(avatar.textContent ?? "")].length <= 2,
          avatar?.textContent ?? "",
        );
        check(
          "preview-has-sender",
          queryAll(".dingtalk-conversation-preview").some((row) => row.textContent.includes("：")),
        );
        const lazyRow = [...queryAll(".dingtalk-conversation")].find((row) =>
          row.textContent?.includes("财务打款群"),
        );
        check(
          "preview-lazy-filled",
          Boolean(lazyRow?.textContent?.includes("懒加载")),
          lazyRow?.textContent ?? "",
        );
      }
      if (document.body.dataset.scenario === "dingtalk-direct") {
        check("direct-header-title", query(".dingtalk-main-title")?.textContent === "林晓");
        check(
          "direct-header-subtitle",
          query(".dingtalk-main-subtitle")?.textContent === "产品经理",
          query(".dingtalk-main-subtitle")?.textContent ?? "",
        );
        check("direct-messages", queryAll(".dingtalk-message").length > 0);
      }
      if (document.body.dataset.scenario === "dingtalk-open") {
        const image = query(".dingtalk-message-image--loaded");
        const rect = image?.getBoundingClientRect();
        check(
          "image-thumbnail-size",
          Boolean(rect) &&
            rect.width >= 120 &&
            rect.width <= 240 &&
            rect.height >= 80 &&
            rect.height <= 240 &&
            Math.abs(rect.width / rect.height - 1.6) < 0.06,
          rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : "missing",
        );
        check("image-lazy", queryAll(".dingtalk-message-image--loaded").length > 0);
        const imageBubble = query(".dingtalk-message-bubble--image");
        check(
          "image-direct-thumbnail",
          Boolean(imageBubble) &&
            getComputedStyle(imageBubble).paddingLeft === "0px" &&
            getComputedStyle(imageBubble).backgroundColor === "rgba(0, 0, 0, 0)",
          imageBubble
            ? `${getComputedStyle(imageBubble).paddingLeft} / ${getComputedStyle(imageBubble).backgroundColor}`
            : "missing",
        );
        check(
          "image-unavailable-text",
          queryAll(".dingtalk-message-image-fallback").some((node) =>
            node.textContent?.includes("[图片] 在手机上查看"),
          ),
        );
        const scroller = query(".dingtalk-message-list");
        const distance = scroller
          ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
          : Number.POSITIVE_INFINITY;
        check("message-list-at-bottom", distance <= 2, `distance=${Math.round(distance)}`);
        check("messages-rendered", queryAll(".dingtalk-message").length > 0);
        check(
          "date-separator",
          queryAll(".dingtalk-date-separator").length > 0,
          `${queryAll(".dingtalk-date-separator").length} separators`,
        );
        check("time-separator", queryAll(".dingtalk-time-separator").length > 0);
        check("message-quote", queryAll(".dingtalk-message-quote").length > 0);
        check("message-reaction", queryAll(".dingtalk-reaction").length > 0);
        check("message-bot-tag", queryAll(".dingtalk-bot-tag").length > 0);
        check("message-card", queryAll(".dingtalk-message-bubble--card").length > 0);
        check("message-card-title", queryAll(".dingtalk-message-card-title").length > 0);
        check("message-image", queryAll(".dingtalk-message-image-content").length > 0);
        check("message-file", queryAll(".dingtalk-message-file").length > 0);
        const bodies = queryAll(".dingtalk-message")
          .map((row) => row.textContent ?? "")
          .join("");
        check("no-raw-media-tags", !/mediaId|<imageContent>|fileId:/u.test(bodies));
        check("header-member-count", Boolean(query(".dingtalk-main-subtitle")?.textContent));
      }
      if (document.body.dataset.scenario === "dingtalk-heavy") {
        const heavy = window.__dingtalkHeavy;
        check("heavy-messages", heavy?.renderedMessages === 200, String(heavy?.renderedMessages));
        check(
          "heavy-long-task",
          Boolean(heavy) && heavy.longestLongTaskMs <= 100,
          `${Math.round(heavy?.longestLongTaskMs ?? 0)} ms`,
        );
        check(
          "heavy-shadow-nodes",
          Boolean(heavy) && heavy.shadowNodes <= 3_000,
          String(heavy?.shadowNodes ?? 0),
        );
      }
      if (document.body.dataset.scenario === "dingtalk-scrolled-top") {
        check("loading-older-visible", Boolean(query(".dingtalk-loading-older:not([hidden])")));
      }
      if (
        document.body.dataset.scenario === "dingtalk-search" ||
        document.body.dataset.scenario === "dingtalk-search-more"
      ) {
        const title = query(".dingtalk-search-result--conversation .dingtalk-search-title");
        const meta = query(".dingtalk-search-result--conversation .dingtalk-search-meta");
        const titleRect = title?.getBoundingClientRect();
        const metaRect = meta?.getBoundingClientRect();
        check(
          "search-title-full-width",
          Boolean(titleRect && titleRect.width > 200),
          titleRect ? `${Math.round(titleRect.width)}px` : "missing",
        );
        check(
          "search-meta-second-line",
          Boolean(titleRect && metaRect && metaRect.top >= titleRect.top + 10),
        );
        if (document.body.dataset.scenario === "dingtalk-search-more") {
          check(
            "search-expanded",
            queryAll(".dingtalk-search-result--conversation").length >= 4,
            `${queryAll(".dingtalk-search-result--conversation").length} rows`,
          );
        }
      }
      if (document.body.dataset.scenario === "dingtalk-search") {
        const panel = query(".dingtalk-search-results");
        const sidebar = query(".dingtalk-sidebar");
        check("search-inside-left-column", Boolean(panel && sidebar && sidebar.contains(panel)));
        check("search-results-visible", visible(panel));
        check("search-no-keyboard-hint", !query(".dingtalk-search-hint"));
        check(
          "search-highlight",
          queryAll(".dingtalk-search-mark").length > 0,
          `${queryAll(".dingtalk-search-mark").length} marks`,
        );
        check("chat-still-visible", queryAll(".dingtalk-message").length > 0);
        check(
          "search-more",
          queryAll(".dingtalk-search-more").length > 0,
          `${queryAll(".dingtalk-search-more").length} more buttons`,
        );
        check(
          "search-remote-group",
          queryAll(".dingtalk-search-title").some((row) => row.textContent.includes("示例Sprint")),
        );
      }
      if (
        document.body.dataset.scenario === "dingtalk-empty" ||
        document.body.dataset.scenario === "dingtalk-error"
      ) {
        check("list-empty-state", Boolean(query(".dingtalk-empty-list")));
      }
      if (document.body.dataset.scenario === "dingtalk-empty") {
        const main = query(".dingtalk-main");
        check(
          "empty-hides-right-pane",
          Boolean(main) && getComputedStyle(main).display === "none",
          main ? getComputedStyle(main).display : "missing",
        );
      }
      if (
        document.body.dataset.scenario === "agents-cards" ||
        document.body.dataset.scenario === "agents-cards-narrow"
      ) {
        const grid = query(".agents-grid");
        const columns = grid
          ? getComputedStyle(grid).gridTemplateColumns.split(/\s+/u).filter(Boolean).length
          : 0;
        const narrow = document.body.dataset.scenario === "agents-cards-narrow";
        check("card-grid-columns", narrow ? columns === 2 : columns >= 3, `${columns} columns`);
        check("agent-card-count", queryAll(".agent-card[data-agent-name]").length === 4);
        check("new-agent-card", Boolean(query(".agent-card--new")));
        const avatars = queryAll(".agent-card-avatar svg");
        check(
          "card-avatar-svg",
          avatars.length === 4 && avatars.every((avatar) => avatar.getAttribute("width") === "48"),
          `${avatars.length} avatars`,
        );
        check(
          "card-avatar-no-initials",
          avatars.every((avatar) => (avatar.textContent ?? "").trim() === ""),
        );
        const description = query(".agent-card-description");
        check(
          "card-description-clamped",
          Boolean(description) && getComputedStyle(description).webkitLineClamp === "2",
        );
        check("card-participating-tags", queryAll(".agent-card-tag--dispatch").length === 2);
        check(
          "card-last-dispatch",
          queryAll(".agent-card-tag").some((tag) => tag.textContent?.includes("最近派发")),
        );
        check(
          "card-default-model",
          queryAll(".agent-card-tag").some((tag) => tag.textContent?.includes("默认模型")),
        );
        check("card-no-status-dot", !query(".agent-card-status-dot"));
        const longCard = queryAll(".agent-card[data-agent-name]").find((card) =>
          card.dataset.agentName?.startsWith("发布与线上"),
        );
        const longName = longCard?.querySelector(".agent-card-name");
        check("long-name-card", Boolean(longCard));
        check(
          "long-name-ellipsis",
          Boolean(longName) &&
            getComputedStyle(longName).textOverflow === "ellipsis" &&
            longName.scrollWidth > longName.clientWidth,
          longName ? `${longName.scrollWidth}/${longName.clientWidth}` : "missing",
        );
        check(
          "long-name-tooltip",
          Boolean(longName) && longName.title === longCard?.dataset.agentName,
          longName?.title ?? "",
        );
        if (document.body.dataset.scenario === "agents-cards") {
          const tools = query(".agent-card-tools");
          check(
            "card-hover-tools",
            Boolean(tools) && getComputedStyle(tools).opacity === "1",
            tools ? getComputedStyle(tools).opacity : "missing",
          );
          check(
            "card-hover-action",
            Boolean(query(".agent-card-action")?.textContent?.includes("空闲")),
          );
        }
      }
      if (document.body.dataset.scenario === "agents-empty") {
        check("empty-new-card", queryAll(".agent-card--new").length === 1);
        check("empty-no-agent-cards", queryAll(".agent-card[data-agent-name]").length === 0);
        check(
          "empty-copy",
          query(".agents-empty-copy")?.textContent?.includes(
            "还没有智能体，新建一个让它帮你处理任务",
          ),
        );
      }
      if (document.body.dataset.scenario === "agents-menu") {
        const menu = query(".agent-menu");
        const rect = menu?.getBoundingClientRect();
        const anchor = query(
          '.agent-card[data-agent-name="writer"] .agent-card-menu',
        )?.getBoundingClientRect();
        check(
          "menu-anchored-under-button",
          Boolean(rect && anchor) && rect.top >= anchor.bottom - 1 && rect.left < anchor.right,
          rect && anchor ? `${Math.round(rect.top)}/${Math.round(anchor.bottom)}` : "missing",
        );
        check("menu-three-items", queryAll(".agent-menu-item").length === 3);
        const items = queryAll(".agent-menu-item");
        check(
          "menu-row-height",
          items.every((item) => {
            const height = item.getBoundingClientRect().height;
            return height >= 28 && height <= 32;
          }),
          items.map((item) => Math.round(item.getBoundingClientRect().height)).join(","),
        );
        const danger = query(".agent-menu-item--danger");
        check(
          "menu-danger-color",
          Boolean(danger) && getComputedStyle(danger).color !== getComputedStyle(items[0]).color,
          danger ? getComputedStyle(danger).color : "missing",
        );
        check(
          "menu-surface",
          Boolean(menu) && getComputedStyle(menu).boxShadow !== "none",
          menu ? getComputedStyle(menu).boxShadow : "missing",
        );
      }
      if (document.body.dataset.scenario === "agents-delete-confirm") {
        const dialog = query(".agent-confirm[open]");
        check("delete-dialog-open", Boolean(dialog));
        check(
          "delete-dialog-copy",
          Boolean(dialog?.textContent?.includes("确定删除智能体「writer」吗")),
          dialog?.textContent ?? "",
        );
        check(
          "delete-dialog-buttons",
          Boolean(dialog?.textContent?.includes("取消") && dialog?.textContent?.includes("删除")),
        );
      }
      if (document.body.dataset.scenario === "agents-edit") {
        const editor = query(".agent-editor");
        check("editor-open", Boolean(editor) && !editor.hidden);
        check("editing-card-border", Boolean(query(".agent-card--editing")));
        check("editor-instructions", Boolean(query(".agent-instructions")));
        check(
          "instruction-character-count",
          Boolean(query(".agent-character-count")?.textContent?.includes("字")),
        );
      }
      if (document.body.dataset.scenario === "agents-name-error") {
        const error = query('.agent-field-error[data-field="name"]');
        const input = query(".agent-editor .agent-field input");
        const inputRect = input?.getBoundingClientRect();
        const errorRect = error?.getBoundingClientRect();
        check(
          "name-error-under-input",
          Boolean(error && !error.hidden && errorRect && inputRect) &&
            errorRect.top >= inputRect.bottom - 1,
          error ? error.textContent : "missing",
        );
        check("name-error-copy", Boolean(error?.textContent?.includes("请填写名称")));
        check("name-error-not-at-form-bottom", Boolean(query(".agent-editor-error")?.hidden));
      }
      if (
        document.body.dataset.scenario === "agents-edit-dingtalk-on" ||
        document.body.dataset.scenario === "agents-edit-dingtalk-off"
      ) {
        const on = document.body.dataset.scenario === "agents-edit-dingtalk-on";
        const toggle = query(".agent-dingtalk-switch input");
        check("agent-dingtalk-switch", Boolean(toggle) && toggle.checked === on);
        check(
          "agent-dingtalk-body-state",
          query(".agent-dingtalk-body")?.getAttribute("data-disabled") === String(!on),
        );
        check(
          "agent-dingtalk-events",
          queryAll(".agent-dingtalk-body input[type=checkbox]").length === 3,
        );
        check("agent-dingtalk-no-tag-list", !query(".agent-dingtalk-body .dingtalk-agent-list"));
      }
      if (document.body.dataset.scenario === "agents-dingtalk-threshold") {
        check("listener-section", Boolean(query(".dingtalk-listener")));
        check("listener-only-threshold", Boolean(query(".dingtalk-listener .dingtalk-threshold")));
        check(
          "listener-no-global-switch",
          !query(".dingtalk-listener > .dingtalk-listener-card .dingtalk-switch"),
        );
        check("listener-no-agent-list", !query(".dingtalk-listener .dingtalk-agent-list"));
        check("listener-no-reply-control", !query(".dingtalk-listener .dingtalk-segmented"));
        check(
          "approval-copy",
          Boolean(query(".dingtalk-listener-note")?.textContent?.includes("审批由你决定")),
        );
        const note = query(".dingtalk-listener-note");
        const field = query(".dingtalk-listener-field");
        const card = query(".dingtalk-listener-card");
        const noteRect = note?.getBoundingClientRect();
        const fieldRect = field?.getBoundingClientRect();
        const cardRect = card?.getBoundingClientRect();
        check(
          "note-left-aligned",
          Boolean(noteRect && fieldRect && Math.abs(noteRect.left - fieldRect.left) <= 1),
          noteRect && fieldRect ? `${noteRect.left}/${fieldRect.left}` : "missing",
        );
        check(
          "note-bottom-padding",
          Boolean(noteRect && cardRect) &&
            cardRect.bottom - noteRect.bottom >= 8 &&
            cardRect.bottom - noteRect.bottom <= 24,
          noteRect && cardRect ? `${Math.round(cardRect.bottom - noteRect.bottom)}px` : "missing",
        );
      }
      if (document.body.dataset.scenario === "group-plus-menu") {
        check("add-machine-row", Boolean(query("[data-codexhost-add-machine-row]")));
      }
      if (
        document.body.dataset.scenario === "project-group-empty-machine" ||
        document.body.dataset.scenario === "project-group-all-empty"
      ) {
        const units = [...document.querySelectorAll(".preview-project-unit")];
        const hidden = units.filter(
          (unit) => unit.getAttribute("data-codexhost-project-group-empty") === "true",
        );
        const visible = units.filter((unit) => !hidden.includes(unit));
        const summary = query("[data-codexhost-project-group-header] span[aria-label]");
        check("native-units-retained", units.length === 2, String(units.length));
        check("one-machine-hidden", hidden.length === 1, String(hidden.length));
        check("one-machine-visible", visible.length === 1, String(visible.length));
        check(
          "hidden-machine-display-none",
          hidden.every((unit) => getComputedStyle(unit).display === "none"),
        );
        check(
          "visible-machine-display",
          visible.every((unit) => getComputedStyle(unit).display !== "none"),
        );
        check("visible-machine-count", summary?.textContent === "1 台", summary?.textContent ?? "");
        check(
          "hover-title-all-machines",
          summary?.getAttribute("title") === "示例新加坡 · 本机",
          summary?.getAttribute("title") ?? "",
        );
        check(
          "empty-placeholder-kept-in-first-machine",
          document.body.dataset.scenario !== "project-group-all-empty" ||
            Boolean(visible[0]?.textContent?.includes("暂无聊天")),
        );
      }
      if (document.body.dataset.scenario === "group-add-machine") {
        check("machine-menu", Boolean(query("[data-codexhost-add-machine-menu]")));
      }
      if (document.body.dataset.scenario === "group-add-machine-busy") {
        check(
          "machine-row-busy",
          query('[data-codexhost-add-machine-host="host-build"]')?.getAttribute("aria-busy") ===
            "true",
        );
      }
      if (document.body.dataset.scenario === "group-add-machine-error") {
        check(
          "machine-row-error",
          Boolean(
            query("[data-codexhost-add-machine-menu]")?.textContent?.includes(
              "创建目录失败：权限不足。",
            ),
          ),
        );
      }
      if (document.body.dataset.scenario === "at-entry") {
        const row = query("[data-codexhost-dingtalk-entry]");
        const section = query("[data-codexhost-workbench-section]");
        const scroller = query("[data-mention-list-scroll-area]");
        check("single-dingtalk-row", Boolean(row));
        check("entry-workbench-group", Boolean(section?.textContent?.includes("工作台")));
        check(
          "entry-helper-text",
          Boolean(row?.textContent.includes("打开钉钉工作台")),
          row?.textContent ?? "",
        );
        const jarvis = query("[data-codexhost-jarvis-entry-row]");
        check("single-jarvis-row", Boolean(jarvis));
        check(
          "shared-workbench-group",
          Boolean(jarvis) && section?.contains(jarvis) === true,
          jarvis?.textContent ?? "",
        );
        check(
          "workbench-section-in-native-scroller",
          Boolean(section && scroller && section.parentElement === scroller),
        );
        check("workbench-section-last", Boolean(scroller?.lastElementChild === section));
        check(
          "workbench-single-header",
          Boolean(
            section &&
            [...section.children].filter((child) => child.textContent?.trim() === "工作台")
              .length === 1,
          ),
        );
        check(
          "no-entry-overlay",
          !query("[data-codexhost-dingtalk-panel]") && !query("[data-codexhost-jarvis-panel]"),
        );
        check(
          "workbench-rows-native",
          queryAll("[data-codexhost-workbench-row]").every(
            (item) =>
              item.tagName === "BUTTON" &&
              item.getAttribute("data-list-navigation-item") === "true" &&
              Boolean(item.querySelector("[data-menu-row-content]")),
          ),
        );
      }
      if (document.body.dataset.scenario === "jarvis-settings") {
        const machineRows = queryAll(".settings-jarvis-row");
        check("jarvis-machine-rows", machineRows.length === 5, `${machineRows.length} rows`);
        check("jarvis-no-page-subtitle", !query(".settings-page-description"));
        check(
          "jarvis-no-section-subtitle",
          queryAll(".settings-jarvis-section .settings-page-description").length === 0,
        );
        const machinesSection = queryAll(".settings-jarvis-section").find((section) =>
          section.textContent?.includes("已安装的机器"),
        );
        check("jarvis-machines-title", Boolean(machinesSection));
        const machinesTitle = machinesSection?.querySelector(".settings-section-label");
        const refreshButton = machinesSection?.querySelector(".settings-jarvis-header button");
        const titleRect = machinesTitle?.getBoundingClientRect();
        const refreshRect = refreshButton?.getBoundingClientRect();
        check(
          "jarvis-refresh-in-title-row",
          Boolean(titleRect && refreshRect) &&
            Math.abs(
              (titleRect.top + titleRect.bottom) / 2 - (refreshRect.top + refreshRect.bottom) / 2,
            ) <= 8 &&
            refreshRect.left > titleRect.right,
        );
        check(
          "jarvis-no-threshold-control",
          !query(".settings-jarvis-section")?.textContent?.includes("条件识别阈值"),
        );
        check(
          "jarvis-single-refresh",
          queryAll(".settings-jarvis-row .settings-command-button").every(
            (button) => button.textContent !== "刷新",
          ),
        );
        check(
          "jarvis-key-status-quiet",
          !query(".settings-jarvis-status")?.textContent?.includes("已保存 API Key"),
          query(".settings-jarvis-status")?.textContent ?? "",
        );
      }
      if (document.body.dataset.scenario === "jarvis-entry") {
        const row = query("[data-codexhost-jarvis-entry-row]");
        const section = query("[data-codexhost-workbench-section]");
        const scroller = query("[data-mention-list-scroll-area]");
        check("jarvis-row", Boolean(row));
        check("no-mode-before-selection", !query("[data-codexhost-jarvis-mode]"));
        check(
          "jarvis-row-in-native-scroller",
          Boolean(section && scroller && section.parentElement === scroller),
        );
        check(
          "single-workbench-header",
          Boolean(
            section &&
            [...section.children].filter((child) => child.textContent?.trim() === "工作台")
              .length === 1,
          ),
        );
        check(
          "no-entry-overlay",
          !query("[data-codexhost-dingtalk-panel]") && !query("[data-codexhost-jarvis-panel]"),
        );
        check(
          "no-search-before-selection",
          (window.__jarvisPreviewSearchCalls ?? 0) === 0,
          String(window.__jarvisPreviewSearchCalls ?? 0),
        );
        check(
          "jarvis-row-helper",
          Boolean(row?.textContent.includes("搜索 Bug")),
          row?.textContent ?? "",
        );
      }
      if (
        document.body.dataset.scenario === "jarvis-mode-loading" ||
        document.body.dataset.scenario === "jarvis-mode-results" ||
        document.body.dataset.scenario === "jarvis-mode-prefilled" ||
        document.body.dataset.scenario === "jarvis-mode-empty" ||
        document.body.dataset.scenario === "jarvis-mode-error" ||
        document.body.dataset.scenario === "jarvis-mode-slow" ||
        document.body.dataset.scenario === "jarvis-mode-conditions" ||
        document.body.dataset.scenario === "jarvis-mode-chip-removed"
      ) {
        const mode = query("[data-codexhost-jarvis-mode]");
        const scroller = query("[data-mention-list-scroll-area]");
        check("mode-inside-native-list", Boolean(mode) && Boolean(scroller?.contains(mode)));
        check(
          "mode-no-overlay",
          !query("[data-codexhost-dingtalk-panel]") && !query("[data-codexhost-jarvis-panel]"),
        );
        check("mode-header", Boolean(mode?.textContent?.includes("Jarvis · Bug")));
        check("no-footer-hint", !mode?.textContent?.includes("↑↓ 选择"));
        const input = mode?.querySelector("input");
        check("search-field", Boolean(input));
        check("search-input-no-native-clear", input?.type === "text", input?.type ?? "");
        check("subtle-clear-button", Boolean(mode?.querySelector("[data-jarvis-clear]")));
        check(
          "search-field-focused",
          Boolean(input) && document.activeElement === input,
          document.activeElement?.tagName ?? "",
        );
      }
      if (document.body.dataset.scenario === "jarvis-entry-query") {
        const row = query("[data-codexhost-jarvis-entry-row]");
        check(
          "query-row-label",
          Boolean(row?.textContent?.includes("Jarvis：我还没处理完的bug")),
          row?.textContent ?? "",
        );
        check(
          "query-label-no-space-before-colon",
          !row?.textContent?.includes("Jarvis ："),
          row?.textContent ?? "",
        );
        check("query-no-mode", !query("[data-codexhost-jarvis-mode]"));
        check(
          "query-no-search-before-selection",
          (window.__jarvisPreviewSearchCalls ?? 0) === 0,
          String(window.__jarvisPreviewSearchCalls ?? 0),
        );
        check(
          "query-row-in-native-scroller",
          Boolean(query("[data-mention-list-scroll-area]")?.contains(row)),
        );
      }
      if (document.body.dataset.scenario === "jarvis-mode-prefilled") {
        const mode = query("[data-codexhost-jarvis-mode]");
        const input = mode?.querySelector("input");
        check("prefilled-query", input?.value === "示例买的最近的bug", input?.value ?? "");
        check(
          "prefill-token-removed",
          document.body.dataset.jarvisEditorText?.includes("@示例买") !== true,
          document.body.dataset.jarvisEditorText ?? "",
        );
        check(
          "prefill-search-started",
          document.body.dataset.jarvisSearchCalls === "1",
          document.body.dataset.jarvisSearchCalls ?? "",
        );
        check("prefill-result-rows", queryAll("[data-codexhost-jarvis-bug]").length >= 4);
      }
      if (document.body.dataset.scenario === "jarvis-mode-detached") {
        const mode = query("[data-codexhost-jarvis-mode]");
        const host = query("[data-codexhost-jarvis-detached]");
        check("detached-mode-survives", Boolean(mode) && Boolean(host?.contains(mode)));
        check("detached-native-menu-gone", !query(".preview-at-menu"));
        check("detached-results-kept", queryAll("[data-codexhost-jarvis-bug]").length >= 4);
        check(
          "detached-search-focused",
          document.activeElement === mode?.querySelector("input"),
          document.activeElement?.tagName ?? "",
        );
      }
      if (document.body.dataset.scenario === "jarvis-mode-loading") {
        check("loading-skeleton", queryAll("[data-codexhost-jarvis-skeleton]").length >= 3);
        check(
          "native-rows-hidden",
          [
            ...document.querySelectorAll(
              "[data-mention-list-scroll-area] > [data-mention-section-id]",
            ),
          ].every((section) => getComputedStyle(section).display === "none"),
        );
      }
      if (document.body.dataset.scenario === "jarvis-mode-results") {
        check("result-rows", queryAll("[data-codexhost-jarvis-bug]").length >= 4);
        check("result-chips", queryAll("[data-jarvis-chip]").length >= 2);
        check(
          "result-count",
          query("[data-jarvis-summary]")?.textContent === "4 条",
          query("[data-jarvis-summary]")?.textContent ?? "",
        );
      }
      if (document.body.dataset.scenario === "jarvis-mode-empty") {
        check(
          "empty-state",
          Boolean(
            query("[data-codexhost-jarvis-mode]")?.textContent?.includes("没有符合条件的 Bug"),
          ),
        );
        check("empty-keeps-chips", queryAll("[data-jarvis-chip]").length >= 2);
        check("no-result-rows", queryAll("[data-codexhost-jarvis-bug]").length === 0);
      }
      if (document.body.dataset.scenario === "jarvis-mode-error") {
        check(
          "error-message",
          Boolean(
            query("[data-codexhost-jarvis-mode]")?.textContent?.includes("Jarvis 未安装或未登录"),
          ),
        );
        check(
          "error-not-empty-state",
          !query("[data-codexhost-jarvis-mode]")?.textContent?.includes("没有符合条件的 Bug"),
        );
        check(
          "error-no-count",
          (query("[data-jarvis-summary]")?.textContent ?? "missing") === "",
          query("[data-jarvis-summary]")?.textContent ?? "",
        );
        check("error-settings-link", Boolean(query("[data-jarvis-settings]")));
      }
      if (document.body.dataset.scenario === "jarvis-mode-slow") {
        check(
          "slow-notice",
          Boolean(
            query("[data-codexhost-jarvis-mode]")?.textContent?.includes(
              "Jarvis 响应较慢，仍在查询…",
            ),
          ),
        );
        check("slow-keeps-skeleton", queryAll("[data-codexhost-jarvis-skeleton]").length >= 3);
      }
      if (document.body.dataset.scenario === "jarvis-mode-conditions") {
        check("condition-chips", queryAll("[data-jarvis-chip]").length >= 4);
        check("condition-results", queryAll("[data-codexhost-jarvis-bug]").length >= 2);
      }
      if (document.body.dataset.scenario === "jarvis-mode-chip-removed") {
        check("status-chip-removed", !query('[data-jarvis-chip="status:1"]'));
        check("other-chips-kept", queryAll("[data-jarvis-chip]").length >= 3);
      }
      if (
        document.body.dataset.scenario === "at-entry-native" ||
        document.body.dataset.scenario === "at-entry-native-visible"
      ) {
        check("entry-inside-native-scroller", document.body.dataset.entryNativeScroller === "true");
        check("entry-is-last-native-group", document.body.dataset.entryLastGroup === "true");
        check("single-dingtalk-row", document.body.dataset.entryRow === "true");
        check("entry-workbench-group", document.body.dataset.entryGroupTitle === "true");
        check("entry-helper-text", document.body.dataset.entryHelper === "true");
        check("entry-shared-section", document.body.dataset.entrySharedSection === "true");
        check(
          "single-workbench-header",
          document.body.dataset.entryHeaderCount === "1",
          document.body.dataset.entryHeaderCount ?? "",
        );
        check("no-entry-overlay", document.body.dataset.entryOverlay === "false");
        check("native-rows-are-buttons", document.body.dataset.entryNativeButtons === "true");
        if (document.body.dataset.scenario === "at-entry-native") {
          check("entry-opened-by-keyboard", document.body.dataset.entryOpened === "true");
          check("keyboard-handoff", document.body.dataset.entryKeyboardHandoff === "true");
          check("workbench-row-walk", document.body.dataset.entryWorkbenchWalk === "true");
        } else {
          const nativeList = document.querySelector("[data-mention-list-scroll-area]");
          const section = nativeList?.querySelector("[data-codexhost-workbench-section]");
          check("entry-still-mounted", Boolean(section && section.parentElement === nativeList));
        }
      }
      return result;
    });
    const heavyOpen =
      scenario === "dingtalk-heavy"
        ? await page.evaluate(() => {
            const heavy = window.__dingtalkHeavy;
            if (!heavy) return null;
            return {
              openToListMs: heavy.openToListMs,
              openToMessagesMs: heavy.openToMessagesMs,
              renderTimeMs: heavy.renderTimeMs,
              renderedMessages: heavy.renderedMessages,
              shadowNodes: heavy.shadowNodes,
              heapBaselineBytes: heavy.heapBaselineBytes,
              heapAfterOpenBytes: heavy.heapAfterOpenBytes,
              longestLongTaskMs: heavy.longestLongTaskMs,
              longTasks: heavy.longTasks,
              scenarioStartedAt: heavy.scenarioStartedAt,
              heapSupported: heavy.heapSupported,
            };
          })
        : null;
    const filename = `${scenario}-${theme}.png`;
    await page.screenshot({
      path: path.join(outputDirectory, filename),
      fullPage: false,
      animations: "disabled",
    });
    let metrics = null;
    if (heavyOpen) {
      const heavyClose = await page.evaluate(() => window.__dingtalkHeavy?.close() ?? null);
      metrics = {
        ...heavyOpen,
        ...(heavyClose ?? {}),
        heapAfterOpenDeltaBytes: heavyOpen.heapAfterOpenBytes - heavyOpen.heapBaselineBytes,
        heapAfterCloseDeltaBytes:
          (heavyClose?.heapAfterCloseBytes ?? heavyOpen.heapAfterOpenBytes) -
          heavyOpen.heapBaselineBytes,
      };
      checks.push({
        name: "heavy-heap-after-close",
        ok: !heavyOpen.heapSupported || metrics.heapAfterCloseDeltaBytes <= 10 * 1024 * 1024,
        detail: heavyOpen.heapSupported
          ? `${(metrics.heapAfterCloseDeltaBytes / (1024 * 1024)).toFixed(1)} MB`
          : "performance.memory unavailable",
      });
    }
    report.captures.push({
      scenario,
      theme,
      approximate: theme === "dark" && shadowContext.darkApproximate === true,
      screenshot: path.join(outputDirectory, filename),
      pageErrors: errors,
      checks,
      ...(metrics ? { metrics } : {}),
      ok: errors.length === 0 && checks.every((check) => check.ok),
    });
    await page.close();
    console.log(`[ui-preview] ${filename}`);
  }
}

await browser.close();
if (server) server.kill();
await writeFile(
  path.join(outputDirectory, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
const failed = report.captures.filter((capture) => !capture.ok);
console.log(
  `[ui-preview] ${report.captures.length - failed.length}/${report.captures.length} captures passed`,
);
if (failed.length > 0) {
  for (const capture of failed) {
    console.error(
      `[ui-preview] ${capture.scenario}/${capture.theme}: ${capture.checks
        .filter((check) => !check.ok)
        .map((check) => check.name)
        .join(
          ", ",
        )}${capture.pageErrors.length ? ` errors=${capture.pageErrors.join(" | ")}` : ""}`,
    );
  }
  process.exitCode = 1;
}
