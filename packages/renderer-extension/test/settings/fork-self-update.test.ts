// @vitest-environment jsdom
import { FORK_SELF_UPDATE_ENABLED } from "@codexhost/shared-contracts/fork-self-update";
import { assert, expect, it, vi } from "vitest";
import type { RuntimeStatus } from "@codexhost/shared-contracts";
import { ConsoleState } from "../../src/console/state.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";
import { createDefaultRendererSettingsPages } from "../../src/settings/pages.js";
import {
  renderRemoteCard,
  type RemoteConnectionRow,
} from "../../src/settings/remote-connections-card.js";

it.skipIf(FORK_SELF_UPDATE_ENABLED)(
  "mounts the release announcement without rendering or requesting installation controls",
  async () => {
    const client = {
      checkUpdate: vi.fn(),
      startUpdate: vi.fn(),
      readUpdateStatus: vi.fn(),
      getReleaseAnnouncement: vi.fn(async () => ({
        announcement: {
          version: "0.25.1",
          publishedAt: "2026-11-23T00:00:00Z",
          url: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.25.1",
          zh: null,
          en: { themes: [{ title: "Release", body: "Announcement text", contributors: [] }] },
        },
        unread: false,
      })),
    };
    const page = createDefaultRendererSettingsPages(
      rendererSettingsMessages("en"),
      () => client,
    ).find(({ id }) => id === "updates");
    assert(page);
    const content = document.createElement("main");
    const scope = new RendererSettingsPageScope();
    const cleanup = page.mount({
      content,
      signal: scope.signal,
      runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    });
    try {
      await vi.waitFor(() => expect(content.querySelector("button")?.hidden).toBe(false));
      expect(page.label).toBe("Release announcement");
      expect([...content.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
        "View release announcement",
      ]);
      expect(
        content.querySelector("a, .settings-update-panel, .settings-update-controls"),
      ).toBeNull();
      expect(client.getReleaseAnnouncement).toHaveBeenCalledWith({ manual: true });
      expect(client.checkUpdate).not.toHaveBeenCalled();
      expect(client.startUpdate).not.toHaveBeenCalled();
      expect(client.readUpdateStatus).not.toHaveBeenCalled();
    } finally {
      scope.dispose();
      cleanup?.();
    }
  },
);

it.skipIf(FORK_SELF_UPDATE_ENABLED)(
  "gives no install or update action for a new, outdated, or older SSH connection",
  () => {
    const remote: RuntimeStatus = {
      runningVersion: "0.22.0",
      installedVersion: "0.22.0",
      remote: true,
      restartRequired: true,
      updateSupported: true,
      update: { phase: "failed", targetVersion: "0.25.1", error: "Update failed" },
    };
    const local = { ...remote, runningVersion: "0.25.1" };
    const row: RemoteConnectionRow = {
      connection: {
        hostId: "ssh-host",
        displayName: "SSH host",
        source: "codex-managed",
        sshHost: "example.invalid",
        sshPort: 22,
        sshAlias: null,
        identity: null,
        autoConnect: true,
      },
      state: "connected",
      stateError: null,
      remote,
      remoteIssue: null,
      installation: "installed",
      pending: null,
      notice: null,
      probing: false,
    };
    for (const candidate of [
      row,
      { ...row, remote: null, remoteIssue: { outdated: true, message: "Method unavailable" } },
      { ...row, remote: null, installation: "not-installed" as const },
    ]) {
      const card = renderRemoteCard(document, candidate, local, (_zh, en) => en, vi.fn());
      expect(
        card.querySelector(
          '[data-action="update"], [data-action="upgrade"], [data-action="install"]',
        ),
      ).toBeNull();
      expect(card.textContent).not.toMatch(/update available|update failed|needs an update/iu);
    }
  },
);

it.skipIf(FORK_SELF_UPDATE_ENABLED)(
  "leaves the console background update state empty without a request",
  async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const state = new ConsoleState();
      await state.checkUpdate();
      expect(state.update).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
