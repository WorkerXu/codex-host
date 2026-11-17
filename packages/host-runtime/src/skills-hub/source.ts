import type { SkillBundle } from "@codexhost/shared-contracts";
import { fingerprint, MAX_SKILL_BYTES, type SkillFile } from "./files.js";

/** Reinstall immutable GitHub sources as data only. No package manager or skill scripts execute. */
export async function reinstallSource(bundle: SkillBundle): Promise<SkillFile[] | null> {
  const source = bundle.source;
  if (
    !source?.commit ||
    !/^[\w.-]+\/[\w.-]+$/u.test(source.source) ||
    !source.sourceUrl?.startsWith("https://github.com/")
  )
    return null;
  const skillPath = (source.skillPath ?? "").replace(/\/SKILL\.md$/u, "");
  if (
    skillPath.split("/").some((part) => part === ".." || part === ".") ||
    skillPath.startsWith("/")
  )
    return null;
  const files: SkillFile[] = [];
  let bytes = 0;
  const signal = AbortSignal.timeout(30_000);
  try {
    for (const entry of bundle.files) {
      bytes += entry.size;
      if (bytes > MAX_SKILL_BYTES || entry.path.split("/").some((part) => part === ".." || !part))
        return null;
      const url = `https://raw.githubusercontent.com/${source.source}/${source.commit}/${[
        skillPath,
        entry.path,
      ]
        .filter(Boolean)
        .map((part) => part.split("/").map(encodeURIComponent).join("/"))
        .join("/")}`;
      const response = await fetch(url, { signal, redirect: "error" });
      if (!response.ok || !response.body) return null;
      const chunks: Uint8Array[] = [];
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > entry.size) {
          await response.body.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(chunk);
      }
      if (received !== entry.size) return null;
      files.push({
        path: entry.path,
        data: Buffer.concat(chunks),
        executable: entry.executable,
        modified: Date.now(),
      });
    }
    return fingerprint(files) === bundle.fingerprint ? files : null;
  } catch {
    return null;
  }
}
