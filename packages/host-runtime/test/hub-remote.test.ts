import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubForward, HubRemote, settingsFromEnvironment } from "../src/hub-remote.js";

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
type Exec = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
function forward(options: { probe?: () => Promise<boolean>; execFile?: Exec } = {}) {
  const spawned: { args: readonly string[]; child: FakeChild }[] = [];
  const execFile = options.execFile ?? (async () => ({ stdout: "", stderr: "" }));
  const settings = { sshAlias: "india", memhubPort: 8765, mcphubPort: 3000, tokenPath: "/token" };
  const instance = new HubForward({
    settings,
    spawn: (_command, args) => {
      const value = new FakeChild();
      spawned.push({ args, child: value });
      return value as unknown as ChildProcess;
    },
    probe: options.probe ?? (async () => true),
    delay: async () => undefined,
    execFile,
    readinessTimeoutMs: 100,
  });
  return { instance, spawned, execFile, settings };
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
        "-o",
        "ControlMaster=auto",
        "-o",
        expect.stringMatching(/^ControlPath=\/.+$/u),
        "-o",
        "ControlPersist=no",
        "-L",
        expect.stringMatching(/^127\.0\.0\.1:\d+:127\.0\.0\.1:8765$/u),
        "-L",
        expect.stringMatching(/^127\.0\.0\.1:\d+:127\.0\.0\.1:3000$/u),
        "india",
      ],
    });
    const option = spawned[0]?.args.find((value) => value.startsWith("ControlPath="));
    if (!option) throw new Error("missing control path");
    const directory = path.dirname(option.slice("ControlPath=".length));
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(instance.state()).toBe("ready");
    expect(await instance.endpoints()).toEqual(first);
    expect(spawned).toHaveLength(1);
    await instance.stop();
    expect(spawned[0]?.child.kill).toHaveBeenCalled();
    await expect(stat(directory)).rejects.toThrow();
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

  it("closes the master connection on stop", async () => {
    const execFile = vi.fn<Exec>(async () => ({ stdout: "", stderr: "" }));
    const { instance } = forward({ execFile });
    await instance.endpoints();
    await instance.stop();
    expect(execFile).toHaveBeenCalledWith("ssh", expect.arrayContaining(["-O", "exit", "india"]));
    expect(execFile.mock.calls.flatMap(([, args]) => args)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^ControlPath=\/.+$/u)]),
    );
  });

  it("reads the token through the master and never re-handshakes", async () => {
    const execFile = vi.fn<Exec>(async () => ({ stdout: "token-value\n", stderr: "" }));
    const { instance, spawned } = forward({ execFile });
    await instance.endpoints();
    expect(await instance.readToken("/token")).toBe("token-value\n");
    expect(await instance.readToken("/token")).toBe("token-value\n");
    await instance.readToken("/tmp/with space/it's");
    expect(execFile.mock.calls.at(-1)?.[1].at(-1)).toBe("cat -- '/tmp/with space/it'\\''s'");
    expect(spawned).toHaveLength(1);
    expect(execFile).toHaveBeenCalledTimes(3);
    for (const [, args] of execFile.mock.calls) {
      expect(args).toEqual(
        expect.arrayContaining([
          "-o",
          "ControlMaster=no",
          expect.stringMatching(/^ControlPath=\/.+$/u),
        ]),
      );
    }
    await instance.stop();
  });

  it("never puts remote output in errors", async () => {
    const execFile = vi.fn<Exec>(async () => {
      throw Object.assign(new Error("remote failed"), { stderr: "secret-in-config" });
    });
    const { instance } = forward({ execFile });
    const error = await instance.readToken("/token").catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "forbidden" });
    expect(String(error)).not.toContain("secret-in-config");
    await instance.stop();
  });

  it("returns only MCPHub's routing fields", async () => {
    const execFile = vi.fn<Exec>(async () => ({
      stdout: JSON.stringify({
        enableBearerAuth: true,
        bearerAuthHeaderName: "X-Mcp-Key",
        leaked: "secret-value",
      }),
      stderr: "",
    }));
    const { instance } = forward({ execFile });
    const routing = await instance.readMcpRouting();
    expect(routing).toEqual({ enableBearerAuth: true, bearerAuthHeaderName: "X-Mcp-Key" });
    expect(JSON.stringify(routing)).not.toContain("secret-value");
    const command = execFile.mock.calls[0]?.[1].at(-1);
    expect(command).toContain("base64.b64decode");
    expect(command).not.toContain("cat /etc/mcphub.env");
    await instance.stop();
  });
});

describe("Hub remote secrets", () => {
  it("reads the token once and forgets it on demand", async () => {
    const execFile = vi.fn<Exec>(async () => ({ stdout: "token-value\n", stderr: "" }));
    const remote = new HubRemote(
      {},
      {
        settings: { sshAlias: "india", memhubPort: 8765, mcphubPort: 3000, tokenPath: "/token" },
        execFile,
        spawn: () => new FakeChild() as unknown as ChildProcess,
        probe: async () => true,
        delay: async () => undefined,
      },
    );
    expect(await remote.token()).toBe("token-value");
    expect(await remote.token()).toBe("token-value");
    expect(execFile).toHaveBeenCalledTimes(1);
    await remote.forgetToken();
    await remote.token();
    expect(execFile).toHaveBeenCalledTimes(2);
    await remote.stop();
  });

  it("keeps only the derived header name", async () => {
    const execFile = vi.fn<Exec>(async () => ({
      stdout: JSON.stringify({
        enableBearerAuth: true,
        bearerAuthHeaderName: "X-Mcp-Key",
        leaked: "secret-value",
      }),
      stderr: "",
    }));
    const remote = new HubRemote(
      {},
      {
        settings: { sshAlias: "india", memhubPort: 8765, mcphubPort: 3000, tokenPath: "/token" },
        execFile,
        spawn: () => new FakeChild() as unknown as ChildProcess,
        probe: async () => true,
        delay: async () => undefined,
      },
    );
    expect(await remote.mcphubHeaderName()).toBe("X-Mcp-Key");
    expect(await remote.mcphubHeaderName()).toBe("X-Mcp-Key");
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await remote.mcphubHeaderName())).not.toContain("secret-value");
    await remote.stop();
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
