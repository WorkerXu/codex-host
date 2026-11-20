import { HUB_ERROR_MESSAGES } from "@codexhost/shared-contracts";

export class HubAdminError extends Error {
  constructor(readonly code: keyof typeof HUB_ERROR_MESSAGES) {
    super(HUB_ERROR_MESSAGES[code]);
    this.name = "HubAdminError";
  }
}

/** A codexhost-managed loopback forward; redirects may never carry credentials elsewhere. */
export async function hubJson(
  fetcher: typeof fetch,
  base: string,
  path: string,
  headers: Record<string, string>,
  method = "GET",
  body?: unknown,
  mapError?: (response: Response, text: string) => HubAdminError | null,
): Promise<unknown> {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(base)) throw new HubAdminError("failed");
  try {
    const response = await fetcher(`${base}${path}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (mapError) {
        let text = "";
        try {
          text = await response.text();
        } catch {
          /* The status still decides. */
        }
        const mapped = mapError(response, text);
        if (mapped) throw mapped;
      }
      throw new HubAdminError(
        response.status === 401 || response.status === 403
          ? "forbidden"
          : response.status === 404
            ? "missing"
            : response.status === 409
              ? "conflict"
              : response.status === 400 || response.status === 422
                ? "invalid"
                : "failed",
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof HubAdminError) throw error;
    const value = error as { name?: string; cause?: { code?: string } };
    if (value.name === "TimeoutError" || value.name === "AbortError")
      throw new HubAdminError("timeout");
    if (value.cause?.code === "ECONNREFUSED") throw new HubAdminError("unavailable");
    throw new HubAdminError("connection");
  }
}
