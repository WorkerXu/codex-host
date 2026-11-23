import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { installRendererBinding } from "./packages/renderer-extension/src/install-renderer-binding.ts";

      const composer = document.querySelector("[data-codex-composer-root]");
      const hostId = composer.dataset.projectHost ?? "local";
      const draftId = "client-new-thread:fixture";
      Object.defineProperty(document.querySelector("[role=textbox]"), "__reactFiber$fixture", {
        value: { memoizedProps: { isOrbit: false }, updateQueue: {
          memoCache: { data: [[draftId, draftId]] },
        } },
      });

      const row = document.querySelector("[data-app-action-sidebar-thread-row]");
      row.__reactFiber$fixture = {
        memoizedProps: {
          conversationId: "thread-a",
          dataAttributes: Object.fromEntries(row.getAttributeNames().map((key) => [key, row.getAttribute(key)])),
        },
      };
      document.querySelector("[data-sidebar-cycle-item]").__reactFiber$fixture = {
        memoizedProps: { "data-selected-scheduled-task": false },
        return: { memoizedProps: {
          automation: { kind: "heartbeat", id: "task-a", targetThreadId: "thread-b" },
        } },
      };

      const requests = [];
      globalThis.fixtureRequests = requests;
      const makeClient = (id, name, peers = []) => ({
        listHarnessPlugins: async () => ({
          plugins: [{ id, name, version: "1" }],
          availability: { [id]: "ready" },
        }),
        inspectHarness: async () => ({ status: "ready" }),
        listDelegationPeers: async () => ({ peers }),
        listThreadOwnership: async ({ threadIds }) => {
          requests.push("codexhost/thread/ownership/list");
          return { threads: threadIds.map((threadId) => ({ threadId, owner: "codex" })) };
        },
      });
      const clients = {
        local: makeClient("pi", "Pi", [
          { name: "fixture-peer", hostIds: ["remote"], state: "ready", harnesses: ["claude-code"] },
        ]),
        remote: makeClient("claude-code", "Claude Code"),
      };

      const binding = installRendererBinding();
      window.__codexhostHostRoutingV1 = {
        forHost: () => ({
          manager: { sendRequest: async (method) => { requests.push(method); return null; } },
          policy: { scopedCreation: false },
        }),
      };
      binding.setAdapter(
        { state: "ready", reason: "ready", modelUpdates: 0, hook: "request-bridge" },
        undefined,
        () => true,
        {
          currentHostId: (target) => target === composer ? hostId : "local",
          knownHostIds: () => Object.keys(clients),
          clientForHost: (id) => clients[id] ?? null,
        },
      );
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  write: false,
  loader: { ".png": "dataurl", ".svg": "dataurl", ".css": "text" },
});

async function openDesktopFixture(page: Page, projectHost?: "local" | "remote") {
  const bundle = outputFiles[0]?.text;
  if (!bundle) throw new Error("The Desktop fixture bundle is empty");
  const project = projectHost ? ` data-project-host="${projectHost}"` : "";
  await page.route("http://desktop.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><body>
        <aside data-app-action-sidebar-scroll>
          <section data-app-action-sidebar-section>
            <div data-sidebar-project-container-id="project:local">
              <button data-app-action-sidebar-project-row>Local project</button>
              <div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:thread-a"
                   data-app-action-sidebar-thread-host-id="local">
                <div data-thread-title-trigger><span data-thread-title>Conversation</span></div>
              </div>
            </div>
            <div data-sidebar-project-container-id="project:remote">
              <button data-app-action-sidebar-project-row>Remote project</button>
            </div>
          </section>
          <div data-sidebar-cycle-item role="button" aria-labelledby="schedule-title">
            <span id="schedule-title" data-thread-title>Scheduled conversation</span>
          </div>
        </aside>
        <main style="position: fixed; bottom: 60px; left: 100px; width: 550px">
          <div data-codex-composer-root${project}>
            <div data-above-composer-portal></div>
            <div contenteditable="true" role="textbox"></div>
            <div><button type="submit" aria-label="Send">Send</button></div>
          </div>
        </main>
      </body>`,
    }),
  );
  await page.goto("http://desktop.test/");
  await page.addScriptTag({ content: bundle });
}

test("keeps native project headers and leaves conversation and schedule rows free of Agent icons", async ({
  page,
}) => {
  await openDesktopFixture(page);
  const section = page.locator("[data-app-action-sidebar-section]");
  await expect(section.getByRole("button")).toHaveText(["Local project", "Remote project"]);
  await expect(
    section.locator('[data-sidebar-project-container-id="project:local"]'),
  ).toContainText("Conversation");
  await expect(page.getByText("Scheduled conversation")).toBeVisible();
  await expect(page.locator("aside [data-codexhost-sidebar-agent-icon]")).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "fixtureRequests"))).not.toContain(
    "codexhost/thread/ownership/list",
  );
});

for (const { draft, projectHost, own, other } of [
  { draft: "projectless local draft", projectHost: undefined, own: "Pi", other: "Claude Code" },
  { draft: "local project draft", projectHost: "local", own: "Pi", other: "Claude Code" },
  { draft: "remote project draft", projectHost: "remote", own: "Claude Code", other: "Pi" },
] as const) {
  test(`${draft} Agent picker uses its Host's catalog`, async ({ page }) => {
    await openDesktopFixture(page, projectHost);
    await page.locator("[data-codexhost-agent-control] > button").click();
    const menu = page.getByRole("menu", { name: "Agent", exact: true });
    await expect(menu.getByRole("menuitemradio", { name: "Codex" })).toBeVisible();
    await expect(menu.getByRole("menuitemradio", { name: own })).toBeEnabled();
    await expect(menu.getByText(other, { exact: true })).toHaveCount(0);
    await expect(menu.getByText(/其他机器|Other machines/u)).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, "fixtureRequests"))).not.toContain(
      "codexhost/desktop-projects/catalog",
    );
  });
}

test("the # menu can still insert a cross-machine mention", async ({ page }) => {
  await openDesktopFixture(page);
  const editor = page.getByRole("textbox");
  await editor.press("#");
  const menu = page.locator("[data-codexhost-delegation-mention-menu]");
  await expect(menu.getByText("fixture-peer")).toBeVisible();
  await menu.getByRole("option").filter({ hasText: "claude-code" }).click();
  await expect(editor).toContainText("subagent://codexhost.claude-code?host=fixture-peer");
});
