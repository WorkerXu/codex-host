import type { HarnessPluginDescriptor, SkillAgent } from "@codexhost/shared-contracts";
import { createRendererAgentIcon } from "../renderer-agent-icon.js";

/** Artwork is presentation only; the inventory owns which Agents appear. */
export type SkillsAgentPlugin = (hostId: string, id: string) => HarnessPluginDescriptor | undefined;

export function skillsAgentIcons(document: Document, pluginForHost?: SkillsAgentPlugin) {
  const harnessIds: Record<string, string> = {
    cursor: "cursor-cli",
    kiro: "kiro-cli",
    "github-copilot": "copilot",
  };
  return (agent: SkillAgent, hostId: string, size = 18): Node => {
    const id = harnessIds[agent.id] ?? agent.id;
    const plugin = pluginForHost?.(hostId, id);
    if (agent.id === "codex" || plugin?.icon || plugin?.iconStyle?.vector)
      return createRendererAgentIcon(id, size, document, plugin);
    const initials = agent.name.split(/\s+/u).filter(Boolean);
    return document.createTextNode(
      (initials.length > 1 ? initials.map((part) => part[0]).join("") : agent.name)
        .slice(0, 2)
        .toUpperCase(),
    );
  };
}
