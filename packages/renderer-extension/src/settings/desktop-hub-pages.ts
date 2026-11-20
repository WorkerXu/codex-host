import type { RendererHostRouting } from "@codexhost/desktop-control/renderer-bindings";
import { createRendererHubAdminClient } from "../renderer-hub-admin-client.js";
import { createRendererSkillsClient, SKILLS_HUB_METHOD } from "../renderer-skills-client.js";
import { createMcpAdminPage } from "./mcp-admin-page.js";
import { createMemoryAdminPage } from "./memory-admin-page.js";
import type { SkillsAgentPlugin } from "./skills-agent-icon.js";
import { createSkillsSettingsPage } from "./skills-page.js";

export function createDesktopHubPages(options: {
  routing(): RendererHostRouting | undefined;
  pluginForHost: SkillsAgentPlugin;
  localHubAdmin: boolean;
}) {
  const skills = createRendererSkillsClient({
    async request(machineId, params) {
      const routing = options.routing();
      const direct = routing?.forHost(machineId);
      const route = direct ?? routing?.forHost("local");
      if (!route) throw new Error("connection_failed");
      // The coordinator handles peer names that have no open Desktop connection.
      const request = !direct && "hostId" in params ? { ...params, hostId: machineId } : params;
      return route.manager.sendRequest(SKILLS_HUB_METHOD, request, {
        priority: "interactive",
        timeoutMs: 120_000,
      });
    },
  });
  const pages = [
    createSkillsSettingsPage({
      createClient: () => skills,
      pluginForHost: options.pluginForHost,
    }),
  ];
  if (options.localHubAdmin) {
    const admin = createRendererHubAdminClient({
      forHost: (hostId) => options.routing()?.forHost(hostId) ?? null,
    });
    const hubOptions = { createClient: () => admin };
    pages.push(createMcpAdminPage(hubOptions, "MCP 服务器"), createMemoryAdminPage(hubOptions));
  }
  return pages;
}
