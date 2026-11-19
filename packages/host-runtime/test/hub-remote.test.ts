import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubForward, settingsFromEnvironment } from "../src/hub-remote.js";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  });
}
function child(): FakeChild {
  return new FakeChild();
}
function forward(
  options: {
    probe?: () => Promise<boolean>;
    execFile?: (
      file: string,
      args: readonly string[],
    ) => Promise<{ stdout: string; stderr: string }>;
  } = {},
) {
  const spawned: { args: readonly string[]; child: FakeChild }[] = [];
  const instance = new HubForward({
    settings: { sshAlias: "india", memhubPort: 8765, mcphubPort: 3000, tokenPath: "/token" },
    spawn: (_command, args) => {
      const value = child();
      spawned.push({ args, child: value });
      return value as unknown as ChildProcess;
    },
    probe: options.probe ?? (async () => true),
    delay: async () => undefined,
    execFile: options.execFile,
    readinessTimeoutMs: 100,
  });
  return { instance, spawned };
}
afterEach(() => vi.useRealTimers());

describe("Hub SSH forward", () => {
  it("opens one forward for both services and reuses it", async () => {
    const { instance, spawned } = forward();
    const first = await instance.endpoints();
    expect(first.memhub).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(first.mcphub).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      args: [
        "-N",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-L",
        expect.stringMatching(/^127\.0\.0\.1:\d+:127\.0\.0\.1:8765$/u),
        "-L",
        expect.stringMatching(/^127\.0\.0\.1:\d+:127\.0\.0\.1:3000$/u),
        "india",
      ],
    });
    expect(instance.state()).toBe("ready");
    expect(await instance.endpoints()).toEqual(first);
    expect(spawned).toHaveLength(1);
    await instance.stop();
    expect(spawned[0]?.child.kill).toHaveBeenCalled();
  });

  it("reconnects with backoff after the session drops", async () => {
    vi.useFakeTimers();
    const { instance, spawned } = forward();
    await instance.endpoints();
    const firstChild = spawned[0]?.child;
    if (!firstChild) throw new Error("forward did not start");
    firstChild.exitCode = 255;
    firstChild.emit("exit", 255, null);
    expect(instance.state()).toBe("retrying");
    await vi.advanceTimersByTimeAsync(999);
    expect(spawned).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawned).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(instance.state()).toBe("ready");
    await instance.stop();
  });

  it("reports a Chinese retry state when the forward cannot open", async () => {
    const { instance } = forward({ probe: async () => false });
    await expect(instance.endpoints()).rejects.toMatchObject({ code: "retrying" });
    expect(instance.state()).toBe("retrying");
    await instance.stop();
  });

  it("reads a secret once and forgets it on demand", async () => {
    const execFile = vi.fn(async () => ({ stdout: "token-value\n", stderr: "" }));
    const { instance } = forward({ execFile });
    expect(await instance.readFile("/token")).toBe("token-value\n");
    expect(await instance.readFile("/token")).toBe("token-value\n");
    expect(execFile).toHaveBeenCalledTimes(1);
    instance.forget("/token");
    await instance.readFile("/token");
    expect(execFile).toHaveBeenCalledTimes(2);
    await instance.stop();
  });
});

describe("Hub remote settings", () => {
  it("uses the documented defaults and accepts overrides", () => {
    expect(settingsFromEnvironment({})).toEqual({
      sshAlias: "india",
      memhubPort: 8765,
      mcphubPort: 3000,
      tokenPath: "/home/ubuntu/.one-memory/runtime-token",
    });
    expect(
      settingsFromEnvironment({
        CODEXHOST_HUB_SSH_ALIAS: "far",
        CODEXHOST_HUB_MEMHUB_PORT: "9000",
        CODEXHOST_HUB_MCPHUB_PORT: "9001",
        CODEXHOST_HUB_TOKEN_PATH: "/run/token",
      }),
    ).toEqual({ sshAlias: "far", memhubPort: 9000, mcphubPort: 9001, tokenPath: "/run/token" });
  });
});
