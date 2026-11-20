import { createRendererModelServiceClient } from "./model-service-client.js";
import {
  createRendererJarvisClient,
  jarvisSearchShouldFallback,
} from "./renderer-jarvis-client.js";
import type { RemoteConnectionsControl } from "./remote-connections-control.js";
import type { RendererJarvisMentionOptions } from "./renderer-jarvis-mention.js";

export function createDesktopJarvis(ownerWindow: Window, connections: RemoteConnectionsControl) {
  const forHost = (hostId: string) => ownerWindow.__codexhostHostRoutingV1?.forHost(hostId) ?? null;
  const jarvis = createRendererJarvisClient({
    forHost,
    async listHosts() {
      const remote = await connections.ssh.list().catch(() => []);
      return [
        {
          hostId: "local",
          displayName: "Local",
          local: true,
          reachable: forHost("local") !== null,
        },
        ...remote.map(({ hostId, displayName }) => ({
          hostId,
          displayName,
          local: false,
          reachable: forHost(hostId) !== null,
        })),
      ];
    },
    openExternal: (url) => ownerWindow.open(url, "_blank", "noopener,noreferrer"),
  });

  // Search using the Desktop Host's login and Gemini key when available.
  // Remote Hosts can still list projects and preview titles with their own CLI.
  function preferLocal<Params, Result extends { errorCode: string | null }>(
    request: (hostId: string, params: Params, signal?: AbortSignal) => Promise<Result>,
  ) {
    return async (hostId: string, params: Params, signal?: AbortSignal): Promise<Result> => {
      if (hostId !== "local" && jarvis.localAvailable()) {
        const result = await request("local", params, signal);
        if (signal?.aborted || !jarvisSearchShouldFallback(result)) return result;
      }
      return request(hostId, params, signal);
    };
  }

  const search: Pick<
    RendererJarvisMentionOptions,
    "listProjects" | "previewProjectBugTitle" | "searchProjectBugs"
  > = {
    listProjects: preferLocal(jarvis.listProjects),
    previewProjectBugTitle: preferLocal(jarvis.previewProjectBugTitle),
    searchProjectBugs: preferLocal(jarvis.searchProjectBugs),
  };

  return {
    search,
    settings: {
      jarvis: { createClient: () => jarvis },
      modelService: createRendererModelServiceClient(() => forHost("local")?.manager ?? null),
    },
  };
}
