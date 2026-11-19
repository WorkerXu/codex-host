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
  "skills-matrix",
  "skills-list",
  "skills-filter",
  "skills-agent-detail",
  "skills-agent-native",
  "skills-badge-undo",
  "skills-badge-unlink",
  "skills-hover",
  "skills-focus",
  "skills-agents",
  "skills-exclusions",
  "skills-link-choice",
  "skills-sync-selection",
  "skills-conflict",
  "skills-conflict-files",
  "skills-conflict-files-focus",
  "skills-link-preview",
  "skills-link-focus",
  "skills-link-checked-focus",
  "skills-agents-focus",
  "dingtalk-heavy",
  "dingtalk-list",
  "dingtalk-deduplicated",
  "dingtalk-send-echo",
  "dingtalk-send-ack",
  "dingtalk-hover",
  "dingtalk-conversation-hover",
  "dingtalk-image-unavailable",
  "dingtalk-lightbox",
  "dingtalk-at-picker",
  "dingtalk-at-chip",
  "dingtalk-at-send",
  "dingtalk-header-menu",
  "dingtalk-page-menu",
  "dingtalk-empty-menu",
  "dingtalk-empty-menu-narrow",
  "dingtalk-header-menu-open",
  "dingtalk-header-menu-narrow",
  "dingtalk-unread-open",
  "dingtalk-unread-left",
  "dingtalk-live",
  "dingtalk-status-connected",
  "dingtalk-status-not-logged-in",
  "dingtalk-status-unreachable",
  "dingtalk-open",
  "dingtalk-direct",
  "dingtalk-scrolled-top",
  "dingtalk-search",
  "dingtalk-search-empty",
  "dingtalk-search-contacts",
  "dingtalk-contact-open",
  "dingtalk-loading",
  "dingtalk-search-more",
  "dingtalk-empty",
  "dingtalk-error",
  "agents-cards",
  "agents-dispatch-status",
  "agents-dispatch-missing-key",
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
  "at-entry",
  "at-entry-native",
  "at-entry-native-visible",
  "harness-picker",
  "thread-folders-local",
  "thread-folders-remote",
  "thread-folders-existing",
  "thread-folders-limited",
  "jarvis-entry",
  "jarvis-entry-query",
  "jarvis-projects",
  "jarvis-projects-search",
  "jarvis-projects-loading",
  "jarvis-projects-empty",
  "jarvis-projects-error",
  "jarvis-bugs-preview",
  "jarvis-bugs-conditions",
  "jarvis-bugs-parsing",
  "jarvis-bugs-timeout",
  "jarvis-bugs-empty",
  "jarvis-bugs-error",
  "jarvis-bugs-loading",
  "jarvis-bugs-many",
  "jarvis-bugs-chip-removed",
  "model-service-empty",
  "model-service-configured",
  "model-service-testing",
  "model-service-error",
  "model-service-focus",
  "model-service-hover",
  "model-service-edit",
  "model-service-add",
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

async function pointAt(page, selector, index = 0) {
  const locator = page.locator(selector).nth(index);
  await locator.waitFor({ state: "visible", timeout: 10_000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No box for ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

async function realClick(page, selector, index = 0) {
  const point = await pointAt(page, selector, index);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.up();
}

async function realHover(page, selector, index = 0) {
  const point = await pointAt(page, selector, index);
  await page.mouse.move(point.x, point.y, { steps: 6 });
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

const hoverSelectors = new Map([
  ["skills-hover", "[data-skills-refresh]"],
  ["agents-menu", ".agent-menu-item"],
  ["at-entry", "[data-codexhost-jarvis-entry-row]"],
  ["at-entry-native-visible", "[data-codexhost-dingtalk-entry]"],
  ["jarvis-projects", "[data-codexhost-jarvis-project]"],
  ["jarvis-bugs-preview", "[data-codexhost-jarvis-bug]"],
  ["jarvis-bugs-conditions", "[data-codexhost-jarvis-bug]"],
  ["jarvis-bugs-many", "[data-codexhost-jarvis-bug]"],
  ["harness-picker", '#preview-harness-picker-agent-menu button[data-agent="grok"]'],
]);

/** Real input bridge: the preview scenario awaits Playwright's mouse/keyboard. */
async function installPreviewInput(page) {
  await page.addInitScript(() => {
    const elements = new Map();
    let sequence = 0;
    window.__codexhostPreviewElement = (id) => elements.get(id) ?? null;
    window.__codexhostPreviewInput = {
      request(element, action, options) {
        return new Promise((resolve) => {
          const id = `preview-input-${++sequence}`;
          elements.set(id, element);
          element.setAttribute("data-preview-input-id", id);
          window.__codexhostPreviewRequest = { id, action, options: options ?? null };
          window.__codexhostPreviewResolve = () => {
            element.removeAttribute("data-preview-input-id");
            elements.delete(id);
            window.__codexhostPreviewRequest = null;
            window.__codexhostPreviewResolve = null;
            resolve();
          };
        });
      },
    };
  });
}

async function runPreviewInputs(page) {
  for (;;) {
    const request = await page.evaluate(() => window.__codexhostPreviewRequest ?? null);
    if (!request) return;
    const box = await page.evaluate((id) => {
      const element = window.__codexhostPreviewElement(id);
      if (!element) return null;
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, request.id);
    if (!box) throw new Error(`Preview input target disappeared: ${request.id}`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    if (request.action === "type") {
      await page.evaluate((id) => window.__codexhostPreviewElement(id)?.focus(), request.id);
      await page.keyboard.type(request.options?.text ?? "");
    } else if (request.action === "key") {
      await page.evaluate((id) => window.__codexhostPreviewElement(id)?.focus(), request.id);
      await page.keyboard.press(request.options?.key ?? "");
    } else {
      await page.mouse.move(x, y);
      if (request.action === "click") {
        await page.mouse.down();
        await page.mouse.up();
      } else if (request.action === "wheel") {
        await page.mouse.wheel(0, request.options?.deltaY ?? 0);
      }
    }
    await page.waitForTimeout(60);
    await page.evaluate(() => window.__codexhostPreviewResolve());
    await page.waitForFunction(
      () => document.body.dataset.ready === "true" || window.__codexhostPreviewRequest,
      undefined,
      { timeout: 20_000 },
    );
  }
}

async function hoverPreviewElement(page, selector) {
  const box = await page.evaluate((value) => {
    const shell = document.querySelector("[data-codexhost-settings-shell]")?.shadowRoot;
    const element = shell?.querySelector(value) ?? document.querySelector(value);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(150);
  return true;
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
    await installPreviewInput(page);
    await page.goto(`${baseUrl}/?scenario=${scenario}&theme=${theme}`, {
      waitUntil: "load",
    });
    await page.waitForFunction(
      () => document.body.dataset.ready === "true" || window.__codexhostPreviewRequest,
      undefined,
      { timeout: 20_000 },
    );
    await runPreviewInputs(page);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 20_000 });
    const wheelScenario = scenario === "jarvis-bugs-many";
    if (wheelScenario) {
      const box = await page.evaluate(() => {
        const element = document.querySelector('[data-jarvis-results="true"]');
        if (!element) return null;
        window.__jarvisScrollBefore = element.scrollTop;
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      if (!box) throw new Error(`${scenario}/${theme}: Jarvis results are missing`);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 480);
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        const element = document.querySelector('[data-jarvis-results="true"]');
        document.body.dataset.jarvisScrolled = String(
          Boolean(element) && element.scrollTop > window.__jarvisScrollBefore,
        );
      });
    }
    if (scenario.startsWith("agents-dispatch-")) {
      await realClick(page, ".agent-card[data-agent-file]", 0);
      await page.waitForSelector(".agent-editor:not([hidden])");
      const point = await pointAt(page, ".agent-editor-body");
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(200);
    }
    if (scenario === "agents-cards") {
      await page.hover(".agent-card[data-agent-name]");
    }
    const hoverSelector = hoverSelectors.get(scenario);
    if (scenario === "dingtalk-send-echo" || scenario === "dingtalk-send-ack") {
      await realClick(page, ".dingtalk-conversation", 2);
      await page.waitForFunction(() =>
        document
          .querySelector("[data-codexhost-settings-shell]")
          ?.shadowRoot?.querySelector(".dingtalk-composer-input")
          ?.getAttribute("placeholder")
          ?.includes("林晓"),
      );
      await page.waitForSelector(".dingtalk-message");
      await realClick(page, ".dingtalk-composer-input");
      await page.keyboard.type("已收到，我会核对这份材料。");
      await realClick(page, ".dingtalk-send-button");
      await page.waitForSelector('[data-message-id^="sent-"]');
      await page.waitForTimeout(700);
    }
    if (scenario === "dingtalk-deduplicated") {
      await realClick(page, ".dingtalk-conversation", 0);
      const list = await pointAt(page, ".dingtalk-message-list");
      await page.mouse.move(list.x, list.y);
      await page.mouse.wheel(0, 1200);
    }
    let skillsTooltipDismissed = false;
    if (scenario === "skills-hover") {
      await hoverPreviewElement(page, "[data-skills-refresh]");
      await realClick(page, "[data-skills-refresh]");
      await page.keyboard.press("Escape");
      skillsTooltipDismissed = !(await page.locator('[role="tooltip"]').isVisible());
      await page.mouse.move(0, 0);
      await page.keyboard.press("Tab");
    }
    if (scenario === "dingtalk-hover") {
      await realHover(page, ".dingtalk-message", -1);
      await page.waitForTimeout(150);
    }
    if (scenario === "dingtalk-conversation-hover") {
      await realHover(page, ".dingtalk-conversation", 1);
    }
    if (
      [
        "dingtalk-search",
        "dingtalk-search-empty",
        "dingtalk-search-contacts",
        "dingtalk-contact-open",
      ].includes(scenario)
    ) {
      await realClick(page, ".dingtalk-search-input");
      await page.keyboard.type(
        scenario.endsWith("-empty")
          ? "不存在的会话XYZ"
          : ["dingtalk-search-contacts", "dingtalk-contact-open"].includes(scenario)
            ? "罗浩"
            : "示例Sprint",
      );
      await page.waitForSelector(
        scenario.endsWith("-empty")
          ? ".dingtalk-search-results .dingtalk-empty-list"
          : ".dingtalk-search-result",
      );
      if (scenario === "dingtalk-contact-open") {
        await realClick(
          page,
          '.dingtalk-search-group[data-kind="contacts"] .dingtalk-search-result',
        );
        await page.waitForSelector(".dingtalk-message[data-message-id]");
      }
    }
    if (scenario === "dingtalk-image-unavailable") {
      const list = await pointAt(page, ".dingtalk-message-list");
      const target = await page.locator('[data-message-id="msg-launch-193"]').boundingBox();
      if (!target) throw new Error("Missing image fixture is not rendered");
      await page.mouse.move(list.x, list.y);
      await page.mouse.wheel(0, target.y + target.height / 2 - list.y);
      await page.waitForSelector(
        '[data-message-id="msg-launch-193"] .dingtalk-message-image--unavailable',
      );
    }
    if (scenario === "dingtalk-lightbox") {
      await realClick(page, ".dingtalk-message-image--loaded", 0);
      await page.waitForSelector(".dingtalk-lightbox:not([hidden])", { timeout: 10_000 });
      await page.waitForTimeout(350);
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(250);
    }
    if (scenario === "dingtalk-at-picker") {
      await realClick(page, ".dingtalk-composer-input");
      await page.keyboard.type("@");
      await page.waitForSelector(".dingtalk-mention-picker:not([hidden])", { timeout: 10_000 });
      await page.waitForTimeout(300);
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(120);
    }
    if (scenario === "dingtalk-at-chip" || scenario === "dingtalk-at-send") {
      await realClick(page, ".dingtalk-composer-input");
      await page.keyboard.type("@林");
      await page.waitForSelector(".dingtalk-mention-picker:not([hidden])", { timeout: 10_000 });
      await page.waitForTimeout(350);
      const picker = await page.locator(".dingtalk-mention-picker").boundingBox();
      if (!picker) throw new Error("Mention picker is missing");
      // First option row below the picker heading; real pointer, not element.click().
      await page.mouse.click(picker.x + 120, picker.y + 44);
      await page.waitForTimeout(150);
      await page.keyboard.type("请看一下今天的发布进度。");
      await page.waitForTimeout(120);
      if (scenario === "dingtalk-at-chip") {
        await page.waitForTimeout(150);
      } else {
        await realClick(page, ".dingtalk-send-button");
        await page.waitForFunction(() => Boolean(window.__dingtalkPreviewSent), undefined, {
          timeout: 10_000,
        });
        await page.waitForTimeout(450);
      }
    }
    if (scenario === "dingtalk-header-menu") {
      const before = await page.evaluate(() => window.__dingtalkPreviewMessageCalls ?? 0);
      await page.evaluate((calls) => {
        window.__dingtalkBaselineMessages = calls;
      }, before);
      await realClick(page, ".dingtalk-main-actions .dingtalk-more-button");
      await page.waitForSelector(".dingtalk-header-menu:not([hidden])", { timeout: 10_000 });
      const action = await pointAt(page, ".dingtalk-header-menu .dingtalk-menu-action");
      await page.mouse.move(action.x, action.y);
      await page.mouse.down();
      await page.evaluate(() => {
        const shadow = document.querySelector("[data-codexhost-settings-shell]")?.shadowRoot;
        window.__dingtalkMenuOpenAfterDown = Boolean(
          shadow?.querySelector(".dingtalk-header-menu:not([hidden])"),
        );
      });
      await page.mouse.up();
      await page.waitForFunction(
        () => {
          const shadow = document.querySelector("[data-codexhost-settings-shell]")?.shadowRoot;
          return Boolean(shadow?.querySelector(".dingtalk-header-menu[hidden]"));
        },
        undefined,
        { timeout: 10_000 },
      );
      await page.waitForFunction(
        (calls) => (window.__dingtalkPreviewMessageCalls ?? 0) > calls,
        before,
        { timeout: 10_000 },
      );
    }
    if (scenario === "dingtalk-page-menu") {
      await realClick(page, ".dingtalk-sidebar .dingtalk-more-button");
      await page.waitForSelector(".dingtalk-page-menu:not([hidden])", { timeout: 10_000 });
      const status = await pointAt(page, ".dingtalk-page-menu .dingtalk-menu-status");
      await page.mouse.move(status.x, status.y);
      await page.mouse.down();
      await page.evaluate(() => {
        const shadow = document.querySelector("[data-codexhost-settings-shell]")?.shadowRoot;
        window.__dingtalkPageMenuOpenAfterDown = Boolean(
          shadow?.querySelector(".dingtalk-page-menu:not([hidden])"),
        );
      });
      await page.mouse.up();
      await page.waitForTimeout(150);
    }
    if (scenario.startsWith("dingtalk-empty-menu")) {
      await realClick(page, ".dingtalk-sidebar .dingtalk-more-button");
      await page.waitForSelector(".dingtalk-page-menu:not([hidden])");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".dingtalk-page-menu:not([hidden])", { state: "hidden" });
      await realClick(page, ".dingtalk-sidebar .dingtalk-more-button");
      await page.waitForSelector(".dingtalk-page-menu:not([hidden])");
      if (scenario.endsWith("-narrow")) {
        await page.setViewportSize({ width: 360, height: 140 });
        await page.waitForFunction(() => {
          const root = document.querySelector("[data-codexhost-settings-shell]")?.shadowRoot;
          const anchor = root
            ?.querySelector(".dingtalk-sidebar .dingtalk-more-button")
            ?.getBoundingClientRect();
          const menu = root?.querySelector(".dingtalk-page-menu")?.getBoundingClientRect();
          return anchor && menu && menu.top >= 8 && menu.bottom <= anchor.top - 3;
        });
        await page.evaluate(() => {
          window.__dingtalkMenuFlippedAbove = true;
        });
        await page.setViewportSize({ width: 360, height: 900 });
      }
    }
    if (scenario === "dingtalk-header-menu-open" || scenario === "dingtalk-header-menu-narrow") {
      await realClick(page, ".dingtalk-main-actions .dingtalk-more-button");
      await page.waitForSelector(".dingtalk-header-menu:not([hidden])");
      if (scenario.endsWith("-narrow")) await page.setViewportSize({ width: 640, height: 900 });
    }
    if (scenario === "dingtalk-live") {
      const list = await pointAt(page, ".dingtalk-message-list");
      await page.mouse.move(list.x, list.y);
      await page.mouse.wheel(0, 1_200);
      await page.waitForTimeout(450);
    }
    if (scenario === "dingtalk-scrolled-top") {
      const list = await pointAt(page, ".dingtalk-message-list");
      await page.mouse.move(list.x, list.y);
      await page.mouse.wheel(0, -100_000);
      await page.waitForTimeout(500);
      await page.waitForSelector(".dingtalk-loading-older:not([hidden])", { timeout: 10_000 });
      await page.waitForTimeout(250);
    }
    if (scenario === "dingtalk-unread-open" || scenario === "dingtalk-unread-left") {
      await realClick(page, ".dingtalk-conversation:has(.dingtalk-unread-badge)", 0);
      await page.waitForTimeout(350);
      if (scenario === "dingtalk-unread-left") {
        await realClick(page, ".dingtalk-conversation", 2);
        await page.waitForTimeout(350);
      }
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
      if (
        ["dingtalk-search-contacts", "dingtalk-contact-open"].includes(
          document.body.dataset.scenario,
        )
      ) {
        const groups = queryAll(".dingtalk-search-group[data-kind]");
        check(
          "contacts-before-groups",
          groups[0]?.dataset.kind === "contacts" && groups[1]?.dataset.kind === "groups",
        );
        check(
          "contact-present",
          groups[0]?.textContent.includes("罗浩") &&
            groups[0]?.textContent.includes("高级前端开发工程师"),
        );
        if (document.body.dataset.scenario === "dingtalk-contact-open") {
          check(
            "contact-opens-direct-chat",
            query(".dingtalk-main-title")?.textContent === "罗浩" &&
              query(".dingtalk-main-tag")?.hidden,
          );
          check("contact-open-messages", queryAll(".dingtalk-message").length > 0);
        }
      }
      if (["dingtalk-send-echo", "dingtalk-send-ack"].includes(document.body.dataset.scenario)) {
        const echoes = queryAll(".dingtalk-message").filter((row) =>
          row.textContent.includes("已收到，我会核对这份材料。"),
        );
        check("send-echo-once", echoes.length === 1);
        check("send-echo-on-right", echoes[0]?.classList.contains("dingtalk-message--mine"));
        check("send-echo-no-local-placeholder", !query('[data-message-id^="local-"]'));
        check(
          "send-open-row-no-unread",
          !query('.dingtalk-conversation[aria-selected="true"] .dingtalk-unread-badge'),
        );
      }
      if (document.body.dataset.scenario === "dingtalk-deduplicated") {
        const ids = queryAll(".dingtalk-message").map((row) => row.dataset.messageId);
        check("message-ids-unique", new Set(ids).size === ids.length);
        check(
          "replayed-message-once",
          ids.filter((id) => id.startsWith("preview-live-")).length === 1,
        );
      }
      check(
        "native-desktop-theme",
        document.body.dataset.nativeTheme === document.body.dataset.theme,
      );
      if (document.body.dataset.scenario?.startsWith("hub-")) {
        check("hub-native-theme", document.documentElement.dataset.nativeTheme === "true");
        check("hub-no-native-select", queryAll(".hub-page select").length === 0);
        check("hub-no-host-select", !query('.hub-select[aria-label="主机"]'));
        if (["hub-servers", "hub-memory"].includes(document.body.dataset.scenario))
          check(
            "hub-updated-age",
            /^更新于 (刚刚|\d+ 分钟前|\d+ 小时前|\d+ 天前)$/u.test(
              query(".hub-updated")?.textContent ?? "",
            ),
          );
        check(
          "hub-no-developer-fields",
          !query(".hub-page")?.textContent.includes("session-") &&
            !query(".hub-page")?.textContent.includes("调用 —"),
        );
        const scenario = document.body.dataset.scenario;
        if (scenario?.startsWith("hub-mcp-")) {
          check("hub-mcp-two-tabs", queryAll('.hub-page-tabs [role="tab"]').length === 2);
          check(
            "hub-mcp-tab-semantics",
            query(".hub-page-tabs")?.getAttribute("role") === "tablist" &&
              queryAll('.hub-page-tabs [role="tab"]').every(
                (tab) => tab.hasAttribute("aria-controls") && tab.hasAttribute("aria-selected"),
              ) &&
              queryAll(".hub-tab-panel").every(
                (panel) =>
                  panel.getAttribute("role") === "tabpanel" &&
                  panel.hasAttribute("aria-labelledby"),
              ),
          );
          check("hub-mcp-one-visible-panel", queryAll(".hub-tab-panel:not([hidden])").length === 1);
          const visiblePanel = query(".hub-tab-panel:not([hidden])");
          check(
            "hub-mcp-visible-panel-bounded",
            queryAll(".hub-tab-panel:not([hidden]) .hub-server").length <= 12 &&
              queryAll(".hub-tab-panel:not([hidden]) .hub-key").length <= 20,
          );
          if (
            scenario === "hub-mcp-keys" ||
            scenario === "hub-mcp-keys-page-2" ||
            scenario === "hub-mcp-keys-tab-hover"
          )
            check(
              "hub-mcp-keys-pager",
              Boolean(visiblePanel?.querySelector(".hub-pagination")) &&
                Boolean(visiblePanel?.querySelector(".hub-key")),
            );
        }
        if (scenario === "hub-servers") {
          const disabled = query('.hub-server[data-disabled="true"]');
          check(
            "hub-disabled-content-dimmed",
            disabled &&
              Number(getComputedStyle(disabled.querySelector(".hub-server-title")).opacity) < 1 &&
              !disabled.querySelector('[role="switch"]').disabled,
          );
          check(
            "hub-metadata-separators",
            getComputedStyle(query(".hub-server-meta span + span"), "::before").content.includes(
              "·",
            ),
          );
        }
        if (["hub-memory", "hub-memory-search", "hub-memory-empty"].includes(scenario)) {
          const values = queryAll(".hub-stat-value").map((element) => {
            const style = getComputedStyle(element);
            return `${style.fontSize}/${style.fontWeight}`;
          });
          check("hub-uniform-statistics", values.length === 3 && new Set(values).size === 1);
          if (scenario !== "hub-memory")
            check(
              "hub-search-count-heading",
              /搜索结果 · \d+ 条/u.test(query(".hub-section-head")?.textContent ?? ""),
            );
        }
        if (scenario === "hub-header-rows") {
          const add = query(".hub-header-editor > button");
          check(
            "hub-header-add-aligned",
            Math.abs(
              add.getBoundingClientRect().left -
                query(".hub-header-row input").getBoundingClientRect().left,
            ) < 2 && add.querySelector("svg"),
          );
        }
        if (
          [
            "hub-connection-connect",
            "hub-connection-replace",
            "hub-connection-test-error",
            "hub-connection-scoped-error",
          ].includes(scenario)
        ) {
          const input = query('.hub-dialog input[type="password"]');
          check("hub-key-masked", input && input.autocomplete === "off");
          if (
            scenario === "hub-connection-test-error" ||
            scenario === "hub-connection-scoped-error"
          )
            check("hub-failed-key-cleared", input?.value === "");
        }
        if (scenario === "hub-connection-test-error")
          check(
            "hub-invalid-key-message",
            query(".hub-dialog .hub-status")?.textContent === "密钥不正确",
          );
        if (scenario === "hub-connection-scoped-error")
          check(
            "hub-scoped-key-message",
            query(".hub-dialog .hub-status")?.textContent ===
              "这个密钥只能访问部分服务器，管理需要“全部访问”类型的密钥",
          );
        if (["hub-connection-empty", "hub-connection-disconnected"].includes(scenario))
          check(
            "hub-unconfigured-state",
            query(".hub-connection-state h3")?.textContent === "连接 MCPHub" &&
              !visible(query('[aria-label="MCPHub 连接设置"]')),
          );
        if (scenario === "hub-connection-empty") {
          const state = query(".hub-connection-state--empty");
          const icon = state?.querySelector("svg");
          const button = state?.querySelector("button");
          check(
            "hub-empty-content",
            icon &&
              button?.textContent === "连接" &&
              state?.textContent.includes(
                "需要“全部访问”类型的密钥（MCPHub 设置 › 密钥 中 accessType 为全部的密钥，例如 admin）",
              ),
          );
          const pageRect = query(".settings-page").getBoundingClientRect();
          const center =
            icon && button
              ? (icon.getBoundingClientRect().top + button.getBoundingClientRect().bottom) / 2
              : 0;
          check(
            "hub-empty-centered",
            Math.abs(center - (pageRect.top + pageRect.bottom) / 2) < 48,
            String(center),
          );
        }
        if (scenario === "hub-connection-connect")
          check(
            "hub-connection-host-guidance",
            query(".hub-dialog-content")?.textContent.includes(
              "需要系统级、全部访问（accessType 为全部）的密钥。密钥只保存在本机。",
            ),
          );
        if (["hub-auth-error", "hub-error"].includes(scenario))
          check(
            "hub-auth-recovery",
            query(".hub-connection-state")?.textContent.includes("密钥无效或权限不足") &&
              query(".hub-connection-state button")?.textContent === "更换密钥",
          );
        const primary = query(".hub-primary");
        if (primary) {
          const color = getComputedStyle(primary).backgroundColor;
          check(
            "hub-neutral-primary",
            !/rgb\(\s*0,\s*(105|106),\s*(204|205)\s*\)/u.test(color),
            color,
          );
        }
      }

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

      if (document.body.dataset.scenario?.startsWith("skills-"))
        check("skills-page-visible", visible(query(".skills-hub")));
      if (query(".skills-hub")) {
        const hub = query(".skills-hub");
        const library = Boolean(query(".skills-search"));
        check("skills-tabs", queryAll(".skills-tab").length === 2);
        check(
          "skills-tab-selected",
          query(".skills-tab[aria-selected=true]")?.textContent ===
            (library ? "技能库" : "按 Agent"),
        );
        if (library) {
          check(
            "skills-toolbar",
            Boolean(query(".skills-search")) &&
              queryAll(".skills-filter").length === 3 &&
              Boolean(query(".skills-select")) &&
              queryAll(".skills-layout-button").length === 2,
          );
          const cards = queryAll(".skills-card");
          check("skills-library-cards", cards.length === 3, String(cards.length));
          check(
            "skills-card-fields",
            cards.every(
              (card) =>
                Boolean(card.querySelector(".skills-card-name")) &&
                Boolean(card.querySelector(".skills-card-description")) &&
                Boolean(card.querySelector(".skills-source")) &&
                card.querySelectorAll(".skills-chip").length >= 3 &&
                card.querySelectorAll(".skills-badge").length >= 3,
            ),
          );
          check(
            "skills-card-badges-installed",
            !query(".skills-badges")?.textContent?.includes("GitHub Copilot") &&
              !query(".skills-badges")?.textContent?.includes("Qoder"),
          );
          const native = query('.skills-badge[data-native="true"]');
          const faded = query('.skills-badge[data-linked="false"]');
          check(
            "skills-badge-native",
            Boolean(native) && native.getAttribute("aria-disabled") === "true",
          );
          check(
            "skills-badge-faded-opacity",
            Boolean(faded) && getComputedStyle(faded).opacity !== "1",
          );
          check(
            "skills-machine-chips",
            queryAll(".skills-chips")[0]?.textContent?.includes("此计算机") &&
              queryAll(".skills-chips")[0]?.textContent?.includes("甲骨文新加坡"),
          );
          if (document.body.dataset.scenario === "skills-list")
            check("skills-list-layout", queryAll(".skills-card-list").length === 3);
          else check("skills-grid-layout", Boolean(query(".skills-grid")));
        } else {
          const groups = queryAll(".skills-machine-group");
          if (!query(".skills-detail-head"))
            check("skills-machine-sections", groups.length >= 3, String(groups.length));
          if (query(".skills-detail-head")) {
            check("skills-detail-path", Boolean(query(".skills-detail-head .skills-path")));
            check("skills-detail-stats", Boolean(query(".skills-detail-stats")));
            check("skills-detail-skills", queryAll(".skills-skill-card").length >= 2);
            check("skills-detail-status", queryAll(".skills-state").length >= 2);
            if (document.body.dataset.scenario === "skills-agent-native")
              check(
                "skills-detail-native",
                query(".skills-detail-stats")?.textContent?.includes("原生支持"),
              );
          } else {
            check("skills-agent-cards", queryAll(".skills-agent-card").length >= 3);
            check(
              "skills-agent-native-tag",
              [...queryAll(".skills-agent-card")].some(
                (card) =>
                  card.textContent.includes("Codex") && card.textContent.includes("原生支持"),
              ),
            );
          }
        }
        check(
          "skills-no-developer-data",
          !/[a-f0-9]{32,}|github-copilot|claude-code/.test(hub.textContent),
        );
        if (document.body.dataset.scenario === "skills-focus")
          check("skills-keyboard-focus", Boolean(query(":focus-visible")));
        if (document.body.dataset.scenario === "skills-agents-focus")
          check("skills-agent-keyboard-focus", Boolean(query(":focus-visible")));
        if (document.body.dataset.scenario === "skills-badge-undo")
          check(
            "skills-badge-undo",
            Boolean(query(".skills-undo button")) &&
              query(".skills-undo")?.textContent?.includes("撤销"),
          );
        const surface =
          query(".skills-card") ?? query(".skills-agent-card") ?? query(".skills-skill-card");
        if (surface)
          check(
            "skills-native-theme",
            getComputedStyle(surface).backgroundColor ===
              (document.body.dataset.theme === "dark" ? "rgb(24, 24, 24)" : "rgb(255, 255, 255)"),
          );
        const dialog = query("dialog[open]");
        if (dialog) {
          const rect = dialog.getBoundingClientRect();
          check(
            "skills-dialog-fits-viewport",
            rect.x >= 0 &&
              rect.y >= 0 &&
              rect.right <= window.innerWidth &&
              rect.bottom <= window.innerHeight,
          );
        }

        if (document.body.dataset.scenario.startsWith("skills-conflict")) {
          const summary = query(".skills-file-summary");
          const chevron = summary?.querySelector("svg");
          check(
            "skills-file-chevron",
            Boolean(chevron) &&
              getComputedStyle(summary).display === "flex" &&
              getComputedStyle(summary).listStyleType === "none",
          );
          check("skills-file-summary-small", getComputedStyle(summary).fontSize === "12px");
          check(
            "skills-file-chevron-animation",
            Boolean(chevron) &&
              getComputedStyle(chevron).transitionProperty.includes("transform") &&
              parseFloat(getComputedStyle(chevron).transitionDuration) > 0,
          );
          check(
            "skills-file-chevron-direction",
            getComputedStyle(chevron).rotate === (query("details[open]") ? "90deg" : "none"),
            getComputedStyle(chevron).rotate,
          );
          if (document.body.dataset.scenario === "skills-conflict-files-focus")
            check(
              "skills-file-keyboard-focus",
              summary.matches(":focus-visible") &&
                getComputedStyle(summary).outlineOffset === "-2px" &&
                Boolean(query("details[open]")),
            );
          check("skills-conflict-dialog", visible(query("dialog[open]")));
          check("skills-conflict-versions", queryAll(".skills-version").length === 2);
          const cards = queryAll(".skills-version");
          check(
            "skills-conflict-selection-border",
            getComputedStyle(cards[0]).borderColor !== getComputedStyle(cards[1]).borderColor,
          );
          check(
            "skills-conflict-radio-outline",
            getComputedStyle(query(".skills-version input:checked")).outlineStyle === "none",
          );
          check(
            "skills-diff-tints",
            getComputedStyle(query(".skills-diff-add")).backgroundColor !== "rgba(0, 0, 0, 0)" &&
              getComputedStyle(query(".skills-diff-remove")).backgroundColor !== "rgba(0, 0, 0, 0)",
          );
          check(
            "skills-diff-file-separation",
            !query(".skills-diff")?.textContent.includes("SKILL.md") &&
              query(".skills-file-list")?.textContent.includes("references/checklist.md"),
          );
          check(
            "skills-conflict-continue",
            query(".skills-actions button:last-child")?.textContent === "继续",
          );
          check(
            "skills-conflict-keyboard-selection",
            queryAll(".skills-version input:checked").length === 1,
          );
          check(
            "skills-conflict-diff",
            query(".skills-diff")?.textContent.includes("+ version: 1.3"),
          );
        }
        if (document.body.dataset.scenario.startsWith("skills-link")) {
          const checkbox = query("[data-skill-adoption]");
          const checkboxStyle = getComputedStyle(checkbox);
          check(
            "skills-desktop-checkbox",
            checkboxStyle.appearance === "none" &&
              checkboxStyle.width === "18px" &&
              checkboxStyle.borderStyle === "solid",
          );
          check(
            "skills-checkbox-mark",
            getComputedStyle(checkbox, "::after").opacity === (checkbox.checked ? "1" : "0"),
          );
          if (
            ["skills-link-focus", "skills-link-checked-focus"].includes(
              document.body.dataset.scenario,
            )
          )
            check(
              "skills-checkbox-keyboard-focus",
              checkbox.matches(":focus-visible") && checkboxStyle.outlineStyle === "solid",
            );
          check("skills-link-actions", queryAll(".skills-link-row").length === 4);
          check("skills-link-groups", queryAll(".skills-link-group").length === 2);
          check(
            "skills-link-choice-default",
            query("[data-skill-adoption]")?.checked ===
              ["skills-link-choice", "skills-link-checked-focus"].includes(
                document.body.dataset.scenario,
              ),
          );
          check(
            "skills-link-footer",
            query(".skills-actions button:first-child")?.textContent === "取消" &&
              query(".skills-actions button:last-child")?.textContent === "应用",
          );
          check("skills-link-no-apply", document.body.dataset.skillsLinkApplies === "0");
          check(
            "skills-link-adopt",
            query(".skills-dialog-body")?.textContent.includes("收进中央库"),
          );
        }
      }

      if (query(".dingtalk-conversation-list:not([hidden]) .dingtalk-conversation")) {
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
      for (const row of queryAll(".dingtalk-conversation")) {
        const title = row.querySelector(".dingtalk-conversation-title");
        const tag = row.querySelector(".dingtalk-conversation-tag");
        if (tag && !tag.hidden && title) {
          check("title-before-tag", title.scrollWidth <= title.clientWidth, title.textContent);
        }
        if (row.querySelector(".dingtalk-unread-badge"))
          check("ordinary-unread-no-prefix", !row.querySelector(".dingtalk-conversation-count"));
        const dot = row.querySelector(".dingtalk-avatar-unread");
        if (dot) {
          check("muted-unread-prefix", Boolean(row.querySelector(".dingtalk-conversation-count")));
          check(
            "muted-dot-gray",
            getComputedStyle(dot).backgroundColor ===
              getComputedStyle(row.querySelector(".dingtalk-conversation-time")).color,
          );
        }
      }
      if (document.body.dataset.scenario === "dingtalk-header-menu-narrow") {
        for (const id of ["cid-launch", "cid-finance"]) {
          const row = query(`[data-conversation-id="${id}"]`);
          const title = row?.querySelector(".dingtalk-conversation-title");
          const tag = row?.querySelector(".dingtalk-conversation-tag");
          check(
            `narrow-name-priority-${id}`,
            title && tag?.hidden && title.scrollWidth <= title.clientWidth,
          );
        }
        const width = query(".dingtalk-sidebar")?.getBoundingClientRect().width ?? 0;
        check("sidebar-responsive-width", width >= 240 && width <= 320, String(width));
      }
      for (const [id, label] of [
        ["cid-partner", "华东"],
        ["cid-budget", "预算"],
      ]) {
        const avatar = query(`[data-conversation-id="${id}"] .dingtalk-avatar`);
        if (avatar) check(`avatar-${id}`, avatar.textContent === label, avatar.textContent);
      }
      for (const avatar of queryAll(".dingtalk-message--bot .dingtalk-message-avatar"))
        check("bot-icon-avatar", Boolean(avatar.querySelector("svg")) && !avatar.textContent);
      if (document.body.dataset.scenario === "dingtalk-image-unavailable") {
        const frame = query(
          '[data-message-id="msg-launch-193"] .dingtalk-message-image--unavailable',
        );
        const bubble = frame?.closest(".dingtalk-message-bubble");
        const frameRect = frame?.getBoundingClientRect();
        const bubbleRect = bubble?.getBoundingClientRect();
        check(
          "unavailable-image-regular-bubble",
          bubble &&
            !bubble.classList.contains("dingtalk-message-bubble--image") &&
            getComputedStyle(bubble).backgroundColor !== "rgba(0, 0, 0, 0)",
        );
        check(
          "unavailable-image-text-aligned",
          frameRect && bubbleRect && Math.abs(frameRect.left - bubbleRect.left - 12) <= 1,
        );
        check(
          "unavailable-image-visible",
          frameRect && frameRect.top >= 100 && frameRect.bottom <= window.innerHeight,
        );
      }
      if (document.body.dataset.scenario === "dingtalk-conversation-hover") {
        const selected = query('.dingtalk-conversation[aria-selected="true"]');
        const hovered = query(".dingtalk-conversation:hover");
        check("conversation-hover-and-selected", selected && hovered && selected !== hovered);
        check(
          "conversation-hover-distinct",
          selected &&
            hovered &&
            getComputedStyle(selected).backgroundColor !==
              getComputedStyle(hovered).backgroundColor,
        );
      }
      if (document.body.dataset.scenario === "dingtalk-loading") {
        check("loading-skeleton", queryAll(".dingtalk-skeleton-row").length === 6);
        check("loading-no-composer", !visible(query(".dingtalk-composer-area")));
      }
      if (document.body.dataset.scenario === "dingtalk-search-empty") {
        check(
          "search-empty-chinese",
          query(".dingtalk-search-results")?.textContent.includes("没有找到相关会话或消息"),
        );
        check("search-empty-no-results", queryAll(".dingtalk-search-result").length === 0);
      }
      if (document.body.dataset.scenario === "dingtalk-error") {
        check("error-no-composer", !visible(query(".dingtalk-composer-area")));
        check(
          "error-chinese",
          query(".dingtalk-empty-list")?.textContent.includes("钉钉连接不可用，请稍后重试"),
        );
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
        check(
          "selected-at-me-cleared",
          Boolean(query(".dingtalk-conversation[aria-selected='true']")) &&
            !query(".dingtalk-conversation[aria-selected='true'] .dingtalk-conversation-at-me"),
        );
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
      if (document.body.dataset.scenario === "dingtalk-list") {
        const selected = query(".dingtalk-conversation[aria-selected='true']");
        check("auto-selected-row", Boolean(selected));
        check(
          "auto-selected-badge-cleared",
          Boolean(selected) &&
            !selected.querySelector(".dingtalk-unread-badge, .dingtalk-avatar-unread"),
        );
        check(
          "auto-selected-count-cleared",
          !selected?.querySelector(".dingtalk-conversation-count"),
        );
      }
      if (document.body.dataset.scenario === "dingtalk-hover") {
        const row = query(".dingtalk-message");
        const bubble = query(".dingtalk-message-bubble");
        const rowStyle = row ? getComputedStyle(row) : null;
        check(
          "message-hover-transparent",
          Boolean(rowStyle) && rowStyle.backgroundColor === "rgba(0, 0, 0, 0)",
          rowStyle?.backgroundColor ?? "missing",
        );
        check(
          "message-bubble-visible",
          Boolean(bubble) && getComputedStyle(bubble).backgroundColor !== "rgba(0, 0, 0, 0)",
        );
      }
      if (document.body.dataset.scenario === "dingtalk-lightbox") {
        const overlay = query(".dingtalk-lightbox");
        const image = query(".dingtalk-lightbox-image");
        const rect = image?.getBoundingClientRect();
        check("lightbox-open", Boolean(overlay) && !overlay.hidden && overlay.matches(":modal"));
        const overlayRect = overlay?.getBoundingClientRect();
        check(
          "lightbox-covers-page",
          Boolean(overlayRect) &&
            overlayRect.x === 0 &&
            overlayRect.y === 0 &&
            Math.abs(overlayRect.width - window.innerWidth) < 1 &&
            Math.abs(overlayRect.height - window.innerHeight) < 1,
        );
        const close = query(".dingtalk-lightbox-close");
        const closeRect = close?.getBoundingClientRect();
        check(
          "lightbox-close-top-right",
          Boolean(closeRect) && closeRect.top < 40 && window.innerWidth - closeRect.right < 40,
        );
        const headerClose = query(".settings-header-actions button");
        const headerRect = headerClose?.getBoundingClientRect();
        if (headerRect) {
          const hit = shell.elementFromPoint(
            headerRect.x + headerRect.width / 2,
            headerRect.y + headerRect.height / 2,
          );
          check("page-close-covered", hit !== headerClose && Boolean(overlay?.contains(hit)));
        }
        check(
          "lightbox-overlay-dark",
          Boolean(overlay) && getComputedStyle(overlay).backgroundColor.startsWith("rgba(0, 0, 0"),
          overlay ? getComputedStyle(overlay).backgroundColor : "missing",
        );
        check(
          "lightbox-image-fit",
          Boolean(rect) &&
            rect.width <= window.innerWidth &&
            rect.height <= window.innerHeight &&
            rect.width > 200 &&
            rect.height > 150,
          rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : "missing",
        );
        check("lightbox-counter", Boolean(query(".dingtalk-lightbox-counter")?.textContent));
        check("lightbox-no-status", Boolean(query(".dingtalk-lightbox-status")?.hidden));
      }
      if (document.body.dataset.scenario === "dingtalk-at-picker") {
        const selected = query(".dingtalk-conversation[aria-selected='true']");
        check(
          "at-picker-badge-cleared",
          Boolean(selected) &&
            !selected.querySelector(".dingtalk-unread-badge, .dingtalk-avatar-unread"),
        );
        const picker = query(".dingtalk-mention-picker");
        check("at-picker-open", Boolean(picker) && !picker.hidden);
        const pickerRect = picker?.getBoundingClientRect();
        check(
          "at-picker-width",
          Boolean(pickerRect) && (pickerRect?.width ?? 0) >= 260 && (pickerRect?.width ?? 0) <= 300,
          String(Math.round(pickerRect?.width ?? 0)),
        );
        check(
          "at-picker-height",
          Boolean(pickerRect) && (pickerRect?.height ?? 0) <= 280,
          String(Math.round(pickerRect?.height ?? 0)),
        );
        check(
          "at-picker-options",
          queryAll(".dingtalk-mention-option").length >= 2,
          `${queryAll(".dingtalk-mention-option").length} options`,
        );
        check(
          "at-picker-avatars",
          queryAll(".dingtalk-mention-option .dingtalk-avatar").length > 0,
        );
        check(
          "at-picker-all-row",
          queryAll(".dingtalk-mention-option").some((row) => row.textContent?.includes("所有人")),
        );
        const allAvatar = query(".dingtalk-mention-option .dingtalk-mention-avatar");
        check(
          "at-picker-all-icon",
          Boolean(allAvatar?.querySelector("svg")) && !allAvatar.textContent,
        );
        const active = queryAll(".dingtalk-mention-option").findIndex((row) =>
          row.classList.contains("dingtalk-mention-option--active"),
        );
        check("at-picker-keyboard", active === 1, `active=${active}`);
      }
      if (document.body.dataset.scenario === "dingtalk-header-menu") {
        check("header-menu-open-after-down", window.__dingtalkMenuOpenAfterDown === true);
        check("header-menu-closed-after-action", Boolean(query(".dingtalk-header-menu")?.hidden));
        check(
          "header-menu-action-ran",
          (window.__dingtalkPreviewMessageCalls ?? 0) > (window.__dingtalkBaselineMessages ?? 0),
          String(window.__dingtalkPreviewMessageCalls ?? 0),
        );
      }
      if (document.body.dataset.scenario === "dingtalk-page-menu") {
        check("page-menu-open-after-down", window.__dingtalkPageMenuOpenAfterDown === true);
        check("page-menu-still-open", Boolean(query(".dingtalk-page-menu:not([hidden])")));
      }
      for (const [menuSelector, anchorSelector] of [
        [".dingtalk-page-menu", ".dingtalk-sidebar .dingtalk-more-button"],
        [".dingtalk-header-menu", ".dingtalk-main-actions .dingtalk-more-button"],
      ]) {
        const menu = query(`${menuSelector}:not([hidden])`);
        if (!menu) continue;
        const anchor = query(anchorSelector)?.getBoundingClientRect();
        const rect = menu.getBoundingClientRect();
        check(
          `${menuSelector}-below-trigger`,
          anchor && Math.abs(rect.top - anchor.bottom - 4) <= 1,
          `top=${rect.top}, anchorBottom=${anchor?.bottom}`,
        );
        check(
          `${menuSelector}-aligned-to-trigger`,
          anchor &&
            (menuSelector === ".dingtalk-header-menu"
              ? Math.abs(rect.right - anchor.right) <= 1
              : Math.abs(
                  rect.left -
                    Math.min(Math.max(8, anchor.left), window.innerWidth - rect.width - 8),
                ) <= 1),
          `menu=${rect.left}..${rect.right}, anchor=${anchor?.left}..${anchor?.right}`,
        );
        check(
          `${menuSelector}-inside-viewport`,
          rect.left >= 8 &&
            rect.right <= window.innerWidth - 8 &&
            rect.bottom <= window.innerHeight - 8,
        );
        check(`${menuSelector}-top-layer`, menu.matches(":popover-open"));
      }
      if (document.body.dataset.scenario.startsWith("dingtalk-empty-menu")) {
        check("menu-with-empty-right-pane", visible(query(".dingtalk-conversation-empty")));
        check("sidebar-menu-open", Boolean(query(".dingtalk-page-menu:not([hidden])")));
        check(
          "empty-menu-no-conversations",
          queryAll(".dingtalk-conversation").length === 0 && Boolean(query(".dingtalk-empty-list")),
        );
      }
      if (document.body.dataset.scenario === "dingtalk-empty-menu-narrow") {
        check("menu-flips-above-in-short-window", window.__dingtalkMenuFlippedAbove === true);
      }
      if (document.body.dataset.scenario === "dingtalk-at-chip") {
        const chips = query(".dingtalk-composer-chips");
        check("at-chip-visible", Boolean(chips) && !chips.hidden);
        check(
          "at-chip-name",
          Boolean(chips?.textContent?.includes("林晓")),
          chips?.textContent ?? "missing",
        );
        check("at-chip-picker-closed", Boolean(query(".dingtalk-mention-picker")?.hidden));
        check(
          "at-chip-input",
          Boolean(query(".dingtalk-composer-input")?.value?.includes("请看一下今天的发布进度")),
        );
      }
      if (document.body.dataset.scenario === "dingtalk-at-send") {
        const sent = window.__dingtalkPreviewSent;
        check("at-send-called", Boolean(sent));
        check(
          "at-send-placeholder",
          Boolean(sent?.text?.includes("<@open-preview-1>")),
          sent?.text ?? "missing",
        );
        check("at-send-id", sent?.atOpenDingTalkIds?.[0] === "open-preview-1");
        check("at-send-no-all", sent?.atAll !== true);
        check("at-picker-closed", Boolean(query(".dingtalk-mention-picker")?.hidden));
        check(
          "at-send-bubble",
          queryAll(".dingtalk-message").some((row) => row.textContent?.includes("@林晓")),
        );
      }
      if (
        document.body.dataset.scenario === "dingtalk-unread-open" ||
        document.body.dataset.scenario === "dingtalk-unread-left"
      ) {
        const badges = queryAll(".dingtalk-unread-badge, .dingtalk-avatar-unread").length;
        const initialBadges = Number(document.body.dataset.initialUnread ?? "0");
        const badgeTitle = document.body.dataset.badgeTitle ?? "";
        const selected = query(".dingtalk-conversation[aria-selected='true']");
        check("unread-badge-cleared", badges < initialBadges, `${initialBadges} → ${badges}`);
        check(
          "unread-active-row-present",
          Boolean(selected) &&
            !selected.querySelector(".dingtalk-unread-badge, .dingtalk-avatar-unread"),
        );
        if (document.body.dataset.scenario === "dingtalk-unread-left") {
          check(
            "unread-row-removed-after-leave",
            !queryAll(".dingtalk-conversation-title").some(
              (title) => title.textContent === badgeTitle,
            ),
            badgeTitle,
          );
        }
      }
      if (document.body.dataset.scenario === "dingtalk-live") {
        const initial = Number(document.body.dataset.initialMessages ?? "0");
        const messages = queryAll(".dingtalk-message");
        check("live-message-arrived", messages.length > initial, `${initial} → ${messages.length}`);
        check(
          "live-message-text",
          messages.some((row) => row.textContent?.includes("刚刚收到一条新消息")),
        );
        check(
          "live-preview-updated",
          queryAll(".dingtalk-conversation-preview").some((row) =>
            row.textContent?.includes("刚刚收到一条新消息"),
          ),
        );
      }
      if (document.body.dataset.scenario === "dingtalk-scrolled-top") {
        const list = query(".dingtalk-message-list");
        check(
          "scroll-at-top",
          Boolean(list) && (list?.scrollTop ?? 1) < 80,
          String(list?.scrollTop),
        );
        check("scroll-loading-older", Boolean(query(".dingtalk-loading-older:not([hidden])")));
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
        const empty = query(".dingtalk-conversation-empty");
        const mainRect = main?.getBoundingClientRect();
        const emptyRect = empty?.getBoundingClientRect();
        check(
          "empty-shows-right-pane",
          visible(main) && visible(empty) && Boolean(empty?.querySelector("svg")),
        );
        check(
          "empty-centered",
          mainRect &&
            emptyRect &&
            Math.abs(emptyRect.x + emptyRect.width / 2 - mainRect.x - mainRect.width / 2) <= 1 &&
            Math.abs(emptyRect.y + emptyRect.height / 2 - mainRect.y - mainRect.height / 2) <= 1,
        );
        check(
          "empty-unread-hint-once",
          empty?.textContent === "最近 48 小时没有未读消息" &&
            !query(".dingtalk-conversation-list")?.textContent.includes("最近 48 小时没有未读消息"),
        );
        check("empty-no-composer", !visible(query(".dingtalk-composer-area")));
        check("empty-no-header-actions", !visible(query(".dingtalk-main-head")));
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
      if (document.body.dataset.scenario === "harness-picker") {
        check("picker-selected-agent", document.body.dataset.selectedAgent === "claude-code");
        check("picker-toolbar-survived", document.body.dataset.toolbarTornDown !== "true");
        const menu = query("#preview-harness-picker-agent-menu");
        check("picker-menu-open", Boolean(menu) && menu.matches(":popover-open"));
        check(
          "picker-rows",
          Boolean(menu) && menu.querySelectorAll("button[data-agent]").length >= 3,
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
        document.body.dataset.scenario?.startsWith("jarvis-projects") ||
        document.body.dataset.scenario?.startsWith("jarvis-bugs")
      ) {
        const mode = query("[data-codexhost-jarvis-mode]");
        const host = query("[data-codexhost-jarvis-detached]");
        check("mode-hosted-panel", Boolean(mode) && Boolean(host?.contains(mode)));
        check(
          "mode-no-overlay",
          !query("[data-codexhost-dingtalk-panel]") && !query("[data-codexhost-jarvis-panel]"),
        );
        const composer = query("[data-composer-body]");
        const hostRect = host?.getBoundingClientRect();
        const composerRect = composer?.getBoundingClientRect();
        check(
          "mode-anchored-above-composer",
          Boolean(hostRect && composerRect) && Math.abs(hostRect.bottom - composerRect.top) <= 12,
          hostRect && composerRect
            ? `${Math.round(composerRect.top - hostRect.bottom)}px gap`
            : "missing",
        );
        check(
          "mode-header",
          Boolean(
            mode?.textContent?.includes("Jarvis") &&
            (mode.textContent.includes("项目") || mode.textContent.includes("Bug")) &&
            mode.querySelector("svg"),
          ),
        );
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
        check(
          "single-step-mounted",
          Boolean(mode?.matches("[data-codexhost-jarvis-step]")) &&
            document.querySelectorAll("[data-codexhost-jarvis-step]").length === 1,
        );
        const row = mode?.querySelector(
          "[data-codexhost-jarvis-bug], [data-codexhost-jarvis-project]",
        );
        if (row) {
          const rowRect = row.getBoundingClientRect();
          check("mode-row-density", rowRect.height >= 40, `${Math.round(rowRect.height)}px`);
          check(
            "mode-row-horizontal-padding",
            getComputedStyle(row).paddingLeft === "12px",
            getComputedStyle(row).paddingLeft,
          );
        }
        const bugRow = mode?.querySelector("[data-codexhost-jarvis-bug]");
        if (bugRow) {
          check("mode-row-bug-icon", Boolean(bugRow.querySelector("svg")));
          check("mode-status-pill", Boolean(bugRow.querySelector("[data-jarvis-status]")));
          check("mode-no-project-tag", !bugRow.querySelector("[data-jarvis-project]"));
        }
        const projectRow = mode?.querySelector("[data-codexhost-jarvis-project]");
        if (projectRow) check("mode-project-folder-icon", Boolean(projectRow.querySelector("svg")));
      }
      if (document.body.dataset.scenario === "jarvis-projects") {
        check("project-rows", queryAll("[data-codexhost-jarvis-project]").length === 8);
        check(
          "project-list-label",
          query("[data-jarvis-list-label]")?.textContent === "我的项目",
          query("[data-jarvis-list-label]")?.textContent ?? "",
        );
        check(
          "project-no-duplicate-count",
          (query("[data-jarvis-summary]")?.textContent ?? "missing") === "",
          query("[data-jarvis-summary]")?.textContent ?? "",
        );
        check("project-no-condition-chips", queryAll("[data-jarvis-chip]").length === 0);
      }
      if (document.body.dataset.scenario === "jarvis-projects-search") {
        check("project-search-rows", queryAll("[data-codexhost-jarvis-project]").length === 4);
        check(
          "project-search-label",
          query("[data-jarvis-list-label]")?.textContent === "搜索结果",
          query("[data-jarvis-list-label]")?.textContent ?? "",
        );
        check(
          "project-search-typed",
          query("[data-codexhost-jarvis-step='project'] input")?.value === "发货",
          query("[data-codexhost-jarvis-step='project'] input")?.value ?? "",
        );
      }
      if (document.body.dataset.scenario === "jarvis-projects-loading") {
        check("project-loading-skeleton", queryAll("[data-codexhost-jarvis-skeleton]").length >= 3);
        const nativePanel = document
          .querySelector("[data-mention-list-scroll-area]")
          ?.closest('[class*="suggestionMenu"]');
        check(
          "native-rows-hidden",
          Boolean(nativePanel) && getComputedStyle(nativePanel).visibility === "hidden",
        );
      }
      if (document.body.dataset.scenario === "jarvis-projects-empty") {
        const step = query("[data-codexhost-jarvis-step='project']");
        check("project-empty-state", Boolean(step?.textContent?.includes("无结果")));
        check("project-empty-no-rows", queryAll("[data-codexhost-jarvis-project]").length === 0);
      }
      if (document.body.dataset.scenario === "jarvis-projects-error") {
        const step = query("[data-codexhost-jarvis-step='project']");
        check("project-error-message", Boolean(step?.textContent?.includes("未登录 Jarvis")));
        check("project-error-action", query("[data-jarvis-action]")?.textContent === "去设置");
        check("project-error-no-rows", queryAll("[data-codexhost-jarvis-project]").length === 0);
        check(
          "project-error-no-count",
          (query("[data-jarvis-summary]")?.textContent ?? "missing") === "",
          query("[data-jarvis-summary]")?.textContent ?? "",
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
      if (document.body.dataset.scenario === "jarvis-bugs-preview") {
        check("project-chip", Boolean(query("[data-jarvis-project-chip]")));
        check("preview-rows", queryAll("[data-codexhost-jarvis-bug]").length === 4);
        check("preview-no-condition-chips", queryAll("[data-jarvis-chip]").length === 0);
        check(
          "preview-hint",
          Boolean(query("[data-jarvis-summary]")?.textContent?.includes("回车识别条件")),
          query("[data-jarvis-summary]")?.textContent ?? "",
        );
      }
      if (document.body.dataset.scenario === "jarvis-bugs-conditions") {
        check("condition-chips", queryAll("[data-jarvis-chip]").length >= 4);
        check("condition-results", queryAll("[data-codexhost-jarvis-bug]").length === 2);
        check(
          "condition-count",
          query("[data-jarvis-summary]")?.textContent === "共 2 条",
          query("[data-jarvis-summary]")?.textContent ?? "",
        );
        check(
          "condition-query-typed",
          query("[data-codexhost-jarvis-step='bug'] input")?.value === "发货",
          query("[data-codexhost-jarvis-step='bug'] input")?.value ?? "",
        );
      }
      if (document.body.dataset.scenario === "jarvis-bugs-unparsed") {
        check(
          "unparsed-notice",
          query("[data-jarvis-summary]")?.textContent === "条件未识别，已按标题搜索",
          query("[data-jarvis-summary]")?.textContent ?? "",
        );
        check("unparsed-keeps-title-rows", queryAll("[data-codexhost-jarvis-bug]").length === 4);
        check("unparsed-no-condition-chips", queryAll("[data-jarvis-chip]").length === 0);
      }
      if (document.body.dataset.scenario === "jarvis-bugs-empty") {
        check(
          "bug-empty-state",
          Boolean(query("[data-codexhost-jarvis-step='bug']")?.textContent?.includes("无结果")),
        );
        check("bug-empty-no-rows", queryAll("[data-codexhost-jarvis-bug]").length === 0);
      }
      if (document.body.dataset.scenario === "jarvis-bugs-error") {
        const step = query("[data-codexhost-jarvis-step='bug']");
        check("bug-error-message", Boolean(step?.textContent?.includes("未登录 Jarvis")));
        check("bug-error-action", query("[data-jarvis-action]")?.textContent === "去设置");
        check("bug-error-no-rows", queryAll("[data-codexhost-jarvis-bug]").length === 0);
        check("bug-error-no-chips", queryAll("[data-jarvis-chip]").length === 0);
        check(
          "bug-error-no-count",
          (query("[data-jarvis-summary]")?.textContent ?? "missing") === "",
          query("[data-jarvis-summary]")?.textContent ?? "",
        );
      }
      if (document.body.dataset.scenario === "jarvis-bugs-loading") {
        check("bug-loading-skeleton", queryAll("[data-codexhost-jarvis-skeleton]").length >= 3);
      }
      if (document.body.dataset.scenario === "jarvis-bugs-many") {
        check("many-rows", queryAll("[data-codexhost-jarvis-bug]").length === 14);
        const results = query('[data-jarvis-results="true"]');
        check(
          "mode-results-scrollable",
          Boolean(results) && results.scrollHeight > results.clientHeight,
          results ? `${results.scrollHeight}/${results.clientHeight}` : "missing",
        );
        check("mode-wheel-scrolled", document.body.dataset.jarvisScrolled === "true");
      }
      if (document.body.dataset.scenario === "jarvis-bugs-chip-removed") {
        check("status-chip-removed", !query('[data-jarvis-chip="status:1"]'));
        check("other-chips-kept", queryAll("[data-jarvis-chip]").length === 3);
      }
      if (document.body.dataset.scenario?.startsWith("model-service-")) {
        const section = query(".settings-model-service");
        const state = document.body.dataset.modelServiceState;
        const editing = state === "edit" || state === "add";
        const inputs = queryAll(".settings-model-service input");
        const visible = (element) => element.getBoundingClientRect().height > 0;
        const visibleInputs = inputs.filter(visible);
        check(
          "model-card-two-rows",
          section?.querySelector(".settings-model-service__card")?.children.length === 2,
        );
        check(
          "masked-keys",
          inputs.length === 1 && inputs.every((input) => input.type === "password"),
        );
        check("inputs-only-while-editing", visibleInputs.length === (editing ? 1 : 0));
        check(
          "save-only-while-editing",
          queryAll(".settings-model-service button").filter(
            (button) => button.textContent === "保存" && visible(button),
          ).length === (editing ? 1 : 0),
        );
        check(
          "no-stale-saved-or-subtitle",
          !section?.textContent?.includes("已保存") && !query(".settings-page-description"),
        );
        const model = query("#model-service-provider");
        check(
          "model-static-label",
          model?.tagName === "SPAN" && model.textContent === "Gemini · gemini-3.5-flash-lite",
        );
        check("model-secondary-text", model?.classList.contains("text-settings-muted") === true);
        check(
          "model-no-interaction",
          !model?.hasAttribute("tabindex") &&
            !model?.hasAttribute("aria-haspopup") &&
            !model?.querySelector("svg") &&
            !query("#model-service-model-menu"),
        );
        check(
          "no-removed-nav-or-routes",
          !query('[data-page-id="session-import"]') &&
            !query('[data-page-id="harness-schedules"]') &&
            !window.__codexhostSettingsShellV1.registry.getPage("session-import") &&
            !window.__codexhostSettingsShellV1.registry.getPage("harness-schedules"),
        );
        check("no-secret-in-copy", !section?.textContent?.includes("fake-preview"));
        check(
          "real-theme",
          getComputedStyle(document.documentElement)
            .getPropertyValue("--app-color-background-surface")
            .trim() !== "",
        );
        const headings = queryAll(".settings-page h3").slice(0, 3);
        check(
          "section-titles-align",
          headings.length === 3 &&
            headings.every(
              (heading) =>
                Math.abs(
                  heading.getBoundingClientRect().left - headings[0].getBoundingClientRect().left,
                ) < 1,
            ),
        );
        if (state !== "empty" && state !== "add" && state !== "error")
          check(
            "configured-state-in-row",
            query(
              '[data-provider="gemini"] .settings-model-service__status',
            )?.textContent?.startsWith("已配置 ···1234") === true,
          );
        if (state === "configured")
          check(
            "connection-success-in-state",
            query('[data-provider="gemini"] .settings-model-service__status')?.textContent ===
              "已配置 ···1234 · 连接成功 123 毫秒",
          );
        if (state === "empty")
          check(
            "empty-state-in-row",
            query('[data-provider="gemini"] .settings-model-service__status')?.textContent ===
              "未配置",
          );
        if (state === "testing")
          check("testing-status", section?.textContent?.includes("正在测试…") === true);
        if (state === "error")
          check(
            "chinese-quota-error",
            query('[data-provider="gemini"] .settings-model-service__status')?.textContent ===
              "Gemini 额度不足",
          );
        if (state === "focus")
          check(
            "action-keyboard-focus",
            query("#model-service-edit-gemini")?.matches(":focus-visible") === true,
          );
        if (editing)
          check(
            "edit-controls-and-focus",
            query("#model-service-gemini")?.value === "fake-preview-replacement-5678" &&
              query("#model-service-gemini")?.matches(":focus") === true,
          );
        if (state === "hover")
          check("change-hover", query("#model-service-edit-gemini")?.matches(":hover") === true);
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
    if (hoverSelector !== undefined && (await hoverPreviewElement(page, hoverSelector))) {
      const hoverFile = `${scenario}-hover-${theme}.png`;
      await page.screenshot({
        path: path.join(outputDirectory, hoverFile),
        fullPage: false,
        animations: "disabled",
      });
      const hoverChecks =
        scenario === "skills-hover"
          ? [
              {
                name: "skills-refresh-tooltip",
                ok: skillsTooltipDismissed && (await page.locator('[role="tooltip"]').isVisible()),
              },
            ]
          : [];
      report.captures.push({
        scenario: `${scenario}-hover`,
        theme,
        approximate: theme === "dark" && shadowContext.darkApproximate === true,
        screenshot: path.join(outputDirectory, hoverFile),
        pageErrors: errors,
        checks: hoverChecks,
        ok: errors.length === 0 && hoverChecks.every((check) => check.ok),
      });
      console.log(`[ui-preview] ${hoverFile}`);
    }
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
