import { describe, expect, it } from "vitest";

import { loadProjectMirrorDesktopServices } from "../src/renderer-project-mirror-services.js";

function fakeWindow(urls: string[]): Window {
  return {
    location: new URL("app://-/index.html"),
    document: { querySelectorAll: () => [] },
    __codexhostLoadedModulesV1: {
      complete: true,
      documentUrl: "app://-/index.html",
      urls,
    },
  } as unknown as Window;
}

describe("project mirror Desktop services", () => {
  it("resolves the real nested appServices shape", async () => {
    const calls: string[] = [];
    const services = {
      projects: {
        createRemote: async (input: { label: string }) => {
          calls.push(`createRemote:${input.label}`);
          return {
            id: "remote-project",
            hostId: "remote-ssh-discovered:colab",
            remotePath: "/root/Documents/ChatGPT/demo",
            label: input.label,
          };
        },
      },
      workspaceFiles: {
        createDirectory: async (input: { path: string }) => {
          calls.push(`createDirectory:${input.path}`);
          return undefined;
        },
      },
      executionPaths: {
        readHomeDirectory: async (hostId: string) => {
          calls.push(`readHomeDirectory:${hostId}`);
          return { homeDirectory: "/root" };
        },
      },
    };

    const loaded = await loadProjectMirrorDesktopServices(
      fakeWindow(["app://-/assets/rpc-test.js"]),
      async () => ({ appServices: services }),
    );

    expect(loaded).toBe(services);
    await expect(
      loaded?.executionPaths.readHomeDirectory("remote-ssh-discovered:colab"),
    ).resolves.toEqual({ homeDirectory: "/root" });
    await expect(
      loaded?.workspaceFiles.createDirectory({
        hostId: "remote-ssh-discovered:colab",
        path: "/root/Documents/ChatGPT/demo",
      }),
    ).resolves.toBeUndefined();
    await expect(
      loaded?.projects.createRemote({
        appearance: null,
        hostId: "remote-ssh-discovered:colab",
        label: "demo",
        remotePath: "/root/Documents/ChatGPT/demo",
        reuseExisting: true,
      }),
    ).resolves.toMatchObject({ id: "remote-project" });
    expect(calls).toEqual([
      "readHomeDirectory:remote-ssh-discovered:colab",
      "createDirectory:/root/Documents/ChatGPT/demo",
      "createRemote:demo",
    ]);
  });

  it("rejects a flat mock shape instead of accepting it", async () => {
    const flat = {
      createRemote: async () => null,
      createDirectory: async () => undefined,
      readHomeDirectory: async () => ({ homeDirectory: "/root" }),
    };
    const loaded = await loadProjectMirrorDesktopServices(
      fakeWindow(["app://-/assets/rpc-test.js"]),
      async () => ({ appServices: flat }),
    );
    expect(loaded).toBeNull();
  });
});
