#!/usr/bin/env node
/* global document */
/**
 * Captures every preview scenario in light and dark with the installed
 * Playwright Chromium and records basic DOM assertions next to the images.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { chromium } from "@playwright/test";

const previewRoot = import.meta.dirname;
const baseUrl = "http://127.0.0.1:4417";
const allScenarios = [
  "dingtalk-list",
  "dingtalk-open",
  "dingtalk-scrolled-top",
  "dingtalk-search",
  "dingtalk-select",
  "dingtalk-empty",
  "dingtalk-error",
  "agents-list",
  "agents-edit",
  "agents-dingtalk-settings",
  "group-plus-menu",
  "group-add-machine",
  "at-entry",
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
const report = { generatedAt: new Date().toISOString(), baseUrl, captures: [] };

for (const scenario of scenarios) {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
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

      if (document.querySelector(".dingtalk-workbench")) {
        const list = query(".dingtalk-conversation-list");
        check(
          "conversation-list-visible",
          Boolean(list) && list.getBoundingClientRect().height > 0,
        );
      }
      if (document.body.dataset.scenario === "dingtalk-open") {
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
      }
      if (document.body.dataset.scenario === "dingtalk-scrolled-top") {
        const count = queryAll(".dingtalk-message").length;
        check("older-page-loaded", count > 30, `${count} messages`);
      }
      if (document.body.dataset.scenario === "dingtalk-search") {
        const panel = query(".dingtalk-search-results");
        const sidebar = query(".dingtalk-sidebar");
        check("search-inside-left-column", Boolean(panel && sidebar && sidebar.contains(panel)));
        check("search-results-visible", Boolean(panel) && panel.getBoundingClientRect().height > 0);
        check(
          "search-highlight",
          queryAll(".dingtalk-search-mark").length > 0,
          `${queryAll(".dingtalk-search-mark").length} marks`,
        );
        check("chat-still-visible", queryAll(".dingtalk-message").length > 0);
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
      if (document.body.dataset.scenario === "agents-list") {
        check(
          "three-agent-rows",
          queryAll(".agent-row").length === 3,
          `${queryAll(".agent-row").length}`,
        );
      }
      if (document.body.dataset.scenario === "agents-edit") {
        const editor = query(".agent-editor");
        check("editor-open", Boolean(editor) && !editor.hidden);
        check("editor-instructions", Boolean(query(".agent-instructions")));
      }
      if (document.body.dataset.scenario === "agents-dingtalk-settings") {
        check("listener-section", Boolean(query(".dingtalk-listener")));
        check("listener-events", queryAll(".dingtalk-listener-events input").length === 3);
      }
      if (document.body.dataset.scenario === "group-plus-menu") {
        check("add-machine-row", Boolean(query("[data-codexhost-add-machine-row]")));
      }
      if (document.body.dataset.scenario === "group-add-machine") {
        check("machine-menu", Boolean(query("[data-codexhost-add-machine-menu]")));
      }
      if (document.body.dataset.scenario === "at-entry") {
        const row = query("[data-codexhost-dingtalk-entry]");
        check("single-dingtalk-row", Boolean(row));
        check(
          "entry-helper-text",
          Boolean(row?.textContent.includes("打开钉钉工作台")),
          row?.textContent ?? "",
        );
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
