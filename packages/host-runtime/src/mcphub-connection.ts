import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { hubMcpKeySchema } from "@codexhost/shared-contracts";
import { z } from "zod";
import { HubAdminError } from "./hub-admin-http.js";

export const MCPHUB_KEY_FILE = "mcphub-admin-key";

/** The administrator key belongs to the Host that connects to MCPHub. */
export class McpHubConnectionStore {
  readonly #directory: string;
  #writes = Promise.resolve();

  constructor(options: { configDirectory?: string; environment?: NodeJS.ProcessEnv } = {}) {
    this.#directory =
      options.configDirectory ??
      join(options.environment?.HOME || homedir(), ".config", "codexhost");
  }

  async read(): Promise<string | null> {
    try {
      return hubMcpKeySchema.parse(await readFile(join(this.#directory, MCPHUB_KEY_FILE), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new HubAdminError("failed");
    }
  }

  write(key: string | null): Promise<void> {
    // A disconnect submitted during a replacement must remove the replacement too.
    const operation = this.#writes.then(() => this.#write(key));
    this.#writes = operation.catch(() => undefined);
    return operation;
  }

  async #write(key: string | null): Promise<void> {
    const parsed = hubMcpKeySchema.nullable().safeParse(key);
    if (!parsed.success) throw new HubAdminError("invalid");
    const file = join(this.#directory, MCPHUB_KEY_FILE);
    try {
      if (parsed.data === null) {
        await rm(file, { force: true });
        return;
      }
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await chmod(this.#directory, 0o700);
      const temporary = join(this.#directory, `.${MCPHUB_KEY_FILE}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, `${parsed.data}\n`, { mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    } catch {
      throw new HubAdminError("failed");
    }
  }
}

export interface McpHubRouting {
  enableBearerAuth?: boolean | undefined;
  skipAuth?: boolean | undefined;
  bearerAuthHeaderName?: string | undefined;
}
/** Routing policy only; never derive a credential from MCPHub's users or keys. */
export function headerNameFromRouting(routing: McpHubRouting): string {
  // Anonymous dashboard access cannot prove that the presented key is valid.
  if (routing.enableBearerAuth === false || routing.skipAuth) throw new HubAdminError("mcp-auth");
  return z
    .string()
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/u)
    .parse(routing.bearerAuthHeaderName?.trim() || "Authorization");
}
