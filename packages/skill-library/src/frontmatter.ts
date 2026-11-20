import { isMap, isScalar, parseDocument } from "yaml";

export function parseSkillFrontmatter(text: string): {
  data?: { name?: unknown; description?: unknown; version?: string };
  error?: string;
} {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) return { error: "Missing or oversized YAML frontmatter" };
  const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
  if (document.errors.length) return { error: "Invalid YAML frontmatter" };
  const value: unknown = document.toJS({ maxAliasCount: 100 });
  if (!isMap(document.contents) || !value || typeof value !== "object") return {};
  const { name, description } = value as { name?: unknown; description?: unknown };
  const version = document.contents.get("version", true);
  // Preserve the written version, including trailing zeroes on unquoted numbers.
  return {
    data: {
      name,
      description,
      ...(isScalar(version) && version.source ? { version: version.source } : {}),
    },
  };
}
