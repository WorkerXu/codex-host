import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { SkillBundle } from "@codexhost/shared-contracts";
import { reinstallSource } from "../src/skills-hub/source.js";
import { fingerprint } from "../src/skills-hub/files.js";
import { SkillTransfers } from "../src/skills-hub/transfers.js";
afterEach(() => vi.unstubAllGlobals());
function bundle(): SkillBundle {
  const data = Buffer.from("---\nname: example\n---\ntext");
  return {
    skill: "example",
    fingerprint: fingerprint([{ path: "SKILL.md", data, modified: 0, executable: false }]),
    data: "",
    source: {
      source: "owner/repo",
      sourceUrl: "https://github.com/owner/repo",
      commit: "a".repeat(40),
      skillPath: "skills/example/SKILL.md",
    },
    files: [
      {
        path: "SKILL.md",
        hash: createHash("sha256").update(data).digest("hex"),
        size: data.length,
        executable: false,
      },
    ],
  };
}
describe("immutable source reinstall", () => {
  it("reinstalls exact pinned files without executing a package manager", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("---\nname: example\n---\ntext"));
    vi.stubGlobal("fetch", fetcher);
    const result = await reinstallSource(bundle());
    expect(result).not.toBeNull();
    expect(fingerprint(result!)).toBe(bundle().fingerprint);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://raw.githubusercontent.com/owner/repo/${"a".repeat(40)}/skills/example/SKILL.md`,
    );
  });
  it("falls back to the verified archive for mutable, unavailable or changed sources", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("wrong"));
    vi.stubGlobal("fetch", fetcher);
    expect(await reinstallSource(bundle())).toBeNull();
    const mutable = bundle();
    delete mutable.source!.commit;
    expect(await reinstallSource(mutable)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await reinstallSource(bundle())).toBeNull();
  });
});
describe("transfer tokens", () => {
  it("requires contiguous chunks and complete single-use uploads", () => {
    const transfers = new SkillTransfers();
    const { data, ...metadata } = bundle();
    expect(data).toBe("");
    const { token } = transfers.begin({ bundle: metadata, expected: null, length: 8 });
    expect(() => transfers.append({ token, offset: 4, data: "AAAA" })).toThrow("invalid_transfer");
    transfers.append({ token, offset: 0, data: "AAAA" });
    transfers.append({ token, offset: 4, data: "AAAA" });
    expect(transfers.finish({ token }).bundle.data).toBe("AAAAAAAA");
    expect(() => transfers.finish({ token })).toThrow("invalid_transfer");
  });
});
