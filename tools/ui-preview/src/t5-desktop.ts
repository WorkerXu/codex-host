import { harnessIdSchema, type HarnessPluginDescriptor } from "@codexhost/shared-contracts";
import claudeIcon from "../../../packages/adapters/claude-code/assets/icon.svg";
import grokIcon from "../../../packages/adapters/grok/assets/icon.png";
import {
  mountRendererAgentPicker,
  renderRendererAgentPicker,
} from "../../../packages/renderer-extension/src/renderer-agent-picker.js";
import { createCrossHostAgentSection } from "../../../packages/renderer-extension/src/renderer-cross-host-agent-section.js";
import { installRendererDelegationMention } from "../../../packages/renderer-extension/src/renderer-delegation-mention.js";
import { mountSidebarSectionsPreview } from "./sidebar-sections.js";

const root = document.querySelector<HTMLElement>("main");
if (!root) throw new Error("Preview container is missing");
const feature = document.body.dataset.feature;
const claude: HarnessPluginDescriptor = {
  id: harnessIdSchema.parse("claude-code"),
  name: "Claude Code",
  version: "1",
  icon: claudeIcon,
};
const grok: HarnessPluginDescriptor = {
  id: harnessIdSchema.parse("grok"),
  name: "Grok Build",
  version: "1",
  icon: grokIcon,
};
if (feature === "sections") {
  mountSidebarSectionsPreview(root);
} else {
  const composer = document.createElement("div");
  composer.className = "preview-composer";
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "消息");
  const toolbar = document.createElement("div");
  toolbar.className = "preview-toolbar";
  composer.append(editor, toolbar);
  root.append(composer);

  if (feature === "mirror") {
    const picker = mountRendererAgentPicker(
      "preview",
      ["codex", "claude-code"],
      () => undefined,
      () => undefined,
      undefined,
      undefined,
      [claude],
      true,
    );
    renderRendererAgentPicker(picker, { agent: "codex", phase: "draft" }, "ready", false, {
      "claude-code": "ready",
    });
    picker.menu.append(
      createCrossHostAgentSection({
        document,
        catalog: {
          loadedPeers: 1,
          machines: [
            {
              hostId: "oracle",
              label: "oracle-sg",
              state: "ready",
              harnesses: [
                { id: "codex", label: "Codex" },
                { id: "claude-code", label: "Claude Code", plugin: claude },
              ],
            },
            { hostId: "second", label: "Colab", state: "offline", harnesses: [] },
          ],
        },
        onClose: () => picker.close(),
        onSelect: () => undefined,
      }).element,
    );
    toolbar.append(picker.root);
  } else {
    installRendererDelegationMention(document, {
      readTargets: () => [
        { agent: "codex", label: "Codex", hostLabel: "此计算机" },
        {
          agent: "claude-code",
          label: "Claude Code",
          hostId: "oracle-main",
          hostLabel: "oracle-sg",
          plugin: claude,
        },
        {
          agent: "grok",
          label: "Grok Build",
          hostId: "oracle-main",
          hostLabel: "oracle-sg",
          plugin: grok,
        },
      ],
      readPeerNotices: () => [
        { name: "Colab", reason: "ssh: timed out" },
        { name: "Lab", reason: "ssh: connection refused" },
      ],
      isComposerEditor: (candidate) => candidate === editor,
      readLocale: () => "zh-CN",
      anchorForEditor: () => composer,
      readCommands: () => null,
    });
  }
}
