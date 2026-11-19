import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";
import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });
const { outputFiles } = await build({
  stdin: {
    contents: `
      import { mountSkillsPreview } from "./tools/ui-preview/src/skills.ts";
      globalThis.setupSkills = mountSkillsPreview;
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "skills-library-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});
async function setup(page: Page) {
  await page.route("http://localhost/skills-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("http://localhost/skills-test");
  await page.addScriptTag({ content: outputFiles[0]?.text ?? "" });
  await page.evaluate(() => Reflect.get(globalThis, "setupSkills")());
  await expect(page.locator(".skills-card")).toHaveCount(3);
}

test("search keeps Shadow DOM focus across characters, filters, and empty results", async ({
  page,
}) => {
  await setup(page);
  const search = page.getByRole("searchbox", { name: "搜索技能" });
  await search.pressSequentially("writing");
  await expect(search).toHaveValue("writing");
  await expect(search).toBeFocused();
  await expect(page.locator(".skills-card-name")).toHaveText(["writing-guide"]);
  await search.fill("nothing-matches");
  await expect(page.locator(".skills-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "管理排除…" })).toBeVisible();
  await search.fill("");
  await page.getByLabel("筛选机器").selectOption("oracle-main");
  await page.getByRole("button", { name: "已链接", exact: true }).click();
  await expect(page.getByRole("button", { name: "已链接", exact: true })).toBeFocused();
  await expect(page.locator(".skills-card")).toHaveCount(2);
  await page.getByRole("button", { name: "未链接", exact: true }).click();
  await expect(page.locator(".skills-card")).toHaveCount(0);
});

test("badges confirm link and unlink, cancel without applying, and offer undo", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator(".skills-card").first().locator(".skills-badge img")).toHaveCount(3);
  const card = page
    .locator(".skills-card")
    .filter({ has: page.getByText("design-review", { exact: true }) });
  await card.getByRole("button", { name: /^Cursor 未链接/ }).click();
  await expect(page.getByRole("dialog")).toContainText("新建 1 个链接");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-skills-link-applies", "0");
  await card.getByRole("button", { name: /^Cursor 未链接/ }).click();
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(card.getByRole("button", { name: /^Cursor 已链接/ })).toBeVisible();
  await card.getByRole("button", { name: /^Cursor 已链接/ }).click();
  await expect(page.getByRole("dialog")).toContainText("解除 1 个链接");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(card.getByRole("button", { name: /^Cursor 未链接/ })).toBeVisible();
  await page.locator(".skills-undo").getByRole("button", { name: "撤销", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "撤销", exact: true }).click();
  await expect(card.getByRole("button", { name: /^Cursor 已链接/ })).toBeVisible();
  await expect(card.getByRole("button", { name: "Codex 原生支持", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("Agent detail shows path, native status, linked and conflict counts", async ({ page }) => {
  await setup(page);
  await page.getByRole("tab", { name: "按 Agent" }).click();
  await page.locator(".skills-agent-card").filter({ hasText: "Claude Code" }).click();
  await expect(page.locator(".skills-detail-stats")).toHaveText("3 个技能 · 1 已链接 · 1 冲突");
  await expect(page.locator(".skills-detail-head .skills-path")).toHaveText("~/.claude/skills");
  await expect(page.locator(".skills-state")).toHaveText(["冲突", "已链接", "未链接"]);
  await page.getByRole("button", { name: "返回所有 Agent" }).click();
  await page.locator(".skills-agent-card").filter({ hasText: "Codex" }).click();
  await expect(page.locator(".skills-state")).toHaveText(["原生支持", "原生支持", "原生支持"]);
});

for (const width of [720, 1024, 1440]) {
  test(`list content stays within its columns at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    await page.getByRole("button", { name: "列表视图" }).click();
    const overflow = await page.locator(".skills-card-list").evaluateAll((cards) =>
      cards.flatMap((card) =>
        Array.from(card.children)
          .filter((child) => {
            const box = child.getBoundingClientRect();
            const parent = card.getBoundingClientRect();
            return (
              box.left < parent.left ||
              box.right > parent.right ||
              (getComputedStyle(child).overflowX === "visible" &&
                child.scrollWidth > child.clientWidth + 1)
            );
          })
          .map((child) => child.className),
      ),
    );
    expect(overflow).toEqual([]);
  });
}

test("search preserves an active IME composition until the text is committed", async ({ page }) => {
  await setup(page);
  const search = page.getByRole("searchbox", { name: "搜索技能" });
  await search.focus();
  const connected = await search.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    input.value = "界面";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    return input.isConnected;
  });
  expect(connected).toBe(true);
  await search.dispatchEvent("compositionend");
  await expect(search).toHaveValue("界面");
  await expect(search).toBeFocused();
  await expect(page.locator(".skills-card-name")).toHaveText(["design-review"]);
});

test("Desktop machine names are consistent across filters, chips, sync, conflicts and exclusions", async ({
  page,
}) => {
  await setup(page);
  const machines = page.getByRole("combobox", { name: "筛选机器" });
  await expect(machines.locator("option")).toHaveText([
    "全部机器",
    "此计算机",
    "甲骨文新加坡",
    "offline-server",
    "build-server",
  ]);
  await expect(machines.locator('option[value="oracle-main"]')).toHaveText("甲骨文新加坡");
  await expect(page.locator(".skills-chips").first()).toContainText("此计算机");
  await expect(page.locator(".skills-chips").first()).toContainText("甲骨文新加坡");
  await expect(page.locator(".skills-chips").first()).not.toContainText("oracle-main");
  await page.getByRole("button", { name: "同步…", exact: true }).first().click();
  const sync = page.getByRole("dialog");
  await expect(sync.getByRole("combobox", { name: "来源机器" }).locator("option")).toHaveText([
    "此计算机",
    "甲骨文新加坡",
  ]);
  await expect(sync.getByRole("checkbox", { name: "甲骨文新加坡", exact: true })).toBeChecked();
  await sync.getByRole("button", { name: "预览", exact: true }).click();
  const conflicts = page.getByRole("dialog");
  await expect(conflicts.locator(".skills-version strong")).toHaveText([
    "此计算机",
    "甲骨文新加坡较新",
  ]);
  await expect(conflicts.locator(".skills-diff-heading")).toHaveText("此计算机 → 甲骨文新加坡");
  await conflicts.locator('input[value="local"]').check();
  await conflicts.getByRole("button", { name: "继续", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("此计算机 → 甲骨文新加坡");
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "管理排除…", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "设置机器" }).locator("option")).toHaveText([
    "此计算机",
    "甲骨文新加坡",
    "build-server",
  ]);
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("tab", { name: "按 Agent" }).click();
  await page
    .locator(".skills-machine-group")
    .filter({ has: page.getByRole("heading", { name: "甲骨文新加坡", exact: true }) })
    .getByRole("button", { name: "一键链接", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("heading")).toHaveText(
    "甲骨文新加坡 · 链接变更预览",
  );
});

test("Agent groups only label offline machines and hide linking for machines without Agents", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("tab", { name: "按 Agent" }).click();
  const groups = page.locator(".skills-machine-group");
  await expect(groups.locator(".skills-machine-heading h3")).toHaveText([
    "此计算机",
    "甲骨文新加坡",
    "build-server",
    "offline-server",
  ]);
  await expect(groups.locator(".skills-machine-heading .skills-chip")).toHaveText(["离线"]);
  const empty = groups.filter({
    has: page.getByRole("heading", { name: "build-server", exact: true }),
  });
  await expect(empty).toContainText("这台机器上没有已安装的 Agent");
  await expect(empty.getByRole("button", { name: "一键链接", exact: true })).toHaveCount(0);
  const offline = groups.filter({
    has: page.getByRole("heading", { name: "offline-server", exact: true }),
  });
  await expect(offline.locator(".skills-chip")).toHaveText("离线");
  await expect(offline.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  await expect(offline.getByRole("button", { name: "一键链接", exact: true })).toHaveCount(0);
  await expect(groups.getByRole("button", { name: "一键链接", exact: true })).toHaveCount(2);
});

test("sync completion only offers linking on machines with installed Agents", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "全部补齐", exact: true }).click();
  await page.getByRole("dialog").locator('input[value="local"]').check();
  await page.getByRole("dialog").getByRole("button", { name: "继续", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "开始同步", exact: true }).click();
  const done = page.getByRole("dialog");
  await expect(done.getByRole("heading")).toHaveText("同步完成");
  await expect(done.getByRole("button", { name: "一键链接", exact: true })).toHaveCount(1);
  await expect(
    done
      .locator(".skills-head")
      .filter({ hasText: "甲骨文新加坡" })
      .getByRole("button", { name: "一键链接", exact: true }),
  ).toBeVisible();
  await expect(
    done
      .locator(".skills-head")
      .filter({ hasText: "build-server" })
      .getByRole("button", { name: "一键链接", exact: true }),
  ).toHaveCount(0);
});
