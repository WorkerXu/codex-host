import { describe, expect, it } from "vitest";

import {
  clearJarvisProjectCache,
  isJarvisProjectCacheFresh,
  readJarvisLastProject,
  readJarvisProjectCache,
  writeJarvisLastProject,
  writeJarvisProjectCache,
} from "../src/renderer-jarvis-project-store.js";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const NOW = Date.parse("2026-11-19T10:00:00+08:00");
const PROJECTS = [
  { id: 9001, name: "示例后台 · 迭代 B" },
  { id: 9002, name: "示例商城 · 迭代 A" },
];

describe("Jarvis project memory", () => {
  it("round-trips the project list for one Host", () => {
    const storage = new MemoryStorage();
    writeJarvisProjectCache(storage, "local", 10058, PROJECTS, NOW);
    expect(readJarvisProjectCache(storage, "local")).toEqual({
      userId: 10058,
      savedAt: NOW,
      projects: PROJECTS,
    });
    expect(readJarvisProjectCache(storage, "remote-1")).toBeNull();
  });

  it("treats only a short window as fresh", () => {
    const record = { userId: 10058, savedAt: NOW, projects: PROJECTS };
    expect(isJarvisProjectCacheFresh(record, NOW)).toBe(true);
    expect(isJarvisProjectCacheFresh(record, NOW + 9 * 60_000)).toBe(true);
    expect(isJarvisProjectCacheFresh(record, NOW + 10 * 60_000)).toBe(false);
    expect(isJarvisProjectCacheFresh(record, NOW - 1)).toBe(false);
  });

  it("keeps the last project per user and Host", () => {
    const storage = new MemoryStorage();
    const first = PROJECTS[0];
    if (!first) throw new Error("Project fixture is missing");
    writeJarvisLastProject(storage, "local", 10058, first, NOW);
    expect(readJarvisLastProject(storage, "local", 10058, NOW)).toEqual({
      id: 9001,
      name: "示例后台 · 迭代 B",
    });
    expect(readJarvisLastProject(storage, "local", 20001, NOW)).toBeNull();
    expect(readJarvisLastProject(storage, "remote-1", 10058, NOW)).toBeNull();
    expect(readJarvisLastProject(storage, "local", 10058, NOW + 91 * 24 * 60 * 60_000)).toBeNull();
  });

  it("ignores malformed or foreign entries instead of throwing", () => {
    const storage = new MemoryStorage();
    storage.setItem("codexhost.jarvis.projects.v1.local", "{");
    storage.setItem(
      "codexhost.jarvis.last-project.v1.local.10058",
      JSON.stringify({ project: {} }),
    );
    expect(readJarvisProjectCache(storage, "local")).toBeNull();
    expect(readJarvisLastProject(storage, "local", 10058, NOW)).toBeNull();
    expect(readJarvisProjectCache(null, "local")).toBeNull();
    expect(() => writeJarvisProjectCache(null, "local", 10058, PROJECTS, NOW)).not.toThrow();
    clearJarvisProjectCache(storage, "local");
    expect(readJarvisProjectCache(storage, "local")).toBeNull();
  });
});
