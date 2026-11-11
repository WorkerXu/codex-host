import { type RendererAgent } from "./agent-selection-state.js";
import {
  installRendererBindingProbe,
  type RendererBindingProbeApi,
} from "./renderer-binding-probe.js";
import { installRendererProjectGroups } from "./renderer-project-groups.js";
import { installCurrentRendererAdapter } from "./versioned-renderer-adapter.js";

export function installRendererBinding(
  enabledAgents?: readonly RendererAgent[],
): RendererBindingProbeApi {
  window.__codexhostRendererBindingProbeV1?.dispose();
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
  try {
    installRendererProjectGroups();
  } catch (error) {
    console.error(
      "codexhost project groups installation failed",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
  return binding;
}
