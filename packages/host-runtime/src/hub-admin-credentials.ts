import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HubAdminError } from "./hub-admin-http.js";

const settingsSchema = z.object({
  users: z
    .array(
      z.object({ username: z.string(), password: z.string(), isAdmin: z.boolean().optional() }),
    )
    .default([]),
  bearerKeys: z
    .array(
      z.object({
        token: z.string().optional(),
        enabled: z.boolean(),
        accessType: z.string(),
        kind: z.string().optional(),
      }),
    )
    .default([]),
  systemConfig: z
    .object({
      routing: z
        .object({ skipAuth: z.boolean().optional(), bearerAuthHeaderName: z.string().optional() })
        .optional(),
    })
    .optional(),
});

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

/** Secrets are consumed only by the Host's localhost HTTP client. */
export async function mcphubCredentials(
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<Record<string, string>> {
  try {
    const environment = parseHubEnvironment(await read("/etc/mcphub.env"));
    const settings = settingsSchema.parse(
      JSON.parse(
        await read(environment.MCPHUB_SETTING_PATH ?? "/opt/mcphub/data/mcp_settings.json"),
      ),
    );
    const secret = environment.JWT_SECRET;
    const admin = settings.users.find((user) => user.isAdmin);
    if (secret && admin) {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      const payload = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ user: { username: admin.username, sessionVersion: createHash("sha256").update(`${admin.username}\0${admin.password}`).digest("hex") }, iat: now, exp: now + 60 })}`;
      return {
        "x-auth-token": `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`,
      };
    }
    const key = settings.bearerKeys.find(
      (key) => key.enabled && key.kind !== "user" && key.accessType === "all" && key.token,
    );
    if (key?.token)
      return {
        [settings.systemConfig?.routing?.bearerAuthHeaderName ?? "Authorization"]:
          `Bearer ${key.token}`,
      };
    if (settings.systemConfig?.routing?.skipAuth) return {};
    throw new HubAdminError("forbidden");
  } catch (error) {
    if (error instanceof HubAdminError) throw error;
    const code = (error as { code?: string }).code;
    throw new HubAdminError(code === "ENOENT" ? "unavailable" : "forbidden");
  }
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
