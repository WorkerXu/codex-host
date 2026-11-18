import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererSidebarSections } from "./packages/renderer-extension/src/renderer-sidebar-sections.ts";
      const row = (projectId, threadId, title) => {
        const element = document.createElement("div");
        element.setAttribute("data-app-action-sidebar-thread-row", "");
        element.setAttribute("data-app-action-sidebar-thread-host-id", "host");
        element.setAttribute("data-app-action-sidebar-thread-id", "host:" + threadId);
        element.setAttribute("data-app-action-sidebar-thread-pinned", "false");
        element.setAttribute("data-app-action-sidebar-thread-title", title);
        element.style.height = "30px";
        element.dataset.thread = threadId;
        const line = document.createElement("div");
        line.className = "row-line";
        const lead = document.createElement("div");
        lead.className = "row-lead";
        lead.append(document.createElement("div"));
        const trigger = document.createElement("div");
        trigger.setAttribute("data-thread-title-trigger", "");
        const titleSpan = document.createElement("span");
        titleSpan.setAttribute("data-thread-title", "");
        titleSpan.textContent = title;
        trigger.append(titleSpan);
        line.append(lead, trigger);
        element.append(line);
        return element;
      };
      const rowUnit = (projectId, threadId, title) => {
        const unitRow = document.createElement("div");
        unitRow.setAttribute("role", "listitem");
        const rowOverflow = document.createElement("div");
        const rowContents = document.createElement("div");
        const drop = document.createElement("div");
        drop.append(row(projectId, threadId, title));
        rowContents.append(drop);
        rowOverflow.append(rowContents);
        unitRow.append(rowOverflow);
        return unitRow;
      };
      const project = (projectId, label, rows, moreRows = []) => {
        const unit = document.createElement("div");
        unit.setAttribute("role", "listitem");
        const overflow = document.createElement("div");
        const contents = document.createElement("div");
        const container = document.createElement("div");
        container.setAttribute("data-sidebar-project-container-id", "project:" + projectId);
        container.setAttribute("role", "listitem");
        const rail = document.createElement("div");
        rail.className = "rail";
        const headerWrap = document.createElement("div");
        const header = document.createElement("div");
        header.setAttribute("data-app-action-sidebar-project-row", "");
        header.setAttribute("data-app-action-sidebar-project-id", projectId);
        header.setAttribute("data-app-action-sidebar-project-collapsed", "false");
        header.setAttribute("aria-label", label);
        header.textContent = label;
        header.style.height = "30px";
        headerWrap.append(header);
        const body = document.createElement("div");
        const bodyOverflow = document.createElement("div");
        const bodyPad = document.createElement("div");
        const listWrap = document.createElement("div");
        listWrap.setAttribute("data-app-action-sidebar-project-list-id", projectId);
        listWrap.setAttribute("data-app-action-sidebar-project-show-all", "true");
        const inner = document.createElement("div");
        const list = document.createElement("div");
        list.setAttribute("role", "list");
        list.style.display = "flex";
        list.style.flexDirection = "column";
        list.style.gap = "1px";
        for (const [threadId, title] of rows) list.append(rowUnit(projectId, threadId, title));
        const toggleItem = document.createElement("div");
        toggleItem.setAttribute("role", "listitem");
        const toggleButton = document.createElement("button");
        toggleButton.type = "button";
        toggleButton.textContent = "展开显示";
        toggleItem.append(toggleButton);
        if (moreRows.length > 0) {
          list.append(toggleItem);
          listWrap.setAttribute("data-app-action-sidebar-project-show-all", "false");
          toggleButton.addEventListener("click", () => {
            const expanded =
              listWrap.getAttribute("data-app-action-sidebar-project-show-all") === "true";
            if (expanded) {
              for (const extra of [...list.querySelectorAll("[data-extra-row]")]) extra.remove();
              listWrap.setAttribute("data-app-action-sidebar-project-show-all", "false");
              toggleButton.textContent = "展开显示";
              list.append(toggleItem);
            } else {
              for (const [threadId, title] of moreRows) {
                const extra = rowUnit(projectId, threadId, title);
                extra.setAttribute("data-extra-row", "");
                list.append(extra);
              }
              listWrap.setAttribute("data-app-action-sidebar-project-show-all", "true");
              toggleButton.textContent = "收起";
              list.append(toggleItem);
            }
          });
        } else {
          listWrap.setAttribute("data-app-action-sidebar-project-show-all", "true");
        }
        inner.append(list);
        listWrap.append(inner);
        bodyPad.append(listWrap);
        bodyOverflow.append(bodyPad);
        body.append(bodyOverflow);
        container.append(rail, headerWrap, body);
        contents.append(container);
        overflow.append(contents);
        unit.append(overflow);
        return unit;
      };
      window.setupSections = (options = {}) => {
        document.body.innerHTML = "";
        const container = document.createElement("div");
        container.setAttribute("data-sidebar-project-container-id", "custom:fixture");
        const section = document.createElement("section");
        section.setAttribute("data-app-action-sidebar-section", "");
        section.setAttribute("data-app-action-sidebar-section-heading", "工作台");
        const sectionBody = document.createElement("div");
        const titleRow = document.createElement("div");
        const actions = document.createElement("div");
        const menu = document.createElement("button");
        menu.setAttribute("aria-haspopup", "menu");
        menu.setAttribute("aria-label", "工作台 的选项");
        menu.textContent = "menu";
        actions.append(menu);
        titleRow.append(actions);
        const content = document.createElement("div");
        const contentWrapper = document.createElement("div");
        const list = document.createElement("div");
        list.setAttribute("role", "list");
        list.style.display = "flex";
        list.style.flexDirection = "column";
        list.style.gap = "1px";
        const outer = document.createElement("div");
        outer.append(project("p1", "项目一", [["a1", "A1"], ["a2", "A2"], ["a3", "A3"]]));
        outer.append(project("p2", "项目二", [["b1", "B1"], ["b2", "B2"]], [["b3", "B3"]]));
        list.append(...outer.children);
        contentWrapper.append(list);
        content.append(contentWrapper);
        sectionBody.append(titleRow, content);
        section.append(sectionBody);
        container.append(section);
        document.body.append(container);

        const storageValues = new Map(options.storage ? Object.entries(options.storage) : []);
        const storage = { getItem: (key) => storageValues.get(key) ?? null, setItem: (key, value) => storageValues.set(key, value) };
        const recency = new Map([["host\\u0000a1", 300], ["host\\u0000a2", 100], ["host\\u0000b1", 250], ["host\\u0000b2", 200]]);
        const control = installRendererSidebarSections({
          window,
          document,
          storage: options.brokenStorage ? { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } } : storage,
          loadRecency: options.noRecency ? async () => null : async () => recency,
        });
        window.sectionFixture = {
          control,
          storageValues,
          rows: () => [...document.querySelectorAll('[data-app-action-sidebar-thread-row]')],
          headerDisplays: () => [...document.querySelectorAll('[data-app-action-sidebar-project-row]')].map((row) => getComputedStyle(row.parentElement).display),
          railDisplays: () => [...document.querySelectorAll('.rail')].map((rail) => getComputedStyle(rail).display),
          state: () => document.querySelector('[data-sidebar-project-container-id^="custom:"]')?.getAttribute('data-codexhost-merged-state'),
          toggle: () => document.querySelector('[data-codexhost-section-display-toggle]'),
          setCollapsed: (index, collapsed) => document.querySelectorAll('[data-app-action-sidebar-project-row]')[index].setAttribute('data-app-action-sidebar-project-collapsed', String(collapsed)),
          removeMenu: () => menu.remove(),
          refresh: () => control.refresh(),
          preserve: () => { const first = document.querySelector('[data-app-action-sidebar-thread-row]'); first.dataset.marker = "kept"; return first; },
          marker: () => document.querySelector('[data-app-action-sidebar-thread-row]')?.dataset.marker,
        };
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".png": "dataurl", ".svg": "dataurl" },
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("Sidebar section fixture bundle is missing");

async function setup(page: Page, options: Record<string, unknown> = {}) {
  await page.setContent(`<!doctype html><style>
    body { margin: 0; font: 13px system-ui; }
    [data-app-action-sidebar-thread-row], [data-app-action-sidebar-project-row] { padding: 0 8px; box-sizing: border-box; }
    .row-line { display: flex; align-items: center; gap: 8px; height: 100%; }
    .row-lead { width: 16px; flex: 0 0 16px; }
  </style>`);
  await page.addScriptTag({ content: bundle });
  await page.evaluate((value) => Reflect.get(window, "setupSections")(value), options);
  await page.waitForTimeout(80);
}

const tops = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-app-action-sidebar-thread-row]")].map((row) => ({
      thread: row.getAttribute("data-app-action-sidebar-thread-id"),
      top: Math.round(row.getBoundingClientRect().top),
      order: getComputedStyle(row).order,
    })),
  );

test("merges projects by recency while keeping native rows and hiding project chrome", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator("[data-codexhost-section-display-toggle]")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  const rows = await tops(page);
  const visual = [...rows].sort((left, right) => left.top - right.top);
  expect(visual.map((row) => row.thread)).toEqual([
    "host:a1",
    "host:b1",
    "host:b2",
    "host:a2",
    "host:a3",
  ]);
  expect(visual.map((row) => Number(row.order))).toEqual([0, 1, 2, 3, 4]);
  expect(await page.evaluate(() => Reflect.get(window, "sectionFixture").headerDisplays())).toEqual(
    ["none", "none"],
  );
  expect(await page.evaluate(() => Reflect.get(window, "sectionFixture").railDisplays())).toEqual([
    "none",
    "none",
  ]);
  expect(await page.evaluate(() => Reflect.get(window, "sectionFixture").state())).toBe("merged");
});

test("merges the visible rows and replaces project expanders with one merged control", async ({
  page,
}) => {
  await setup(page);
  const more = page.locator("[data-codexhost-merge-more]");
  await expect(more).toHaveCount(1);
  await expect(more.locator("button")).toHaveText("展开显示");
  await expect(
    page.locator("[data-codexhost-merge-hidden] button").filter({ hasText: "展开显示" }),
  ).toHaveCount(1);
  const collapsed = [...(await tops(page))].sort((left, right) => left.top - right.top);
  expect(collapsed.map((row) => row.thread)).toEqual([
    "host:a1",
    "host:b1",
    "host:b2",
    "host:a2",
    "host:a3",
  ]);

  await more.locator("button").click();
  await expect(more.locator("button")).toHaveText("收起");
  await expect(page.locator("[data-app-action-sidebar-thread-row]")).toHaveCount(6);
  const expanded = [...(await tops(page))].sort((left, right) => left.top - right.top);
  expect(expanded.map((row) => row.thread)).toEqual([
    "host:a1",
    "host:b1",
    "host:b2",
    "host:b3",
    "host:a2",
    "host:a3",
  ]);

  await more.locator("button").click();
  await expect(more.locator("button")).toHaveText("展开显示");
  await expect(page.locator("[data-app-action-sidebar-thread-row]")).toHaveCount(5);
});

test("removes the project row lead slot only in merged mode", async ({ page }) => {
  await setup(page);
  const lead = page.locator(".row-lead").first();
  await expect(lead).toHaveCSS("display", "none");
  await page.locator("[data-codexhost-section-display-toggle]").click();
  await expect(lead).toHaveCSS("display", "block");
  await page.locator("[data-codexhost-section-display-toggle]").click();
  await expect(lead).toHaveCSS("display", "none");
});

test("keeps every native row node during merge", async ({ page }) => {
  await setup(page);
  const before = await page.evaluate(() => {
    const first = Reflect.get(window, "sectionFixture").preserve();
    return first.isConnected;
  });
  expect(before).toBe(true);
  await page.evaluate(() => Reflect.get(window, "sectionFixture").refresh());
  expect(await page.evaluate(() => Reflect.get(window, "sectionFixture").marker())).toBe("kept");
});

test("toggles back to the native grouped layout with pointer and keyboard", async ({ page }) => {
  await setup(page);
  const toggle = page.locator("[data-codexhost-section-display-toggle]");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => Reflect.get(window, "sectionFixture").state())).toBe("grouped");
  expect(await page.evaluate(() => Reflect.get(window, "sectionFixture").headerDisplays())).toEqual(
    ["block", "block"],
  );
  const stored = await page.evaluate(() =>
    Reflect.get(window, "sectionFixture").storageValues.get("codexhost.sidebarSectionDisplay.v1"),
  );
  expect(JSON.parse(stored ?? "{}")).toEqual({ fixture: "grouped" });

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => Reflect.get(window, "sectionFixture").state())).toBe("merged");
});

test("restores a stored grouped choice on install", async ({ page }) => {
  await setup(page, {
    storage: { "codexhost.sidebarSectionDisplay.v1": JSON.stringify({ fixture: "grouped" }) },
  });
  await expect(page.locator("[data-codexhost-section-display-toggle]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await page.evaluate(() => Reflect.get(window, "sectionFixture").state())).toBe("grouped");
});

test("falls back to native layout and reverts the choice when structure is unusable", async ({
  page,
}) => {
  await setup(page, {
    storage: { "codexhost.sidebarSectionDisplay.v1": JSON.stringify({ fixture: "grouped" }) },
  });
  await page.evaluate(() => Reflect.get(window, "sectionFixture").setCollapsed(1, true));
  await page.evaluate(() => Reflect.get(window, "sectionFixture").refresh());
  expect(await page.evaluate(() => Reflect.get(window, "sectionFixture").state())).toBe(
    "fallback:project-collapsed",
  );
  expect(await page.locator("[data-codexhost-merged-section]").count()).toBe(0);

  // Turning grouping off cannot apply; the choice returns to the native grouped layout.
  await page.locator("[data-codexhost-section-display-toggle]").click();
  await expect(page.locator("[data-codexhost-section-display-toggle]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const stored = await page.evaluate(() =>
    Reflect.get(window, "sectionFixture").storageValues.get("codexhost.sidebarSectionDisplay.v1"),
  );
  expect(JSON.parse(stored ?? "{}")).toEqual({ fixture: "grouped" });
});

test("keeps the section native when the header has no menu trigger", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => Reflect.get(window, "sectionFixture").removeMenu());
  await page.evaluate(() => Reflect.get(window, "sectionFixture").refresh());
  expect(await page.evaluate(() => Reflect.get(window, "sectionFixture").state())).toBe(
    "fallback:toggle-missing",
  );
  await expect(page.locator("[data-codexhost-section-display-toggle]")).toHaveCount(0);
});

test("merges without catalog recency by keeping each project block in native order", async ({
  page,
}) => {
  await setup(page, { noRecency: true });
  const rows = [...(await tops(page))].sort((left, right) => left.top - right.top);
  expect(rows.map((row) => row.thread)).toEqual([
    "host:a1",
    "host:a2",
    "host:a3",
    "host:b1",
    "host:b2",
  ]);
});

test("survives unavailable preference storage", async ({ page }) => {
  await setup(page, { brokenStorage: true });
  await expect(page.locator("[data-codexhost-section-display-toggle]")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.locator("[data-codexhost-section-display-toggle]").click();
  expect(await page.evaluate(() => Reflect.get(window, "sectionFixture").state())).toBe("merged");
});
