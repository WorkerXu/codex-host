import { describe, expect, it } from "vitest";
import {
  SIDEBAR_SECTION_DISPLAY_STORAGE_KEY,
  mergeSidebarThreads,
  readSectionDisplayMode,
  writeSectionDisplayMode,
} from "../src/renderer-sidebar-sections-model.js";

describe("merged section ordering", () => {
  it("interleaves projects by recency and keeps each project's own order", () => {
    expect(
      mergeSidebarThreads([
        [
          { threadId: "a1", pinned: false, recency: 300 },
          { threadId: "a2", pinned: false, recency: 100 },
          { threadId: "a3", pinned: false, recency: 50 },
        ],
        [
          { threadId: "b1", pinned: false, recency: 250 },
          { threadId: "b2", pinned: false, recency: 200 },
        ],
      ]),
    ).toEqual(["a1", "b1", "b2", "a2", "a3"]);
  });

  it("never reorders rows inside a project even when recency disagrees", () => {
    expect(
      mergeSidebarThreads([
        [
          { threadId: "a1", pinned: false, recency: 100 },
          { threadId: "a2", pinned: false, recency: 300 },
        ],
        [{ threadId: "b1", pinned: false, recency: 200 }],
      ]),
    ).toEqual(["b1", "a1", "a2"]);
  });

  it("keeps pinned heads above newer unpinned rows", () => {
    expect(
      mergeSidebarThreads([
        [
          { threadId: "pinned", pinned: true, recency: 10 },
          { threadId: "old", pinned: false, recency: 5 },
        ],
        [{ threadId: "new", pinned: false, recency: 999 }],
      ]),
    ).toEqual(["pinned", "new", "old"]);
  });

  it("sinks rows without catalog recency below known rows in native order", () => {
    expect(
      mergeSidebarThreads([
        [
          { threadId: "unknown-a", pinned: false, recency: null },
          { threadId: "unknown-b", pinned: false, recency: null },
        ],
        [{ threadId: "known", pinned: false, recency: 500 }],
      ]),
    ).toEqual(["known", "unknown-a", "unknown-b"]);
  });

  it("keeps native project blocks when no catalog recency exists at all", () => {
    expect(
      mergeSidebarThreads([
        [
          { threadId: "a1", pinned: false, recency: null },
          { threadId: "a2", pinned: false, recency: null },
        ],
        [{ threadId: "b1", pinned: false, recency: null }],
      ]),
    ).toEqual(["a1", "a2", "b1"]);
  });

  it("handles empty projects and a single project unchanged", () => {
    expect(mergeSidebarThreads([])).toEqual([]);
    expect(mergeSidebarThreads([[]])).toEqual([]);
    expect(mergeSidebarThreads([[{ threadId: "a", pinned: false, recency: 1 }]])).toEqual(["a"]);
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("section display preference", () => {
  it("defaults to the merged list and persists one mode per section", () => {
    const storage = memoryStorage();
    expect(readSectionDisplayMode("section-1", storage)).toBe("merged");
    expect(writeSectionDisplayMode("section-1", "grouped", storage)).toBe(true);
    expect(readSectionDisplayMode("section-1", storage)).toBe("grouped");
    expect(readSectionDisplayMode("section-2", storage)).toBe("merged");
    expect(JSON.parse(storage.values.get(SIDEBAR_SECTION_DISPLAY_STORAGE_KEY) ?? "{}")).toEqual({
      "section-1": "grouped",
    });
  });

  it("ignores unavailable or malformed storage and never throws", () => {
    const malformed = memoryStorage({ [SIDEBAR_SECTION_DISPLAY_STORAGE_KEY]: "not json" });
    expect(readSectionDisplayMode("section-1", malformed)).toBe("merged");
    const wrongShape = memoryStorage({
      [SIDEBAR_SECTION_DISPLAY_STORAGE_KEY]: JSON.stringify({ "section-1": "sideways" }),
    });
    expect(readSectionDisplayMode("section-1", wrongShape)).toBe("merged");
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(readSectionDisplayMode("section-1", broken)).toBe("merged");
    expect(writeSectionDisplayMode("section-1", "merged", broken)).toBe(false);
  });

  it("caps stored sections without losing the newest choice", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 210; index += 1) {
      writeSectionDisplayMode(`section-${index}`, index % 2 === 0 ? "merged" : "grouped", storage);
    }
    const parsed: unknown = JSON.parse(
      storage.values.get(SIDEBAR_SECTION_DISPLAY_STORAGE_KEY) ?? "{}",
    );
    const stored = parsed as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(200);
    expect(stored["section-9"]).toBeUndefined();
    expect(readSectionDisplayMode("section-11", storage)).toBe("grouped");
    expect(readSectionDisplayMode("section-209", storage)).toBe("grouped");
  });
});
