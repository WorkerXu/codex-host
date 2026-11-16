#!/usr/bin/env node
/* global document, getComputedStyle */
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
  "dingtalk-list",
  "dingtalk-status-connected",
  "dingtalk-status-not-logged-in",
  "dingtalk-status-unreachable",
  "dingtalk-open",
  "dingtalk-direct",
  "dingtalk-scrolled-top",
  "dingtalk-recent",
  "dingtalk-search",
  "dingtalk-search-more",
  "dingtalk-select",
  "dingtalk-empty",
  "dingtalk-error",
  "agents-cards",
  "agents-cards-narrow",
  "agents-empty",
  "agents-edit",
  "agents-dingtalk-settings",
  "agents-dingtalk-disabled",
  "group-plus-menu",
  "group-add-machine",
  "group-add-machine-busy",
  "group-add-machine-error",
  "at-entry",
  "at-entry-native",
  "at-entry-native-visible",
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

const browser = await chromium.launch();
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
            let sample = null;
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
        check("list-switch", queryAll(".dingtalk-list-switch-button").length === 2);
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
        check("direct-header-title", query(".dingtalk-main-title")?.textContent === "吴菁");
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
        check("image-no-loading-strip", !query(".dingtalk-message-image--loading"));
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
      if (document.body.dataset.scenario === "dingtalk-recent") {
        const rows = queryAll(".dingtalk-conversation");
        check("recent-rows", rows.length > 0 && rows.length <= 10, `${rows.length} rows`);
        check(
          "recent-mine-preview",
          queryAll(".dingtalk-conversation-preview").every((row) =>
            row.textContent.startsWith("我："),
          ),
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
        check("search-keyboard-hint", Boolean(query(".dingtalk-search-hint:not([hidden])")));
        check(
          "search-remote-group",
          queryAll(".dingtalk-search-title").some((row) => row.textContent.includes("示例Sprint")),
        );
      }
      if (document.body.dataset.scenario === "dingtalk-select") {
        const bar = query(".dingtalk-selection-bar");
        check(
          "selection-bar",
          Boolean(bar) && !bar.hidden && bar.textContent.includes("已选 3 条"),
          bar?.textContent ?? "",
        );
      }
      if (
        document.body.dataset.scenario === "dingtalk-empty" ||
        document.body.dataset.scenario === "dingtalk-error"
      ) {
        check("list-empty-state", Boolean(query(".dingtalk-empty-list")));
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
      if (
        document.body.dataset.scenario === "agents-dingtalk-settings" ||
        document.body.dataset.scenario === "agents-dingtalk-disabled"
      ) {
        check("listener-section", Boolean(query(".dingtalk-listener")));
        check("listener-events", queryAll(".dingtalk-listener-events input").length === 3);
        check(
          "approval-copy",
          Boolean(
            query(".dingtalk-listener-note")?.textContent?.includes("审批：智能体按你的配置处理"),
          ),
        );
      }
      if (document.body.dataset.scenario === "agents-dingtalk-disabled") {
        check("listener-disabled", Boolean(query('.dingtalk-listener-body[data-disabled="true"]')));
        check(
          "bulk-links-disabled",
          queryAll(".dingtalk-field-actions .dingtalk-text-button").every(
            (button) => button.disabled,
          ),
        );
      }
      if (document.body.dataset.scenario === "group-plus-menu") {
        check("add-machine-row", Boolean(query("[data-codexhost-add-machine-row]")));
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
        check("single-dingtalk-row", Boolean(row));
        check(
          "entry-workbench-group",
          Boolean(query("[data-codexhost-dingtalk-section]")?.textContent?.includes("工作台")),
        );
        check(
          "entry-helper-text",
          Boolean(row?.textContent.includes("打开钉钉工作台")),
          row?.textContent ?? "",
        );
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
        if (document.body.dataset.scenario === "at-entry-native") {
          check("entry-opened-by-keyboard", document.body.dataset.entryOpened === "true");
        } else {
          const nativeList = document.querySelector("#native-at-menu .vertical-scroll-fade-mask");
          const section = nativeList?.querySelector("[data-codexhost-dingtalk-section]");
          check("entry-still-mounted", Boolean(section && section.parentElement === nativeList));
        }
      }
      return result;
    });
    const filename = `${scenario}-${theme}.png`;
    await page.screenshot({
      path: path.join(outputDirectory, filename),
      fullPage: false,
      animations: "disabled",
    });
    report.captures.push({
      scenario,
      theme,
      approximate: theme === "dark" && shadowContext.darkApproximate === true,
      screenshot: path.join(outputDirectory, filename),
      pageErrors: errors,
      checks,
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
