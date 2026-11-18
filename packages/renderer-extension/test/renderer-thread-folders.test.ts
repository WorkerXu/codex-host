import { describe, expect, it } from "vitest";

import { directoryFolderPaths } from "../src/renderer-thread-folders.js";

describe("working folder browser entries", () => {
  it("lists visible child folders only", () => {
    expect(
      directoryFolderPaths(
        {
          entries: [
            { fileName: ".git", isDirectory: true },
            { fileName: ".memsearch", isDirectory: true },
            { fileName: "src", isDirectory: true },
            { fileName: "README.md", isDirectory: false },
            { fileName: "nested/path", isDirectory: true },
          ],
        },
        "/Users/coderxu/Downloads/my-doc/",
      ),
    ).toEqual(["/Users/coderxu/Downloads/my-doc/src"]);
  });

  it("rejects a directory result without entries", () => {
    expect(() => directoryFolderPaths({}, "/tmp")).toThrow("机器未返回目录列表");
  });
});
