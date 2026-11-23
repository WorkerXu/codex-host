import { type RendererAgent } from "./agent-selection-state.js";
import { FORK_DESKTOP_FEATURES } from "./fork-desktop-features.js";
import {
  installRendererBindingProbe,
  type RendererBindingProbeApi,
} from "./renderer-binding-probe.js";
import { installRendererDelegationProjects } from "./renderer-delegation-projects.js";
import { installCurrentRendererAdapter } from "./versioned-renderer-adapter.js";

export function installRendererBinding(
  enabledAgents?: readonly RendererAgent[],
): RendererBindingProbeApi {
  window.__codexhostRendererBindingProbeV1?.dispose();
  const options = { ...FORK_DESKTOP_FEATURES, ...(enabledAgents && { enabledAgents }) };
  const binding = installRendererBindingProbe(options);
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
  const delegationProjects = installRendererDelegationProjects();
  const refreshProjects = () => delegationProjects.refresh();
  window.addEventListener("codexhost:draft-prewarm-policy-changed", refreshProjects);
  refreshProjects();
  const disposeBinding = binding.dispose.bind(binding);
  binding.dispose = () => {
    window.removeEventListener("codexhost:draft-prewarm-policy-changed", refreshProjects);
    delegationProjects.dispose();
    disposeBinding();
  };
  return binding;
}
