import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const availabilitySchema = z.object({
  formatVersion: z.literal(1),
  entries: z.record(z.string(), z.unknown()),
});

const entrySchema = z.object({
  status: z.enum(["ready", "notInstalled", "unavailable", "error"]),
  checkedAt: z.number(),
});

// The CLI and Desktop may have different CODEXHOST_DATA_DIR values on one machine.
export function skillsUserDirectory(environment: NodeJS.ProcessEnv): string {
  return path.resolve(
    environment.CODEXHOST_USER_DIR ?? path.join(environment.HOME ?? homedir(), ".codexhost"),
  );
}

export async function cachedHarnessIds(
  environment: NodeJS.ProcessEnv,
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  try {
    const file = path.join(skillsUserDirectory(environment), "cache", "harness-availability.json");
    const { entries } = availabilitySchema.parse(JSON.parse(await readFile(file, "utf8")));
    for (const [id, value] of Object.entries(entries)) {
      const entry = entrySchema.safeParse(value);
      if (entry.success && entry.data.status !== "notInstalled") ids.add(id);
    }
  } catch {
    // Without an availability cache the installed set only contains built-in Codex.
  }
  return ids;
}
