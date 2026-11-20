import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createCrossHostAgentSection } from "./packages/renderer-extension/src/renderer-cross-host-agent-section.ts";

      const machines = {
        macConversation: {
          loadedPeers: 1,
          machines: [
            {
              hostId: "remote-ssh-discovered:oracle-main",
              label: "甲骨文新加坡",
              state: "ready",
              harnesses: [
                { id: "codex", label: "Codex" },
                { id: "claude-code", label: "Claude Code" },
              ],
            },
            {
              hostId: "remote-ssh-codex-managed:colab",
              label: "colab",
              state: "offline",
              harnesses: [],
            },
          ],
        },
        oracleConversation: {
          loadedPeers: 1,
          machines: [
            {
              hostId: "local",
              label: "此计算机",
              state: "ready",
              harnesses: [
                { id: "codex", label: "Codex" },
                { id: "claude-code", label: "Claude Code" },
              ],
            },
          ],
        },
      };

      globalThis.setupCrossHostSection = (which) => {
        document.body.replaceChildren();
        const menu = document.createElement("div");
        menu.style.width = "224px";
        menu.style.padding = "4px";
        menu.style.font = "500 13px/1 system-ui, sans-serif";
        const section = createCrossHostAgentSection({
          document,
          catalog: machines[which],
          onSelect: () => {},
          onClose: () => {},
        });
        globalThis.crossHostSection = section;
        menu.append(section.element);
        document.body.append(menu);
      };
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-cross-host-section-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  platform: "browser",
  target: "es2024",
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Cross-host section E2E bundle was not generated");

const openSection = async (page: Page, which: string): Promise<void> => {
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate((value) => {
    const setup = Reflect.get(globalThis, "setupCrossHostSection");
    if (typeof setup !== "function") throw new Error("Cross-host section setup is unavailable");
    setup(value);
  }, which);
};

test("lists every other machine with its ready agents and no enable gate", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 640 });
  await page.setContent(
    '<!doctype html><body style="margin:0;padding:24px;background:#fff;color:#111"></body>',
  );
  await openSection(page, "macConversation");

  await expect(page.getByText("其他机器")).toBeVisible();
  await expect(page.getByText("启用跨机对话")).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "甲骨文新加坡" })).toBeVisible();
  const offline = page.getByRole("menuitem", { name: "colab 离线" });
  await expect(offline).toBeDisabled();

  await page.getByRole("menuitem", { name: "甲骨文新加坡" }).click();
  await expect(page.getByRole("menuitem", { name: "甲骨文新加坡 · Claude Code" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("cross-host-light.png") });
});

test("shows this Mac for a project that lives on another machine", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 640 });
  await page.setContent(
    '<!doctype html><body style="margin:0;padding:24px;background:#1e1e1e;color:#eee"></body>',
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await openSection(page, "oracleConversation");

  await expect(page.getByRole("menuitem", { name: "此计算机" })).toBeVisible();
  await page.getByRole("menuitem", { name: "此计算机" }).click();
  await expect(page.getByRole("menuitem", { name: "此计算机 · Claude Code" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("cross-host-dark.png") });
});
