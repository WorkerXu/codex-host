import { hostThreadIdSchema } from "@codexhost/shared-contracts";

import { createRendererCodexAgentsClient } from "./renderer-codex-agents-client.js";
import { createRendererDingTalkClient } from "./renderer-dingtalk-client.js";
import { createRendererDingTalkDispatchClient } from "./renderer-dingtalk-dispatch-client.js";
import { embedDingTalkMention } from "./renderer-dingtalk-embed.js";
import { openRendererThread } from "./renderer-fork-control.js";
import type { RendererSettingsLocale } from "./settings/localization.js";
import type { DesktopWorkbenchSettings } from "./settings/pages.js";

export function desktopDingTalkSettings(
  ownerWindow: Window,
  readLocale: () => RendererSettingsLocale,
): Pick<DesktopWorkbenchSettings, "dingtalk" | "codexAgents"> {
  const forHost = (hostId: string) => ownerWindow.__codexhostHostRoutingV1?.forHost(hostId) ?? null;
  const client = createRendererDingTalkClient({ forHost });
  const dispatch = createRendererDingTalkDispatchClient({
    manager: () => forHost("local")?.manager ?? null,
  });
  const agents = createRendererCodexAgentsClient({ forHost });
  return {
    dingtalk: {
      createClient: () => client,
      createDispatchClient: () => dispatch,
      readLocale,
      embed: embedDingTalkMention,
      openThread(threadId) {
        const parsed = hostThreadIdSchema.safeParse(threadId);
        if (parsed.success)
          void openRendererThread(parsed.data, { hostId: "local" }).catch(() => undefined);
      },
    },
    codexAgents: { createClient: () => agents },
  };
}
