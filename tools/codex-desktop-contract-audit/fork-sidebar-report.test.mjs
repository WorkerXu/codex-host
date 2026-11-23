// @vitest-environment jsdom
import { validateRendererContractAuditInspection } from "@codexhost/desktop-control";
import { expect, it } from "vitest";

import { inspectRendererContracts } from "../../packages/renderer-extension/src/contract-audit.js";
import { inspectRendererSidebarContract } from "../../packages/renderer-extension/src/renderer-sidebar-agent-icons.js";
import { buildSurfaceResults } from "./report.mjs";

it("audits sidebar Thread identity in the fork and checks title ownership when collected", () => {
  const { document } = globalThis.window;
  document.body.innerHTML = `
    <div data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:thread-a"
         data-app-action-sidebar-thread-host-id="local">Conversation</div>`;
  const row = document.body.firstElementChild;
  Reflect.set(row, "__reactFiber$fixture", {
    memoizedProps: {
      conversationId: "thread-a",
      dataAttributes: Object.fromEntries(
        Array.from(row.attributes, ({ name, value }) => [name, value]),
      ),
    },
  });

  const contracts = validateRendererContractAuditInspection(inspectRendererContracts());
  expect(contracts.sidebar).toEqual({
    rowCount: 1,
    resolvedThreadCount: 1,
    ambiguousThreadCount: 0,
  });
  const upstreamSidebar = () =>
    validateRendererContractAuditInspection({
      ...contracts,
      sidebar: inspectRendererSidebarContract(document),
    });
  expect(buildSurfaceResults(upstreamSidebar()).find(({ id }) => id === "sidebar")?.verdict).toBe(
    "confirmed-impact",
  );
  row.innerHTML =
    "<div data-thread-title-trigger><span data-thread-title>Conversation</span></div>";
  const baseline = { surfaces: buildSurfaceResults(upstreamSidebar()) };
  expect(buildSurfaceResults(contracts, baseline).find(({ id }) => id === "sidebar")).toMatchObject(
    {
      verdict: "no-impact",
      baselineChanged: false,
    },
  );
  expect(baseline.surfaces.find(({ id }) => id === "sidebar")?.verdict).toBe("no-impact");

  Reflect.deleteProperty(row, "__reactFiber$fixture");
  const invalidIdentity = validateRendererContractAuditInspection(inspectRendererContracts());
  expect(buildSurfaceResults(invalidIdentity).find(({ id }) => id === "sidebar")?.verdict).toBe(
    "confirmed-impact",
  );
});
