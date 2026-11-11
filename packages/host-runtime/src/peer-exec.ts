import type { Readable, Writable } from "node:stream";

import { DelegationControlError } from "./delegation-types.js";
import type { RuntimeControlLocation } from "./runtime-control-file.js";
import { readRuntimeControl } from "./runtime-control-file.js";

/** The only Runtime routes a peer may invoke; never arbitrary paths or URLs. */
export const PEER_EXEC_ROUTES = [
  "/v1/harness/list",
  "/v1/harness/inspect",
  "/v1/delegate/start",
  "/v1/thread/send",
  "/v1/thread/cancel",
  "/v1/thread/read",
  "/v1/thread/wait",
  "/v1/thread/watch",
  "/v1/thread/watches",
  "/v1/thread/list",
] as const;

export type PeerExecRoute = (typeof PEER_EXEC_ROUTES)[number];

const ROUTES: ReadonlySet<string> = new Set(PEER_EXEC_ROUTES);
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export interface PeerExecRequest {
  route: PeerExecRoute;
  body: Record<string, unknown>;
}

export function isPeerExecRoute(value: unknown): value is PeerExecRoute {
  return typeof value === "string" && ROUTES.has(value);
}

function invalidRequest(message: string): DelegationControlError {
  return new DelegationControlError("INVALID_ARGUMENT", message);
}

/** Validates the stdin envelope before any Runtime access. */
export function parsePeerExecRequest(value: unknown): PeerExecRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest("peer-exec input must be a JSON object");
  }
  const request = value as Record<string, unknown>;
  if (!isPeerExecRoute(request.route)) {
    throw invalidRequest("peer-exec route is not allowed");
  }
  if (request.body === undefined) return { route: request.route, body: {} };
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    throw invalidRequest("peer-exec body must be a JSON object");
  }
  return { route: request.route, body: request.body as Record<string, unknown> };
}

export async function readPeerExecRequest(stream: Readable): Promise<PeerExecRequest> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) {
      throw invalidRequest("peer-exec input is too large");
    }
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalidRequest("peer-exec input must be JSON");
  }
  return parsePeerExecRequest(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorEnvelope(error: unknown): { error: Record<string, unknown> } {
  if (error instanceof DelegationControlError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * Hidden remote half of peer delegation. It reads `{route, body}` from stdin,
 * uses this machine's control file, and writes the Runtime response verbatim.
 */
export async function runPeerExec(
  input: {
    stream?: Readable;
    output?: Writable;
    environment?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    readControl?: (environment: NodeJS.ProcessEnv) => Promise<RuntimeControlLocation | undefined>;
  } = {},
): Promise<number> {
  const output = input.output ?? process.stdout;
  const environment = input.environment ?? process.env;
  try {
    const request = await readPeerExecRequest(input.stream ?? process.stdin);
    const control = await (input.readControl ?? readRuntimeControl)(environment);
    if (!control) {
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "No live Host Runtime control file was found on this machine. Start codexhost on the peer and retry.",
      );
    }
    let response: Response;
    try {
      response = await (input.fetchImpl ?? fetch)(new URL(request.route, control.record.endpoint), {
        method: "POST",
        headers: {
          authorization: `Bearer ${control.record.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request.body),
        redirect: "error",
      });
    } catch (error) {
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "The Host Runtime control endpoint could not be reached",
        {
          reason: "control_unreachable",
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        "The Host Runtime control response could not be read",
        {
          reason: "invalid_runtime_response",
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        `Host Runtime returned an unreadable response (HTTP ${response.status})`,
        { reason: "invalid_runtime_response", status: response.status },
      );
    }
    if (!isObject(body)) {
      throw new DelegationControlError(
        "RUNTIME_UNREACHABLE",
        `Host Runtime returned an unreadable response (HTTP ${response.status})`,
        { reason: "invalid_runtime_response", status: response.status },
      );
    }
    // Runtime errors already have the CLI envelope; pass them through unchanged.
    output.write(text);
    return response.ok && body.error === undefined ? 0 : 1;
  } catch (error) {
    output.write(`${JSON.stringify(errorEnvelope(error))}\n`);
    return 1;
  }
}
