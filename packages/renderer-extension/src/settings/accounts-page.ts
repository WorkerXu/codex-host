import type {
  CodexAccountChanged,
  CodexAccountListResult,
  CodexAccountSummary,
  CodexAccountUsageParams,
  CodexAccountUsageResult,
  HarnessPluginDescriptor,
  HarnessPluginListResult,
} from "@codexhost/shared-contracts";

import {
  mountCredentialImports,
  type RendererCredentialImportClient,
} from "./credential-imports.js";
import { codexAccountDisplayName } from "../renderer-codex-account-options.js";
import {
  accountListFocusRestorer,
  accountPlanLabel,
  createAccountsTable,
  renderAccountRows,
  renderHarnessAccountRows,
} from "./accounts-list.js";
import { createHarnessAccounts, type RendererHarnessAccountClient } from "./harness-accounts.js";
import { mountAccountResetCountdowns } from "./accounts-reset-time.js";
import type { AccountUsageDisplay, AccountUsageViewState } from "./accounts-usage.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RemoteConnectionsControl } from "../remote-connections-control.js";
import { createRendererSettingsIcon } from "./icons.js";
import { connectionHostName, type RendererConnectionDiagnostics } from "./connections-page.js";
import { configureHostScroller, createHostScrollButton } from "./connection-host-strip.js";
import type { RendererSettingsMessages } from "./localization.js";
import { shouldApplyCodexAccountSnapshot } from "../renderer-codex-account-state.js";

export interface RendererCodexAccountClient
  extends RendererHarnessAccountClient, RendererCredentialImportClient {
  listHarnessPlugins?(): Promise<HarnessPluginListResult>;
  listCodexAccounts(): Promise<CodexAccountListResult>;
  refreshCodexAccounts?(): Promise<CodexAccountListResult>;
  inspectCodexAccountUsage?(input: CodexAccountUsageParams): Promise<CodexAccountUsageResult>;
  subscribeCodexAccounts?(listener: (result: CodexAccountChanged) => void): () => void;
  /** The aggregate Renderer client; each Host gets an independent routed client. */
  knownHostIds?(): readonly string[];
  clientForHost?(hostId: string): RendererCodexAccountClient | null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

type HostLoadStatus = "loading" | "ready" | "error";

interface AccountsHostState {
  readonly hostId: string;
  client: RendererCodexAccountClient | null;
  subscribedClient: RendererCodexAccountClient | null;
  unsubscribe?: (() => void) | undefined;
  status: HostLoadStatus;
  error: string | null;
  visible: boolean;
  refreshing: boolean;
  loadGeneration: number;
  removed: boolean;
  accounts: readonly CodexAccountSummary[];
  currentAccountId: string | null;
  accountPhase: CodexAccountListResult["phase"];
  accountRevision: number;
  accountInstanceId: string | undefined;
  hasAccountSnapshot: boolean;
  readonly usageByAccountId: Map<string, AccountUsageViewState>;
  readonly expandedResetAccounts: Set<string>;
  readonly plugins: HarnessPluginDescriptor[];
  readonly harness: ReturnType<typeof createHarnessAccounts>;
}

const HOST_PANEL_ID = "codexhost-settings-account-host-panel";

export function createAccountsSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererCodexAccountClient | null,
  getDiagnostics: () => RendererConnectionDiagnostics | null = () => null,
  getRemoteConnections: () => RemoteConnectionsControl | null = () => null,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "accounts",
    label: messages.pageLabels.accounts,
    icon: "accounts",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const header = document.createElement("div");
      header.className = "settings-account-header";
      const copy = document.createElement("div");
      const heading = document.createElement("h1");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.accounts;
      copy.append(heading);
      header.append(copy);

      const status = document.createElement("p");
      status.className = "settings-account-status";
      status.setAttribute("aria-live", "polite");
      const toolbar = document.createElement("div");
      toolbar.className = "settings-account-toolbar";
      const connected = document.createElement("div");
      connected.className = "settings-account-count";
      const connectedLabel = document.createElement("span");
      connectedLabel.textContent = messages.accountConnected;
      const connectedCount = document.createElement("span");
      connected.append(connectedLabel, connectedCount);
      const searchWrapper = document.createElement("label");
      searchWrapper.className = "settings-account-search";
      const search = document.createElement("input");
      search.type = "search";
      search.name = "account-search";
      search.autocomplete = "off";
      search.spellcheck = false;
      search.placeholder = messages.accountSearch;
      search.setAttribute("aria-label", messages.accountSearch);
      searchWrapper.append(createRendererSettingsIcon("search", 16), search);
      const displayControls = document.createElement("div");
      displayControls.className = "settings-account-display-controls";
      const displayButtons = new Map<AccountUsageDisplay, HTMLButtonElement>();
      for (const display of ["used", "remaining"] as const) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent =
          display === "used" ? messages.accountCreditsUsed : messages.accountCreditsRemaining;
        button.addEventListener("click", () => {
          usageDisplay = display;
          render();
        });
        displayButtons.set(display, button);
        displayControls.append(button);
      }
      const refreshUsage = document.createElement("button");
      refreshUsage.type = "button";
      refreshUsage.className = "settings-icon-button";
      refreshUsage.title = messages.accountCreditsRefresh;
      refreshUsage.setAttribute("aria-label", messages.accountCreditsRefresh);
      refreshUsage.append(createRendererSettingsIcon("refresh", 16));
      let hideEmails = false;
      const privacyToggle = document.createElement("button");
      privacyToggle.type = "button";
      privacyToggle.className = "settings-icon-button settings-account-privacy-toggle";
      const updatePrivacyToggle = (): void => {
        // The button names the action it performs next; aria-pressed reports the masked state.
        const label = hideEmails ? messages.accountEmailsShow : messages.accountEmailsHide;
        privacyToggle.title = label;
        privacyToggle.setAttribute("aria-label", label);
        privacyToggle.setAttribute("aria-pressed", String(hideEmails));
        privacyToggle.replaceChildren(
          createRendererSettingsIcon(hideEmails ? "eye-off" : "eye", 16),
        );
      };
      updatePrivacyToggle();
      privacyToggle.addEventListener("click", () => {
        hideEmails = !hideEmails;
        updatePrivacyToggle();
        credentialImports.setHideEmails(hideEmails);
        render();
      });
      refreshUsage.addEventListener("click", () => {
        for (const host of hostStates.values()) {
          host.usageByAccountId.clear();
          void loadHost(host, { refresh: true, backgroundRefresh: false });
        }
        void credentialImports.refresh();
      });
      search.addEventListener("input", () => render());
      toolbar.append(connected, privacyToggle, searchWrapper, displayControls, refreshUsage);

      const hostBar = document.createElement("div");
      hostBar.className = "settings-account-hosts";
      const hostStrip = document.createElement("div");
      hostStrip.className = "settings-connection-host-strip";
      const hostScrollLeft = createHostScrollButton(document, "left", messages);
      const hostTabs = document.createElement("div");
      hostTabs.className = "settings-connection-host-tabs";
      hostTabs.setAttribute("role", "tablist");
      hostTabs.setAttribute("aria-label", messages.connectionHosts);
      const hostScrollRight = createHostScrollButton(document, "right", messages);
      hostStrip.append(hostScrollLeft, hostTabs, hostScrollRight);
      hostBar.append(hostStrip);

      const list = document.createElement("div");
      list.className = "settings-account-list";
      list.id = HOST_PANEL_ID;
      const { table, body, updateDisplay } = createAccountsTable(document, messages);
      list.append(table);
      const hostStates = new Map<string, AccountsHostState>();
      let selectedHostId = "local";
      function selectedHost(): AccountsHostState | undefined {
        const state = hostStates.get(selectedHostId);
        if (state && (state.hostId === "local" || state.visible)) return state;
        return hostStates.get("local");
      }
      const credentialImports = mountCredentialImports(
        context.content,
        context.signal,
        getClient,
        messages.credentialImports,
        () => render(),
        (id) => selectedHost()?.plugins.find((plugin) => plugin.id === id),
      );
      context.content.append(header, status, toolbar, hostBar, list, credentialImports.section);
      const stopCountdowns = mountAccountResetCountdowns(list, messages, context.signal);

      let usageDisplay: AccountUsageDisplay = "remaining";
      let hostNames = new Map<string, string>();
      let disposeHostScroller = (): void => undefined;
      let tabButtons: HTMLButtonElement[] = [];
      let syncingHosts = false;

      const hostClient = (hostId: string): RendererCodexAccountClient | null => {
        const client = getClient();
        if (!client) return null;
        if (client.clientForHost) return client.clientForHost(hostId);
        return hostId === "local" ? client : null;
      };
      const hostFailed = (state: AccountsHostState): boolean =>
        state.status === "error" ||
        (state.accounts.length === 0 && state.harness.status === "error");
      const hostVisible = (state: AccountsHostState): boolean => {
        if (state.hostId === "local") return true;
        if (state.accounts.length + state.harness.accounts.length > 0) return true;
        // A failed query is not an empty Host: keep its tab so it can be retried.
        return hostFailed(state);
      };

      const applyAccountSnapshot = (
        state: AccountsHostState,
        result: CodexAccountListResult,
      ): boolean => {
        if (
          !shouldApplyCodexAccountSnapshot(
            state.hasAccountSnapshot
              ? { instanceId: state.accountInstanceId, revision: state.accountRevision }
              : null,
            result,
          )
        ) {
          return false;
        }
        state.hasAccountSnapshot = true;
        state.accounts = result.accounts;
        state.currentAccountId = result.currentAccountId;
        state.accountPhase = result.phase;
        state.accountRevision = result.revision;
        state.accountInstanceId = result.instanceId;
        for (const accountId of state.expandedResetAccounts) {
          if (!state.accounts.some((account) => account.accountId === accountId))
            state.expandedResetAccounts.delete(accountId);
        }
        return true;
      };

      const loadUsage = (state: AccountsHostState): void => {
        const inspect = state.client?.inspectCodexAccountUsage;
        const saved = [...state.accounts];
        const keep = new Set(saved.map((account) => account.accountId));
        for (const accountId of [...state.usageByAccountId.keys()]) {
          if (!keep.has(accountId)) state.usageByAccountId.delete(accountId);
        }
        const pending = saved.filter((account) => !state.usageByAccountId.has(account.accountId));
        if (!inspect || pending.length === 0) {
          render();
          return;
        }
        const requests = pending.map((account) => {
          const loading: AccountUsageViewState = { status: "loading" };
          state.usageByAccountId.set(account.accountId, loading);
          return { account, loading };
        });
        render();
        void Promise.all(
          requests.map(async ({ account, loading }) => {
            try {
              const result = await inspect({ accountId: account.accountId });
              if (
                context.signal.aborted ||
                state.removed ||
                state.usageByAccountId.get(account.accountId) !== loading
              )
                return;
              state.usageByAccountId.set(
                account.accountId,
                result.accountCredits
                  ? {
                      status: "ready",
                      credits: result.accountCredits,
                      freshness: result.freshness,
                      observedAt: result.observedAt,
                    }
                  : { status: "empty" },
              );
            } catch {
              if (
                context.signal.aborted ||
                state.removed ||
                state.usageByAccountId.get(account.accountId) !== loading
              )
                return;
              state.usageByAccountId.set(account.accountId, { status: "error" });
            }
            render();
          }),
        );
      };

      const loadPlugins = async (state: AccountsHostState, client: RendererCodexAccountClient) => {
        if (!client.listHarnessPlugins) return;
        try {
          const { plugins } = await client.listHarnessPlugins();
          if (state.client !== client || state.removed || context.signal.aborted) return;
          state.plugins.splice(0, state.plugins.length, ...plugins);
          render();
        } catch {
          // Logos fall back to the Harness name; a missing directory is not an account failure.
        }
      };

      const subscribeAccounts = (
        state: AccountsHostState,
        client: RendererCodexAccountClient,
      ): void => {
        if (state.subscribedClient === client) return;
        state.unsubscribe?.();
        state.unsubscribe = undefined;
        state.subscribedClient = client;
        if (!client.subscribeCodexAccounts) return;
        try {
          state.unsubscribe = client.subscribeCodexAccounts((result) => {
            if (state.removed || state.client !== client) return;
            if (!applyAccountSnapshot(state, result)) return;
            state.status = "ready";
            state.error = null;
            state.visible = hostVisible(state);
            if (!state.visible && selectedHostId === state.hostId) selectedHostId = "local";
            render();
            loadUsage(state);
          });
        } catch {
          // The page remains usable through list and refresh.
        }
      };

      const refreshAccountsInBackground = async (
        state: AccountsHostState,
        client: RendererCodexAccountClient,
        generation: number,
      ): Promise<void> => {
        if (!client.refreshCodexAccounts) return;
        try {
          const result = await client.refreshCodexAccounts();
          if (
            context.signal.aborted ||
            state.removed ||
            state.loadGeneration !== generation ||
            state.client !== client
          )
            return;
          if (!applyAccountSnapshot(state, result)) return;
          state.status = "ready";
          state.error = null;
          state.visible = hostVisible(state);
          if (!state.visible && selectedHostId === state.hostId) selectedHostId = "local";
          render();
          loadUsage(state);
        } catch {
          // Keep showing the cached Account list when live metadata refresh fails.
        }
      };

      const loadHost = async (
        state: AccountsHostState,
        options: { refresh?: boolean; backgroundRefresh?: boolean } = {},
      ): Promise<void> => {
        if (state.removed || context.signal.aborted || state.refreshing) return;
        const client = hostClient(state.hostId);
        state.client = client;
        state.refreshing = true;
        const generation = ++state.loadGeneration;
        const current = (): boolean =>
          !state.removed &&
          !context.signal.aborted &&
          state.loadGeneration === generation &&
          state.client === client;
        render();
        if (!client) {
          state.refreshing = false;
          state.status = "error";
          state.error =
            state.hostId === "local"
              ? messages.runtimeCapabilityNotInstalled
              : messages.accountLoadFailed;
          state.visible = hostVisible(state);
          if (!state.visible && selectedHostId === state.hostId) selectedHostId = "local";
          render();
          return;
        }
        subscribeAccounts(state, client);
        let accountsFailed = false;
        const accountsRequest = (async () => {
          try {
            const result = await client.listCodexAccounts();
            if (!current()) return;
            if (applyAccountSnapshot(state, result)) {
              state.status = "ready";
              state.error = null;
            }
          } catch (error) {
            if (!current()) return;
            accountsFailed = true;
            state.status = "error";
            state.error = errorMessage(error, messages.accountLoadFailed);
          }
          if (!current()) return;
          // Codex rows and failures settle independently of slower Harness checks.
          state.visible = hostVisible(state);
          if (!state.visible && selectedHostId === state.hostId) selectedHostId = "local";
          render();
          if (!accountsFailed) loadUsage(state);
        })();
        const pluginsRequest = loadPlugins(state, client);
        const harnessRequest = state.harness.refresh(options.refresh ?? false);
        await Promise.all([accountsRequest, pluginsRequest, harnessRequest]);
        if (!current()) return;
        state.refreshing = false;
        if (!accountsFailed) {
          state.status = "ready";
          state.error = null;
        }
        state.visible = hostVisible(state);
        if (!state.visible && selectedHostId === state.hostId) selectedHostId = "local";
        render();
        if (!accountsFailed) {
          loadUsage(state);
          if (options.backgroundRefresh !== false)
            void refreshAccountsInBackground(state, client, generation);
        }
      };

      const createHostState = (hostId: string): AccountsHostState => {
        const state: AccountsHostState = {
          hostId,
          client: null,
          subscribedClient: null,
          status: "loading",
          error: null,
          visible: hostId === "local",
          refreshing: false,
          loadGeneration: 0,
          removed: false,
          accounts: [],
          currentAccountId: null,
          accountPhase: "unavailable",
          accountRevision: 0,
          accountInstanceId: undefined,
          hasAccountSnapshot: false,
          usageByAccountId: new Map(),
          expandedResetAccounts: new Set(),
          plugins: [],
          harness: createHarnessAccounts(
            context.signal,
            () => state.client,
            () => {
              if (!state.removed && !context.signal.aborted) render();
            },
          ),
        };
        return state;
      };

      const syncHosts = (): void => {
        if (syncingHosts || context.signal.aborted) return;
        syncingHosts = true;
        try {
          const diagnostics = getDiagnostics();
          const hostIds = new Set<string>(["local"]);
          if (diagnostics) {
            for (const host of diagnostics.snapshot().hosts) {
              if (host.hostId !== "durable") hostIds.add(host.hostId);
            }
          } else {
            for (const hostId of getClient()?.knownHostIds?.() ?? []) {
              if (hostId !== "durable") hostIds.add(hostId);
            }
          }
          for (const [hostId, state] of [...hostStates]) {
            if (hostIds.has(hostId)) continue;
            state.removed = true;
            state.loadGeneration += 1;
            state.unsubscribe?.();
            hostStates.delete(hostId);
            if (selectedHostId === hostId) selectedHostId = "local";
          }
          for (const hostId of hostIds) {
            if (hostStates.has(hostId)) continue;
            const state = createHostState(hostId);
            hostStates.set(hostId, state);
            void loadHost(state);
          }
        } finally {
          syncingHosts = false;
        }
      };

      const hostLabel = (state: AccountsHostState): string =>
        hostNames.get(state.hostId) || connectionHostName(state.hostId, messages);

      const render = (): void => {
        if (context.signal.aborted) return;
        let state = hostStates.get(selectedHostId);
        if (!state || (state.hostId !== "local" && !state.visible)) {
          selectedHostId = "local";
          state = hostStates.get("local");
        }
        if (!state) return;
        const restoreFocus = accountListFocusRestorer(list, search);
        disposeHostScroller();
        disposeHostScroller = () => undefined;
        body.replaceChildren();
        status.replaceChildren();
        updateDisplay(usageDisplay);
        for (const [display, button] of displayButtons) {
          button.setAttribute("aria-pressed", String(display === usageDisplay));
        }
        connectedCount.textContent = String(state.accounts.length + state.harness.accounts.length);
        const anyRefreshing = [...hostStates.values()].some((host) => host.refreshing);
        const usageLoading = state.accounts.some(
          (account) => state.usageByAccountId.get(account.accountId)?.status === "loading",
        );
        const canInspect = Boolean(
          getClient()?.inspectCodexAccountUsage ||
          getClient()?.listHarnessAccountSources ||
          getClient()?.listHarnessAccounts,
        );
        refreshUsage.disabled = !canInspect || anyRefreshing || usageLoading;
        if (hostFailed(state)) {
          const message = document.createElement("span");
          message.textContent =
            state.status === "error"
              ? (state.error ?? messages.accountLoadFailed)
              : messages.accountLoadFailed;
          status.append(message);
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className =
            "settings-command-button settings-command-button--secondary settings-account-status-retry";
          retry.textContent = messages.accountCreditsRetry;
          retry.addEventListener("click", () => void loadHost(state, { refresh: true }));
          status.append(retry);
        }

        const visibleHosts = [...hostStates.values()].filter(
          (host) => host.hostId === "local" || host.visible,
        );
        const active = document.activeElement as HTMLElement | null;
        const focusedHostId = active?.dataset?.accountHostTab ?? null;
        hostBar.hidden = visibleHosts.length <= 1;
        hostTabs.replaceChildren();
        tabButtons = [];
        if (!hostBar.hidden) {
          visibleHosts.forEach((host, index) => {
            const tab = document.createElement("button");
            tab.type = "button";
            tab.className = "settings-connection-host-tab";
            tab.dataset.accountHostTab = host.hostId;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-controls", HOST_PANEL_ID);
            tab.setAttribute("aria-selected", String(host.hostId === state.hostId));
            tab.tabIndex = host.hostId === state.hostId ? 0 : -1;
            const label = hostLabel(host);
            tab.textContent = label;
            if (hostFailed(host)) {
              tab.dataset.accountHostError = "true";
              tab.title = `${label} · ${messages.accountLoadFailed}`;
              const mark = document.createElement("span");
              mark.className = "settings-account-host-tab-error";
              mark.textContent = "!";
              mark.setAttribute("aria-hidden", "true");
              tab.append(mark);
            } else {
              tab.title = label;
            }
            tab.addEventListener("click", () => {
              if (selectedHostId === host.hostId) return;
              selectedHostId = host.hostId;
              render();
              tabButtons.find((button) => button.dataset.accountHostTab === host.hostId)?.focus();
            });
            tab.addEventListener("keydown", (event) => {
              const key = (event as KeyboardEvent).key;
              if (key !== "ArrowLeft" && key !== "ArrowRight") return;
              event.preventDefault();
              const direction = key === "ArrowRight" ? 1 : -1;
              const next =
                visibleHosts[(index + direction + visibleHosts.length) % visibleHosts.length];
              if (!next) return;
              selectedHostId = next.hostId;
              render();
              tabButtons.find((button) => button.dataset.accountHostTab === next.hostId)?.focus();
            });
            tabButtons.push(tab);
            hostTabs.append(tab);
          });
          disposeHostScroller = configureHostScroller(
            document,
            hostStrip,
            hostTabs,
            hostScrollLeft,
            hostScrollRight,
          );
          const selectedTab = tabButtons.find((tab) => tab.dataset.accountHostTab === state.hostId);
          if (selectedTab) {
            const left = selectedTab.offsetLeft;
            const right = left + selectedTab.offsetWidth;
            if (left < hostTabs.scrollLeft) hostTabs.scrollLeft = left;
            else if (right > hostTabs.scrollLeft + hostTabs.clientWidth) {
              hostTabs.scrollLeft = right - hostTabs.clientWidth;
            }
          }
        }
        if (focusedHostId) {
          tabButtons
            .find((tab) => tab.dataset.accountHostTab === focusedHostId)
            ?.focus({ preventScroll: true });
        }

        const query = search.value.trim().toLocaleLowerCase();
        const visibleAccounts = state.accounts.filter((account) =>
          `Codex ${account.email ?? ""} ${account.label} ${accountPlanLabel(account.planType) ?? ""}`
            .toLocaleLowerCase()
            .includes(query),
        );
        const visibleHarnessAccounts = state.harness.accounts.filter((account) =>
          `${account.harnessName} ${account.email ?? ""} ${account.label ?? ""} ${account.plan ?? ""}`
            .toLocaleLowerCase()
            .includes(query),
        );
        if (visibleAccounts.length + visibleHarnessAccounts.length === 0) {
          const emptyRow = document.createElement("tr");
          const emptyCell = document.createElement("td");
          emptyCell.colSpan = 3;
          emptyCell.className = "settings-account-empty";
          emptyCell.textContent = query ? messages.accountNoMatches : messages.accountEmpty;
          emptyRow.append(emptyCell);
          body.append(emptyRow);
        }
        const localHost = state.hostId === "local";
        const pluginFor = (id: string) => state.plugins.find((plugin) => plugin.id === id);
        for (const account of visibleAccounts) {
          body.append(
            ...renderAccountRows(document, account, messages, {
              current:
                state.accountPhase === "ready" && account.accountId === state.currentAccountId,
              usage: state.usageByAccountId.get(account.accountId),
              display: usageDisplay,
              resetExpanded: state.expandedResetAccounts.has(account.accountId),
              onRetry: () => {
                state.usageByAccountId.delete(account.accountId);
                loadUsage(state);
              },
              onResetExpanded: (open) => {
                if (open) state.expandedResetAccounts.add(account.accountId);
                else state.expandedResetAccounts.delete(account.accountId);
              },
              importAction: localHost
                ? credentialImports.button("codex", codexAccountDisplayName(account).full)
                : null,
              hideEmails,
            }),
          );
        }
        for (const account of visibleHarnessAccounts) {
          body.append(
            ...renderHarnessAccountRows(
              document,
              account,
              messages,
              usageDisplay,
              localHost
                ? credentialImports.button(
                    account.harnessId,
                    account.email ?? account.label ?? account.harnessName,
                  )
                : null,
              hideEmails,
              pluginFor(account.harnessId),
            ),
          );
        }
        credentialImports.section.hidden = !localHost;
        restoreFocus();
      };

      const diagnostics = getDiagnostics();
      const unsubscribeDiagnostics = diagnostics?.subscribe(() => {
        syncHosts();
        render();
      });
      syncHosts();
      render();
      void credentialImports.refresh();
      const connections = getRemoteConnections();
      void connections?.ssh.list(context.signal).then(
        (list) => {
          if (context.signal.aborted) return;
          hostNames = new Map(
            list.map((connection) => [connection.hostId, connection.displayName.trim()]),
          );
          diagnostics?.reconcileConnections?.(list);
          render();
        },
        () => {
          // Keep the Host ID fallback when native connection names are unavailable.
        },
      );
      return () => {
        stopCountdowns();
        disposeHostScroller();
        unsubscribeDiagnostics?.();
        for (const host of hostStates.values()) {
          host.removed = true;
          host.loadGeneration += 1;
          host.unsubscribe?.();
        }
        hostStates.clear();
      };
    },
  });
}
