import {
  DINGTALK_DISPATCH_PROJECT_METHOD,
  DINGTALK_DISPATCH_PROJECT_READY_METHOD,
  dingtalkDispatchProjectSchema,
} from "@codexhost/shared-contracts";
import { loadProjectMirrorDesktopServices } from "./renderer-project-mirror-services.js";
import { readNativeScheduleWorkspaces } from "@codexhost/desktop-control/renderer-bindings";
import type { RendererDingTalkRoute } from "./renderer-dingtalk-client.js";

/** Uses the same native appServices as project mirroring; no private storage writes. */
export async function prepareDingTalkProject(
  ownerWindow: Window,
  input: { cwd: string },
  loadServices = loadProjectMirrorDesktopServices,
): Promise<void> {
  const services = await loadServices(ownerWindow);
  const projects = services?.projects as NonNullable<typeof services>["projects"] & {
    createLocal?(input: {
      appearance: null;
      initializeDefaultWorkspaceGitRepository: false;
      name: string;
      setActive: false;
      sources: string[];
    }): Promise<{ projectId: string } | null>;
  };
  if (!services || typeof projects?.createLocal !== "function")
    throw new Error("Desktop native local project service is unavailable");
  let projectId = readNativeScheduleWorkspaces(ownerWindow.document).find(
    (entry) => entry.cwd === input.cwd,
  )?.id;
  if (!projectId) {
    await services.workspaceFiles.createDirectory({ hostId: "local", path: input.cwd });
    const created = await projects.createLocal({
      appearance: null,
      initializeDefaultWorkspaceGitRepository: false,
      name: "钉钉智能体",
      setActive: false,
      sources: [input.cwd],
    });
    projectId = created?.projectId;
  }
  if (!projectId) throw new Error("Desktop did not confirm the DingTalk project");
}

/** Installs once for the window, independently of settings/page lifetime. */
export function installDingTalkDispatchProject(
  ownerWindow: Window,
  route: () => RendererDingTalkRoute | null,
): () => void {
  let disposed = false;
  let current: RendererDingTalkRoute["manager"] | undefined;
  let unsubscribe: (() => void) | undefined;
  let operations = Promise.resolve();
  const pending = new Set<string>();
  const receive = (value: unknown): void => {
    if (disposed || !value || typeof value !== "object") return;
    const frame = value as { method?: unknown; params?: unknown; hostId?: unknown };
    if (
      frame.method !== DINGTALK_DISPATCH_PROJECT_METHOD ||
      (typeof frame.hostId === "string" && frame.hostId !== "local")
    )
      return;
    const parsed = dingtalkDispatchProjectSchema.safeParse(frame.params);
    const target = route();
    if (!parsed.success || !target || pending.has(parsed.data.requestId)) return;
    const input = parsed.data;
    pending.add(input.requestId);
    operations = operations
      .catch(() => undefined)
      .then(async () => {
        if (disposed) return;
        let error: string | null = null;
        try {
          await prepareDingTalkProject(ownerWindow, input);
        } catch (failure) {
          error = (failure instanceof Error ? failure.message : String(failure)).slice(0, 2000);
        }
        await target.manager.sendRequest(DINGTALK_DISPATCH_PROJECT_READY_METHOD, {
          requestId: input.requestId,
          error,
        });
      })
      .catch(() => undefined)
      .finally(() => pending.delete(input.requestId));
  };
  const refresh = (): void => {
    const next = route()?.manager;
    if (current === next) return;
    unsubscribe?.();
    current = next;
    unsubscribe = next?.addNotificationCallback?.(DINGTALK_DISPATCH_PROJECT_METHOD, receive);
  };
  const onMessage = (event: Event): void => {
    const frame = (event as MessageEvent).data;
    if (frame?.type === "mcp-notification") receive(frame);
  };
  ownerWindow.addEventListener("message", onMessage);
  const timer = ownerWindow.setInterval(refresh, 1_000);
  refresh();
  return () => {
    disposed = true;
    ownerWindow.clearInterval(timer);
    unsubscribe?.();
    ownerWindow.removeEventListener("message", onMessage);
  };
}
