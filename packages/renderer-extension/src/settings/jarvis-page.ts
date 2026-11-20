import {
  createRendererJarvisClient,
  jarvisErrorText,
  type RendererJarvisClient,
  type RendererJarvisHost,
} from "../renderer-jarvis-client.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererJarvisSettingsOptions {
  createClient(): RendererJarvisClient | null;
}

const LOGIN_POLL_MS = 2_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

interface MachineRowState {
  host: RendererJarvisHost;
  status: Awaited<ReturnType<RendererJarvisClient["status"]>> | null;
  busy: "install" | "login" | null;
  notice: string | null;
  failed: boolean;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** Turns release platform ids into words a person can read. */
function platformLabel(platform: string): string {
  if (platform === "darwin-arm64") return "macOS（Apple 芯片）";
  if (platform.startsWith("darwin")) return "macOS";
  if (platform.startsWith("linux")) return "Linux";
  if (platform.startsWith("win32") || platform.startsWith("windows")) return "Windows";
  return platform;
}

export function createJarvisSettingsPage(
  messages: RendererSettingsMessages,
  options: RendererJarvisSettingsOptions,
): RendererSettingsPageDefinition {
  const text = messages.jarvis;
  return Object.freeze({
    id: "jarvis",
    label: messages.pageLabels.jarvis,
    icon: "search",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const client = options.createClient() ?? createRendererJarvisClient({ forHost: () => null });
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.jarvis;
      context.content.append(heading);

      const machinesSection = section(document, text.machinesSection);
      const refreshMachines = button(document, text.refresh, "secondary");
      machinesSection.header.append(refreshMachines);
      const machineList = document.createElement("div");
      machineList.className = "settings-jarvis-machines";
      const machineStatus = document.createElement("p");
      machineStatus.className = "settings-jarvis-status";
      machineStatus.setAttribute("role", "status");
      machinesSection.body.append(machineList, machineStatus);
      context.content.append(machinesSection.root);

      const rows = new Map<string, MachineRowState>();
      let disposed = false;

      const setStatus = (element: HTMLElement, value: string, failed = false): void => {
        element.textContent = value;
        element.hidden = value.length === 0;
        element.classList.toggle("settings-jarvis-status--error", failed);
      };

      const renderMachines = (): void => {
        machineList.replaceChildren();
        for (const row of rows.values()) {
          const item = document.createElement("div");
          item.className = "settings-jarvis-row";
          item.setAttribute("data-jarvis-host", row.host.hostId);
          const main = document.createElement("div");
          main.className = "settings-jarvis-row-main";
          const name = document.createElement("strong");
          name.textContent = row.host.local ? text.localMachine : row.host.displayName;
          const detail = document.createElement("span");
          detail.className = "settings-jarvis-row-meta";
          const status = row.status;
          const reachable = row.host.reachable && status?.errorCode !== "unreachable";
          const parts: string[] = [];
          if (!reachable) {
            parts.push(text.unreachable);
          } else if (!status) {
            parts.push(text.refreshing);
          } else if (status.installed) {
            parts.push(text.installed);
            if (status.version) parts.push(text.cliVersion.replace("{version}", status.version));
            if (status.platform) parts.push(platformLabel(status.platform));
          } else {
            parts.push(text.notInstalled);
          }
          if (status?.installed && reachable) {
            if (status.authenticated && status.userName) {
              parts.push(text.signedInAs.replace("{name}", status.userName));
            } else if (!status.authenticated) {
              parts.push(text.notLoggedIn);
            }
          }
          detail.textContent = parts.join(" · ");
          main.append(name, detail);
          const notice = document.createElement("span");
          notice.className = "settings-jarvis-row-notice";
          if (row.notice) {
            notice.textContent = row.notice;
            notice.classList.toggle("settings-jarvis-status--error", row.failed);
          }
          const actions = document.createElement("div");
          actions.className = "settings-jarvis-actions";
          if (reachable && status && !status.installed) {
            const install = button(
              document,
              row.busy === "install" ? text.installing : text.install,
            );
            install.disabled = row.busy !== null;
            install.addEventListener("click", () => void installMachine(row));
            actions.append(install);
          } else if (reachable && status && !status.authenticated) {
            const login = button(document, row.busy === "login" ? text.loggingIn : text.login);
            login.disabled = row.busy !== null;
            login.addEventListener("click", () => void loginMachine(row));
            actions.append(login);
          }
          item.append(main, notice, actions);
          machineList.append(item);
        }
      };

      const refreshMachine = async (row: MachineRowState): Promise<void> => {
        row.notice = null;
        row.failed = false;
        row.status = await client.status(row.host.hostId);
        if (!disposed) renderMachines();
      };

      const loadMachines = async (): Promise<void> => {
        setStatus(machineStatus, text.refreshing);
        const hosts = await client.hosts();
        if (disposed) return;
        const previous = new Map(rows);
        rows.clear();
        for (const host of hosts) {
          const row = previous.get(host.hostId) ?? {
            host,
            status: null,
            busy: null,
            notice: null,
            failed: false,
          };
          row.host = host;
          rows.set(host.hostId, row);
        }
        renderMachines();
        await Promise.all([...rows.values()].filter((row) => !row.busy).map(refreshMachine));
        if (!disposed) {
          setStatus(machineStatus, "");
          renderMachines();
        }
      };

      const installMachine = async (row: MachineRowState): Promise<void> => {
        row.busy = "install";
        row.notice = null;
        renderMachines();
        try {
          const result = await client.install(row.host.hostId, (progress) => {
            row.notice = text.installProgress
              .replace("{received}", formatBytes(progress.received))
              .replace("{total}", formatBytes(progress.total));
            if (!disposed) renderMachines();
          });
          row.status =
            result.state === "installed" ? result.status : await client.status(row.host.hostId);
          row.failed = result.state !== "installed";
          if (result.state !== "installed") {
            row.notice = text.actionFailed.replace(
              "{reason}",
              jarvisErrorText(
                result.state === "failed" ? result.errorCode : "slow_download",
                messages.locale,
              ),
            );
          } else {
            row.notice = text.installed;
          }
        } catch (error) {
          row.failed = true;
          row.notice = text.actionFailed.replace(
            "{reason}",
            jarvisErrorText(
              typeof error === "object" && error !== null && "message" in error
                ? String((error as { message: unknown }).message)
                : null,
              messages.locale,
            ),
          );
        } finally {
          row.busy = null;
          if (!disposed) renderMachines();
        }
      };

      const loginMachine = async (row: MachineRowState): Promise<void> => {
        row.busy = "login";
        row.notice = text.waitingForBrowser;
        row.failed = false;
        renderMachines();
        let session: Awaited<ReturnType<RendererJarvisClient["login"]>> | null = null;
        try {
          session = await client.login(row.host.hostId);
          if (session.forwardErrorCode && row.host.hostId !== "local") {
            row.failed = true;
            row.notice = text.actionFailed.replace(
              "{reason}",
              jarvisErrorText(session.forwardErrorCode, messages.locale),
            );
            return;
          }
          const started = Date.now();
          while (!disposed && Date.now() - started < LOGIN_TIMEOUT_MS) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, LOGIN_POLL_MS));
            const status = await client.status(row.host.hostId);
            row.status = status;
            if (status.authenticated) {
              row.notice = null;
              break;
            }
            if (!status.installed) break;
          }
        } catch (error) {
          row.failed = true;
          row.notice = text.actionFailed.replace(
            "{reason}",
            jarvisErrorText(error instanceof Error ? error.message : null, messages.locale),
          );
        } finally {
          session?.close();
          row.busy = null;
          if (!disposed) renderMachines();
        }
      };

      const refresh = async () => {
        refreshMachines.disabled = true;
        try {
          await context.runLatest(loadMachines, {
            success: () => undefined,
            failure: (error) =>
              setStatus(
                machineStatus,
                text.actionFailed.replace(
                  "{reason}",
                  jarvisErrorText(errorText(error), messages.locale),
                ),
                true,
              ),
          });
        } finally {
          if (!disposed) refreshMachines.disabled = false;
        }
      };
      refreshMachines.addEventListener("click", () => void refresh());
      void refresh();

      return () => {
        disposed = true;
      };
    },
  });
}

function errorText(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : "jarvis_failed";
}

function section(
  document: Document,
  title: string,
): { root: HTMLElement; header: HTMLElement; body: HTMLElement } {
  const root = document.createElement("section");
  root.className = "settings-jarvis-section";
  const header = document.createElement("div");
  header.className = "settings-jarvis-header";
  const label = document.createElement("div");
  label.className = "settings-section-label";
  label.textContent = title;
  header.append(label);
  const body = document.createElement("div");
  body.className = "settings-jarvis-body";
  root.append(header, body);
  return { root, header, body };
}

function button(
  document: Document,
  label: string,
  variant: "primary" | "secondary" = "primary",
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className =
    variant === "primary"
      ? "settings-command-button"
      : "settings-command-button settings-command-button--secondary";
  element.textContent = label;
  return element;
}
