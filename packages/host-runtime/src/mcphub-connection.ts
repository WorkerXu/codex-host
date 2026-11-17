import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hubMcpKeySchema } from "@codexhost/shared-contracts";
import { z } from "zod";
import { HubAdminError } from "./hub-admin-http.js";
import { parseHubEnvironment } from "./hub-admin-credentials.js";

export const MCPHUB_KEY_FILE = "mcphub-admin-key";

/** The administrator key belongs to the Host that calls MCPHub on localhost. */
export class McpHubConnectionStore {
  private readonly directory: string;
  constructor(options: { configDirectory?: string; environment?: NodeJS.ProcessEnv } = {}) {
    this.directory =
      options.configDirectory ??
      join(options.environment?.HOME || homedir(), ".config", "codexhost");
  }
  async read(): Promise<string | null> {
    try {
      return hubMcpKeySchema.parse(await readFile(join(this.directory, MCPHUB_KEY_FILE), "utf8"));
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw new HubAdminError("failed");
    }
  }
  async write(key: string | null): Promise<void> {
    const file = join(this.directory, MCPHUB_KEY_FILE);
    if (key === null) {
      await rm(file, { force: true });
      return;
    }
    const parsed = hubMcpKeySchema.safeParse(key);
    if (!parsed.success) throw new HubAdminError("invalid");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `.${MCPHUB_KEY_FILE}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${parsed.data}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** Read routing policy only; never derive a credential from MCPHub's users or keys. */
export async function mcphubHeaderName(
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<string> {
  try {
    const environment = parseHubEnvironment(await read("/etc/mcphub.env"));
    const settings = z
      .object({
        systemConfig: z
          .object({
            routing: z
              .object({
                enableBearerAuth: z.boolean().optional(),
                skipAuth: z.boolean().optional(),
                bearerAuthHeaderName: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .parse(
        JSON.parse(
          await read(environment.MCPHUB_SETTING_PATH ?? "/opt/mcphub/data/mcp_settings.json"),
        ),
      );
    const routing = settings.systemConfig?.routing;
    // Anonymous dashboard access cannot prove that the presented key is valid.
    if (routing?.enableBearerAuth === false || routing?.skipAuth)
      throw new HubAdminError("mcp-auth");
    return z
      .string()
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/u)
      .parse(routing?.bearerAuthHeaderName?.trim() || "Authorization");
  } catch (error) {
    if (error instanceof HubAdminError) throw error;
    throw new HubAdminError(
      (error as { code?: string }).code === "ENOENT" ? "unavailable" : "failed",
    );
  }
}
