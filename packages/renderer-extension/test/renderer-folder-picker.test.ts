import { describe, expect, it, vi } from "vitest";
import { pickDesktopFolders } from "../src/renderer-folder-picker.js";

const ownerWindow = () =>
  ({
    location: new URL("app://-/index.html"),
    document: { querySelectorAll: () => [] },
    __codexhostLoadedModulesV1: {
      complete: true,
      documentUrl: "app://-/index.html",
      urls: ["app://-/assets/rpc-picker.js"],
    },
  }) as unknown as Window;

describe("Desktop native folder picker", () => {
  it("requests directory-only multi-selection and returns deduplicated filesystem paths", async () => {
    const fileAttachments = {
      pickFiles: vi.fn(async function (this: unknown) {
        expect(this).toBe(fileAttachments);
        return [
          { fsPath: "/Users/lin/One", path: "/Users/lin/One/" },
          { fsPath: "/Users/lin/Two", path: "/Users/lin/Two/" },
          { fsPath: "/Users/lin/One" },
        ];
      }),
    };
    await expect(
      pickDesktopFolders(ownerWindow(), async () => ({ appServices: { fileAttachments } })),
    ).resolves.toEqual(["/Users/lin/One", "/Users/lin/Two"]);
    expect(fileAttachments.pickFiles).toHaveBeenCalledExactlyOnceWith({
      kind: "directory",
      allowMultiple: true,
      pickerTitle: "选择工作文件夹",
    });
  });

  it("accepts a callable RPC service object for file attachments", async () => {
    const fileAttachments = Object.assign(() => undefined, {
      pickFiles: vi.fn(async () => [{ fsPath: "/Users/lin/One" }]),
    });
    await expect(
      pickDesktopFolders(ownerWindow(), async () => ({ appServices: { fileAttachments } })),
    ).resolves.toEqual(["/Users/lin/One"]);
  });

  it("keeps cancellation distinct from unavailable services", async () => {
    await expect(
      pickDesktopFolders(ownerWindow(), async () => ({
        appServices: { fileAttachments: { pickFiles: async () => [] } },
      })),
    ).resolves.toEqual([]);
    await expect(pickDesktopFolders(ownerWindow(), async () => ({}))).resolves.toBeNull();
  });

  it("falls back when discovery or the native dialog fails", async () => {
    await expect(
      pickDesktopFolders(ownerWindow(), async () => {
        throw new Error("Module unavailable");
      }),
    ).resolves.toBeNull();
    await expect(
      pickDesktopFolders(ownerWindow(), async () => ({
        appServices: {
          fileAttachments: {
            pickFiles: async () => {
              throw new Error("IPC disconnected");
            },
          },
        },
      })),
    ).resolves.toBeNull();
  });

  it.each([null, {}, [{ path: "/not-a-filesystem-path" }], [{ fsPath: "relative" }]])(
    "rejects malformed native results: %j",
    async (result) => {
      await expect(
        pickDesktopFolders(ownerWindow(), async () => ({
          appServices: { fileAttachments: { pickFiles: async () => result } },
        })),
      ).resolves.toBeNull();
    },
  );
});
