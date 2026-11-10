import { describe, expect, it, vi } from "vitest";

import {
  isSshHostId,
  releaseRetiredSshConnectionHosts,
  retiredSshConnectionHosts,
} from "../src/renderer-connection-catalog.js";

describe("SSH connection catalog reconciliation", () => {
  it("reports only observed SSH Hosts that no longer exist", () => {
    expect(
      retiredSshConnectionHosts(
        [
          "local",
          "remote-ssh-codex-managed:live",
          "remote-ssh-codex-managed:jdcloud",
          "remote-control:device",
        ],
        ["remote-ssh-codex-managed:live"],
      ),
    ).toEqual(["remote-ssh-codex-managed:jdcloud"]);
    expect(isSshHostId("remote-ssh-discovered:mac")).toBe(true);
    expect(isSshHostId("remote-control:device")).toBe(false);
  });

  it("releases stale per-Host state and keeps live, local, and non-SSH Hosts", () => {
    const release = vi.fn();
    const released = releaseRetiredSshConnectionHosts(
      [
        "local",
        "remote-ssh-codex-managed:live",
        "remote-ssh-codex-managed:jdcloud",
        "remote-control:device",
      ],
      ["remote-ssh-codex-managed:live"],
      release,
    );
    expect(released).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("remote-ssh-codex-managed:jdcloud");
  });

  it("treats an empty connection catalog as removing every SSH Host", () => {
    expect(
      retiredSshConnectionHosts(
        ["remote-ssh-codex-managed:one", "remote-ssh-codex-managed:two"],
        [],
      ),
    ).toEqual(["remote-ssh-codex-managed:one", "remote-ssh-codex-managed:two"]);
  });

  it("reports no removals when the read fails or the catalog is unchanged", () => {
    const release = vi.fn();
    expect(
      releaseRetiredSshConnectionHosts(
        ["local", "remote-ssh-codex-managed:live"],
        ["remote-ssh-codex-managed:live"],
        release,
      ),
    ).toBe(false);
    expect(release).not.toHaveBeenCalled();
  });
});
