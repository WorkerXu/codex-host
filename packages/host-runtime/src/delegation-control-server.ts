import {
  SKILL_PEER_OPERATIONS,
  type LocalSkillsHub,
  type SkillPeerOperation,
} from "./skills-hub/local.js";
import { skillsError } from "./skills-hub/service.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  DelegationControlError,
  type DelegationControlApi,
  type DelegationStartInput,
  type DelegationWatchApi,
  type HarnessInspectInput,
  type HarnessListInput,
  type ThreadCancelInput,
  type ThreadAnswerInput,
  type ThreadListInput,
  type ThreadSendInput,
  type ThreadReadInput,
  type ThreadWaitInput,
  type ThreadWatchCancelInput,
  type ThreadWatchInput,
} from "./delegation-types.js";
import { startWithDelegationWorktree } from "./delegation-worktree.js";
import { matchesBearerToken } from "./bearer-token.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

function errorBody(error: unknown): {
  error: { code: string; message: string; details?: unknown };
} {
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

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES)
      throw new DelegationControlError("INVALID_ARGUMENT", "Request body is too large");
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new DelegationControlError("INVALID_ARGUMENT", "Request body must be a JSON object");
  }
}

export interface DelegationControlServer {
  endpoint: string;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function watchApi(api: DelegationWatchApi | undefined): DelegationWatchApi {
  if (!api)
    throw new DelegationControlError("INVALID_ARGUMENT", "This Runtime does not support watches");
  return api;
}

/** The Turn already started, so a watch failure is reported beside it, not thrown. */
function watchStartedTurn(watches: DelegationWatchApi, input: ThreadWatchInput) {
  return watches.watch(input).catch((error: unknown) => ({
    state: "notRegistered" as const,
    reason: error instanceof Error ? error.message : String(error),
  }));
}

/** `delegate start --watch`: the Host-resolved parent is the notified Thread. */
async function startWithWatch(
  api: DelegationControlApi,
  watches: DelegationWatchApi,
  body: Record<string, unknown>,
): Promise<unknown> {
  const { watchTimeoutMs, ...start } = body;
  const result = await api.start(start as unknown as DelegationStartInput);
  const watch = await watchStartedTurn(watches, {
    threadId: result.threadId,
    notifyThreadId: result.parentThreadId ?? "",
    timeoutMs: watchTimeoutMs as number,
  });
  return { ...result, watch };
}

/** Preparation runs on the target Host, including starts forwarded by peer-exec. */
async function startWithWorktree(
  api: DelegationControlApi,
  watches: DelegationWatchApi | undefined,
  body: Record<string, unknown>,
): Promise<unknown> {
  const { worktree, base, ...start } = body;
  if (
    worktree !== undefined &&
    (typeof start.harnessId !== "string" ||
      !start.harnessId.trim() ||
      typeof start.task !== "string" ||
      !start.task.trim())
  )
    throw new DelegationControlError(
      "INVALID_ARGUMENT",
      "harnessId and task must be non-empty strings",
    );
  // Resolve the watch capability before creating any files.
  const watcher = start.watchTimeoutMs === undefined ? undefined : watchApi(watches);
  return startWithDelegationWorktree(
    {
      cwd: start.cwd as string | undefined,
      branch: worktree as string | undefined,
      base: base as string | undefined,
    },
    (cwd) => {
      const input = { ...start, ...(cwd !== undefined ? { cwd } : {}) };
      return watcher
        ? startWithWatch(api, watcher, input)
        : api.start(input as unknown as DelegationStartInput);
    },
  );
}

export interface DingTalkDwsPeerApi {
  /** Runs one dws command on the machine that owns the DingTalk login. */
  runDingTalkDws(args: readonly string[]): Promise<Record<string, unknown>>;
  /** Downloads and returns one message image from the same machine. */
  readDingTalkMedia(body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export async function startDelegationControlServer(input: {
  token: string;
  api: DelegationControlApi;
  watchApi?: DelegationWatchApi;
  dingtalkDws?: DingTalkDwsPeerApi;
  skills?: LocalSkillsHub;
}): Promise<DelegationControlServer> {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        writeJson(response, 405, {
          error: { code: "INVALID_ARGUMENT", message: "POST is required" },
        });
        return;
      }
      if (!matchesBearerToken(request.headers.authorization, input.token)) {
        writeJson(response, 401, {
          error: { code: "RUNTIME_UNREACHABLE", message: "Runtime token is invalid" },
        });
        return;
      }
      const body = await jsonBody(request);
      if (request.url?.startsWith("/v1/skills/")) {
        const operation = request.url.slice("/v1/skills/".length);
        if (!input.skills || !SKILL_PEER_OPERATIONS.includes(operation as SkillPeerOperation)) {
          writeJson(response, 404, {
            error: { code: "INVALID_ARGUMENT", message: "Unknown skills route" },
          });
          return;
        }
        try {
          writeJson(
            response,
            200,
            await input.skills.request(operation as SkillPeerOperation, body),
          );
        } catch (error) {
          writeJson(response, 400, {
            error: { code: skillsError(error), message: skillsError(error) },
          });
        }
        return;
      }
      switch (request.url) {
        case "/v1/harness/list":
          writeJson(
            response,
            200,
            await input.api.listHarnesses(body as unknown as HarnessListInput),
          );
          return;
        case "/v1/harness/inspect":
          writeJson(response, 200, await input.api.inspect(body as unknown as HarnessInspectInput));
          return;
        case "/v1/delegate/start":
          writeJson(response, 200, await startWithWorktree(input.api, input.watchApi, body));
          return;
        case "/v1/thread/answer":
          writeJson(response, 200, await input.api.answer(body as unknown as ThreadAnswerInput));
          return;
        case "/v1/thread/send":
          writeJson(response, 200, await input.api.send(body as unknown as ThreadSendInput));
          return;
        case "/v1/thread/cancel":
          writeJson(response, 200, await input.api.cancel(body as unknown as ThreadCancelInput));
          return;
        case "/v1/thread/read":
          writeJson(response, 200, await input.api.read(body as unknown as ThreadReadInput));
          return;
        case "/v1/thread/wait":
          writeJson(response, 200, await input.api.wait(body as unknown as ThreadWaitInput));
          return;
        case "/v1/thread/watch":
          writeJson(
            response,
            200,
            await watchApi(input.watchApi).watch(body as unknown as ThreadWatchInput),
          );
          return;
        case "/v1/thread/watches":
          writeJson(response, 200, await watchApi(input.watchApi).watches());
          return;
        case "/v1/thread/watch/cancel":
          writeJson(
            response,
            200,
            await watchApi(input.watchApi).cancelWatch(body as unknown as ThreadWatchCancelInput),
          );
          return;
        case "/v1/dingtalk/dws": {
          if (!input.dingtalkDws) {
            writeJson(response, 404, {
              error: { code: "INVALID_ARGUMENT", message: "DingTalk is unavailable on this Host" },
            });
            return;
          }
          const args = Array.isArray(body.args)
            ? body.args.filter((value): value is string => typeof value === "string")
            : [];
          writeJson(response, 200, await input.dingtalkDws.runDingTalkDws(args));
          return;
        }
        case "/v1/dingtalk/media": {
          if (!input.dingtalkDws) {
            writeJson(response, 404, {
              error: { code: "INVALID_ARGUMENT", message: "DingTalk is unavailable on this Host" },
            });
            return;
          }
          writeJson(response, 200, await input.dingtalkDws.readDingTalkMedia(body));
          return;
        }
        case "/v1/thread/list":
          writeJson(response, 200, await input.api.list(body as unknown as ThreadListInput));
          return;
        default:
          throw new DelegationControlError("INVALID_ARGUMENT", "Unknown Runtime control route");
      }
    })().catch((error) => {
      writeJson(response, error instanceof DelegationControlError ? 400 : 500, errorBody(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}
