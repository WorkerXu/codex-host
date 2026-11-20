import { installRendererSettingsShell } from "../../../packages/renderer-extension/src/settings/shell.js";
import { rendererSettingsMessages } from "../../../packages/renderer-extension/src/settings/localization.js";
import { createMcpAdminPage } from "../../../packages/renderer-extension/src/settings/mcp-admin-page.js";
import { createMemoryAdminPage } from "../../../packages/renderer-extension/src/settings/memory-admin-page.js";
import { createHubPreviewClient } from "./hub-admin.js";
import { skillsPreviewPage } from "./skills.js";

const scenario = document.body.dataset.scenario ?? "skills";
const client = createHubPreviewClient(scenario);
const options = { createClient: () => client };
const shell = installRendererSettingsShell(
  [skillsPreviewPage(), createMcpAdminPage(options, "MCP 服务器"), createMemoryAdminPage(options)],
  rendererSettingsMessages("zh-CN"),
);
const page = scenario.startsWith("skills")
  ? "skills"
  : scenario.startsWith("hub-memory")
    ? "memory"
    : "mcp-servers";
shell.openSettings(undefined, page);
