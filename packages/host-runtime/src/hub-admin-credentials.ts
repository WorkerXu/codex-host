import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HubAdminError } from "./hub-admin-http.js";

export function parseHubEnvironment(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=\s*(.*)$/u.exec(line.trim());
    if (!match?.[1] || match[2] === undefined) continue;
    const value = match[2].trim();
    result[match[1]] = /^(["']).*\1$/u.test(value) ? value.slice(1, -1) : value;
  }
  return result;
}

export async function memhubCredentials(
  directory = join(homedir(), ".one-memory"),
): Promise<Record<string, string>> {
  try {
    const token = (await readFile(join(directory, "runtime-token"), "utf8")).trim();
    if (!token || /[\r\n]/u.test(token)) throw new HubAdminError("forbidden");
    return { Authorization: `Bearer ${token}` };
  } catch (error) {
    if (error instanceof HubAdminError) throw error;
    throw new HubAdminError(
      (error as { code?: string }).code === "ENOENT" ? "unavailable" : "forbidden",
    );
  }
}
