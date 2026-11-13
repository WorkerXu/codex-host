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

export function createJarvisSettingsPage(
  messages: RendererSettingsMessages,
  options: RendererJarvisSettingsOptions,
): RendererSettingsPageDefinition {
  const text = messages.jarvis;
  return Object.freeze({
    id: "jarvis",
    label: messages.pageLabels.jarvis,
    icon: "settings",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const client = options.createClient() ?? createRendererJarvisClient({ forHost: () => null });
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.jarvis;
      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = text.description;
      context.content.append(heading, description);

      const geminiSection = section(document, text.geminiSection, text.geminiDescription);
      const keyStatus = document.createElement("p");
      keyStatus.className = "settings-jarvis-status";
      keyStatus.setAttribute("role", "status");
      const keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.className = "settings-jarvis-input";
      keyInput.autocomplete = "off";
      keyInput.spellcheck = false;
      const saveKey = button(document, text.geminiSave);
      const clearKey = button(document, text.geminiClear, "secondary");
      const testKey = button(document, text.geminiTest, "secondary");
      const keyActions = document.createElement("div");
      keyActions.className = "settings-jarvis-actions";
      keyActions.append(keyInput, saveKey, clearKey, testKey);
      geminiSection.body.append(keyActions, keyStatus);

      const thresholdSection = section(document, text.thresholdSection, text.thresholdDescription);
      const thresholdInput = document.createElement("input");
      thresholdInput.type = "number";
      thresholdInput.min = "0";
      thresholdInput.max = "1";
      thresholdInput.step = "0.05";
      thresholdInput.className = "settings-jarvis-input settings-jarvis-input--short";
      const saveThreshold = button(document, text.thresholdSave);
      const thresholdActions = document.createElement("div");
      thresholdActions.className = "settings-jarvis-actions";
      thresholdActions.append(thresholdInput, saveThreshold);
      const thresholdStatus = document.createElement("p");
      thresholdStatus.className = "settings-jarvis-status";
      thresholdStatus.setAttribute("role", "status");
      thresholdSection.body.append(thresholdActions, thresholdStatus);

      const machinesSection = section(document, text.machinesSection, text.machinesDescription);
      const machineToolbar = document.createElement("div");
      machineToolbar.className = "settings-jarvis-actions";
      const refreshMachines = button(document, text.refresh, "secondary");
      machineToolbar.append(refreshMachines);
      const machineList = document.createElement("div");
      machineList.className = "settings-jarvis-machines";
      const machineStatus = document.createElement("p");
      machineStatus.className = "settings-jarvis-status";
      machineStatus.setAttribute("role", "status");
      machinesSection.body.append(machineToolbar, machineList, machineStatus);
      context.content.append(geminiSection.root, thresholdSection.root, machinesSection.root);

      const rows = new Map<string, MachineRowState>();
      let hasKey = false;
      let disposed = false;

      const setStatus = (element: HTMLElement, value: string, failed = false): void => {
        element.textContent = value;
        element.classList.toggle("settings-jarvis-status--error", failed);
      };

      const renderKeyState = (): void => {
        keyInput.placeholder = hasKey ? text.geminiKeyConfigured : text.geminiKeyPlaceholder;
        clearKey.hidden = !hasKey;
        testKey.disabled = !hasKey && keyInput.value.trim().length === 0;
        keyStatus.textContent = hasKey ? text.geminiKeyConfigured : text.geminiKeyMissing;
      };

      const loadSettings = async (): Promise<void> => {
        const settings = await client.settings();
        hasKey = settings.hasKey;
        thresholdInput.value = String(settings.threshold);
        renderKeyState();
      };

      const renderMachines = (): void => {
        machineList.replaceChildren();
        for (const row of rows.values()) {
          if (!row.host.local && !row.host.reachable) {
            machineStatus.textContent = text.unreachable;
            machineStatus.classList.add("settings-jarvis-status--error");
          }
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
          if (!reachable && status) {
            parts.push(text.unreachable);
          } else if (status?.installed) {
            parts.push(text.installed);
            if (status.version) parts.push(text.cliVersion.replace("{version}", status.version));
            if (status.platform) parts.push(status.platform);
          } else {
            parts.push(text.notInstalled);
          }
          if (reachable && status?.installed) {
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
          if (!status?.installed) {
            const install = button(
              document,
              row.busy === "install" ? text.installing : text.install,
            );
            install.disabled = row.busy !== null;
            install.addEventListener("click", () => void installMachine(row));
            actions.append(install);
          } else if (reachable && !status?.authenticated) {
            const login = button(document, row.busy === "login" ? text.loggingIn : text.login);
            login.disabled = row.busy !== null;
            login.addEventListener("click", () => void loginMachine(row));
            actions.append(login);
          }
          const refresh = button(document, text.refresh, "secondary");
          refresh.disabled = row.busy !== null;
          refresh.addEventListener("click", () => void refreshMachine(row));
          actions.append(refresh);
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
        rows.clear();
        for (const host of hosts) {
          rows.set(host.hostId, { host, status: null, busy: null, notice: null, failed: false });
        }
        await Promise.all([...rows.values()].map((row) => refreshMachine(row)));
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

      saveKey.addEventListener("click", () => {
        const value = keyInput.value.trim();
        if (!value) return;
        saveKey.disabled = true;
        setStatus(keyStatus, text.geminiSaving);
        void client
          .updateSettings({ geminiApiKey: value })
          .then((result) => {
            hasKey = result.hasKey;
            keyInput.value = "";
            renderKeyState();
            setStatus(keyStatus, text.geminiSaved);
          })
          .catch((error: unknown) => {
            setStatus(
              keyStatus,
              text.actionFailed.replace(
                "{reason}",
                jarvisErrorText(errorText(error), messages.locale),
              ),
              true,
            );
          })
          .finally(() => {
            saveKey.disabled = false;
          });
      });
      clearKey.addEventListener("click", () => {
        void client
          .updateSettings({ geminiApiKey: null })
          .then((result) => {
            hasKey = result.hasKey;
            keyInput.value = "";
            renderKeyState();
            setStatus(keyStatus, text.geminiKeyMissing);
          })
          .catch((error: unknown) => {
            setStatus(
              keyStatus,
              text.actionFailed.replace(
                "{reason}",
                jarvisErrorText(errorText(error), messages.locale),
              ),
              true,
            );
          });
      });
      testKey.addEventListener("click", () => {
        testKey.disabled = true;
        setStatus(keyStatus, text.geminiTesting);
        const pending = keyInput.value.trim();
        const saved = pending
          ? client.updateSettings({ geminiApiKey: pending }).then((result) => {
              hasKey = result.hasKey;
              keyInput.value = "";
              renderKeyState();
            })
          : Promise.resolve();
        void saved
          .then(() => client.testSettings())
          .then((result) => {
            setStatus(
              keyStatus,
              result.ok
                ? text.geminiTestOk.replace("{latency}", String(result.latencyMs ?? 0))
                : text.geminiTestFailed.replace(
                    "{reason}",
                    jarvisErrorText(result.errorCode, messages.locale),
                  ),
              !result.ok,
            );
          })
          .catch((error: unknown) => {
            setStatus(
              keyStatus,
              text.geminiTestFailed.replace(
                "{reason}",
                jarvisErrorText(errorText(error), messages.locale),
              ),
              true,
            );
          })
          .finally(() => {
            testKey.disabled = false;
          });
      });
      saveThreshold.addEventListener("click", () => {
        const value = Number(thresholdInput.value);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          setStatus(thresholdStatus, text.thresholdInvalid, true);
          return;
        }
        saveThreshold.disabled = true;
        void client
          .updateSettings({ threshold: value })
          .then((result) => {
            thresholdInput.value = String(result.threshold);
            setStatus(thresholdStatus, text.geminiSaved);
          })
          .catch((error: unknown) => {
            setStatus(
              thresholdStatus,
              text.actionFailed.replace(
                "{reason}",
                jarvisErrorText(errorText(error), messages.locale),
              ),
              true,
            );
          })
          .finally(() => {
            saveThreshold.disabled = false;
          });
      });
      refreshMachines.addEventListener("click", () => {
        refreshMachines.disabled = true;
        void loadMachines().finally(() => {
          refreshMachines.disabled = false;
        });
      });

      void context.runLatest(
        async () => {
          await loadSettings();
          await loadMachines();
          return true;
        },
        {
          success: () => undefined,
          failure: (error) => {
            setStatus(
              keyStatus,
              text.actionFailed.replace(
                "{reason}",
                jarvisErrorText(errorText(error), messages.locale),
              ),
              true,
            );
          },
        },
      );
      renderKeyState();

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
  description: string,
): { root: HTMLElement; body: HTMLElement } {
  const root = document.createElement("section");
  root.className = "settings-jarvis-section";
  const label = document.createElement("div");
  label.className = "settings-section-label";
  label.textContent = title;
  const copy = document.createElement("p");
  copy.className = "settings-page-description";
  copy.textContent = description;
  const body = document.createElement("div");
  body.className = "settings-jarvis-body";
  root.append(label, copy, body);
  return { root, body };
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
