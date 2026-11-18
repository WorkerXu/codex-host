import { type RendererAgent } from "./agent-selection-state.js";
import {
  installRendererBindingProbe,
  type RendererBindingProbeApi,
} from "./renderer-binding-probe.js";
import { installCurrentRendererAdapter } from "./versioned-renderer-adapter.js";
import { installRendererProjectMirror } from "./renderer-project-mirror.js";
import { installRendererSidebarSections } from "./renderer-sidebar-sections.js";

export function installRendererBinding(
  enabledAgents?: readonly RendererAgent[],
): RendererBindingProbeApi {
  window.__codexhostRendererBindingProbeV1?.dispose();
  try {
    installRendererProjectMirror();
  } catch (error) {
    console.error(
      "codexhost project mirror installation failed",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
  try {
    installRendererSidebarSections();
  } catch (error) {
    console.error(
      "codexhost sidebar section installation failed",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
  const binding = installRendererBindingProbe({ ...(enabledAgents ? { enabledAgents } : {}) });
  try {
    const adapter = installCurrentRendererAdapter();
    binding.setAdapter(adapter.status, adapter.dispose, adapter.applyAgent, adapter.modelControl);
  } catch (error) {
    console.error(
      "codexhost Renderer Adapter installation failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    binding.setAdapter({
      state: "unsupported",
      reason: "installation-failed",
      modelUpdates: 0,
      hook: null,
    });
  }
  return binding;
}
