import { describe, expect, it } from "vitest";
import {
  MCP_SERVER_PAGE_SIZE,
  clampPage,
  pageCount,
  pageSlice,
  readMcpAdminTab,
  writeMcpAdminTab,
} from "../../src/settings/mcp-page-tabs.js";

const memoryStorage = (initial: Record<string, string> = {}): Storage => {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
};

describe("MCP page pagination", () => {
  it("fits exactly twelve servers on one page and splits thirteen", () => {
    expect(pageCount(0, MCP_SERVER_PAGE_SIZE)).toBe(1);
    expect(pageCount(12, MCP_SERVER_PAGE_SIZE)).toBe(1);
    expect(pageCount(13, MCP_SERVER_PAGE_SIZE)).toBe(2);
    expect(pageCount(24, MCP_SERVER_PAGE_SIZE)).toBe(2);
    expect(pageCount(25, MCP_SERVER_PAGE_SIZE)).toBe(3);
  });
  it("clamps a page after the list shrinks", () => {
    expect(clampPage(0, 13, MCP_SERVER_PAGE_SIZE)).toBe(1);
    expect(clampPage(2, 13, MCP_SERVER_PAGE_SIZE)).toBe(2);
    expect(clampPage(3, 13, MCP_SERVER_PAGE_SIZE)).toBe(2);
    expect(clampPage(4, 12, MCP_SERVER_PAGE_SIZE)).toBe(1);
  });
  it("slices the visible page and clamps out-of-range input", () => {
    const items = Array.from({ length: 13 }, (_, index) => index);
    expect(pageSlice(items, 1, MCP_SERVER_PAGE_SIZE)).toHaveLength(12);
    expect(pageSlice(items, 2, MCP_SERVER_PAGE_SIZE)).toEqual([12]);
    expect(pageSlice(items, 9, MCP_SERVER_PAGE_SIZE)).toEqual([12]);
  });
});

describe("MCP page tab memory", () => {
  it("remembers the last tab for the session", () => {
    const storage = memoryStorage();
    expect(readMcpAdminTab(storage)).toBe("servers");
    writeMcpAdminTab(storage, "keys");
    expect(readMcpAdminTab(storage)).toBe("keys");
  });
  it("falls back to 服务器 when session storage is blocked", () => {
    const storage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(readMcpAdminTab(storage)).toBe("servers");
    expect(() => writeMcpAdminTab(storage, "keys")).not.toThrow();
    expect(readMcpAdminTab(null)).toBe("servers");
  });
});
