import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { DingTalkConversation, DingTalkMessage } from "@codexhost/shared-contracts";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;
const EVENT_OUTPUT_BYTES = 1 * 1024 * 1024;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;

export type DwsSpawn = typeof spawn;

export interface DwsRawResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface DwsResult extends DwsRawResult {
  /** Parsed JSON object, or null when the CLI printed no JSON object. */
  value: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface DingTalkCliOptions {
  environment?: NodeJS.ProcessEnv;
  executable?: string;
  spawnImpl?: DwsSpawn;
  timeoutMs?: number;
  /** Runs on the configured DingTalk Host instead of the local CLI. */
  runImpl?: (args: readonly string[], timeoutMs: number) => Promise<DwsResult>;
}

export interface DwsEventRecord {
  messageId: string;
  conversationId: string;
  senderName: string;
  senderId?: string;
  text: string;
  createdAt: number;
}

export function dwsExecutableCandidates(environment: NodeJS.ProcessEnv = process.env): string[] {
  const home = environment.HOME || os.homedir();
  const names = process.platform === "win32" ? ["dws.exe", "dws"] : ["dws"];
  const candidates: string[] = [];
  const configured = environment.DWS_CLI_PATH?.trim() ?? environment.DINGTALK_CLI_PATH?.trim();
  if (configured && path.isAbsolute(configured)) candidates.push(configured);
  for (const name of names) candidates.push(path.join(home, ".local", "bin", name));
  const pathValue = environment.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const name of names) candidates.push(path.join(directory, name));
  }
  return [...new Set(candidates)];
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    await access(file, process.platform === "win32" ? 0 : 0o1);
    return true;
  } catch {
    return false;
  }
}

/** First installed CLI, preferring an explicit path and the user-local install. */
export async function resolveDwsExecutable(
  options: DingTalkCliOptions = {},
): Promise<string | null> {
  if (options.executable) return options.executable;
  for (const candidate of dwsExecutableCandidates(options.environment ?? process.env)) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function terminate(child: { kill(signal?: NodeJS.Signals): boolean }): void {
  // SIGTERM lets the CLI cancel its event subscription; never SIGKILL.
  child.kill("SIGTERM");
}

/** Spawn with an argument array; no shell ever sees the arguments. */
export async function runDwsRaw(
  args: readonly string[],
  options: DingTalkCliOptions & { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<DwsRawResult> {
  const executable = await resolveDwsExecutable(options);
  if (!executable) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "dws is not installed",
      timedOut: false,
      truncated: false,
    };
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return await new Promise<DwsRawResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timedOut = false;
    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut, truncated });
    };
    const child = spawnImpl(executable, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.environment ?? process.env,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
      settle(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (stdout.length >= maxOutputBytes) {
        truncated = true;
        return;
      }
      stdout += chunk.toString().slice(0, maxOutputBytes - stdout.length);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString();
    });
    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));
  });
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function dwsErrorFromValue(value: Record<string, unknown> | null): {
  code: string | null;
  message: string | null;
} {
  if (!value) return { code: null, message: null };
  if (value.success === false) {
    const error = record(value.error) ? value.error : null;
    return {
      code: typeof error?.code === "string" ? error.code : "operation_failed",
      message: typeof error?.message === "string" ? error.message : null,
    };
  }
  if (value.errorCode !== undefined && value.errorCode !== null) {
    return {
      code: typeof value.errorCode === "string" ? value.errorCode : "operation_failed",
      message: typeof value.errorMsg === "string" ? value.errorMsg : null,
    };
  }
  return { code: null, message: null };
}

/** Run one JSON-returning command and classify its terminal result. */
export async function runDwsJson(
  args: readonly string[],
  options: DingTalkCliOptions & { timeoutMs?: number } = {},
): Promise<DwsResult> {
  const raw = await runDwsRaw([...args, "--format", "json"], options);
  const value = parseJsonObject(raw.stdout);
  const failure = dwsErrorFromValue(value);
  return {
    ...raw,
    value,
    errorCode: !raw.timedOut && raw.exitCode !== null ? failure.code : "timeout",
    errorMessage: failure.message,
  };
}

/** `dws` prints Shanghai wall-clock strings; keep numeric offsets exact. */
export function parseDwsTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/^\d{13}$/u.test(text)) return Number(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(text);
  if (iso) {
    const [, year, month, day, hour, minute, second] = iso;
    return (
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ) - SHANGHAI_OFFSET_MS
    );
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function booleanNumber(value: unknown): boolean {
  return value === 1 || value === true;
}

/** `dws chat message list-unread-conversations` → conversation rows. */
export function parseUnreadConversations(value: unknown): DingTalkConversation[] {
  const root = record(value) ? value : null;
  const result = root && record(root.result) ? root.result : null;
  const rows = result && Array.isArray(result.conversations) ? result.conversations : [];
  const conversations: DingTalkConversation[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!record(row)) continue;
    const conversationId = string(row.openConversationId);
    if (!conversationId || seen.has(conversationId)) continue;
    seen.add(conversationId);
    conversations.push({
      conversationId,
      title: string(row.title),
      singleChat: row.singleChat === true,
      unreadCount: Math.max(0, Math.floor(number(row.unreadPoint) ?? 0)),
      lastMessageAt: parseDwsTime(row.lastMsgCreateAt),
      muted: booleanNumber(row.notificationOff),
    });
  }
  return conversations;
}

/** `dws chat +conversation-info` → one conversation row. */
export function parseConversationInfo(value: unknown): DingTalkConversation | null {
  if (!record(value)) return null;
  const result = record(value.result) ? value.result : null;
  const info = result && record(result.conversationInfo) ? result.conversationInfo : null;
  const conversationId = string(info?.openConversationId);
  if (!info || !conversationId) return null;
  return {
    conversationId,
    title: string(info.title),
    singleChat: info.singleChat === true,
    unreadCount: 0,
    lastMessageAt: null,
    muted: false,
  };
}

const UNSUPPORTED_MARKERS = [
  "[图片消息]",
  "[文件]",
  "[语音消息]",
  "[视频消息]",
  "[卡片消息]",
  "[合并转发]",
  "[表情]",
];

export function messageIsUnsupported(text: string, hasResources: boolean): boolean {
  if (!text.trim()) return true;
  if (UNSUPPORTED_MARKERS.some((marker) => text.includes(marker))) return true;
  // A body that is only a resource reference has no readable message text.
  return hasResources && /^\[[^\]]+\]\s*\S*$/u.test(text.trim());
}

function messageFromRow(
  row: Record<string, unknown>,
  selfId: string | null,
): DingTalkMessage | null {
  const messageId = string(row.messageId) || string(row.openMessageId);
  const conversationId = string(row.conversationId) || string(row.openConversationId);
  if (!messageId || !conversationId) return null;
  const text = string(row.text) || string(row.content);
  const hasResources = Array.isArray(row.resourceRefs) && row.resourceRefs.length > 0;
  const senderId = string(row.senderId) || string(row.senderOpenDingTalkId);
  return {
    messageId,
    conversationId,
    senderName: string(row.sender) || "未知成员",
    ...(senderId ? { senderId } : {}),
    createdAt: parseDwsTime(row.createTime) ?? parseDwsTime(row.time) ?? 0,
    text,
    unsupported: messageIsUnsupported(text, hasResources),
    mine: selfId !== null && senderId === selfId,
  };
}

/** `dws chat message list` / `+search-msg` → message rows, newest first. */
export function parseMessages(value: unknown, selfId: string | null): DingTalkMessage[] {
  if (!record(value)) return [];
  const rows = Array.isArray(value.messages) ? value.messages : [];
  return rows
    .filter((row): row is Record<string, unknown> => record(row))
    .map((row) => messageFromRow(row, selfId))
    .filter((message): message is DingTalkMessage => message !== null)
    .sort((left, right) => right.createdAt - left.createdAt);
}

export interface MessagesPage {
  messages: DingTalkMessage[];
  hasMore: boolean;
  nextCursor: number | null;
}

export function parseMessagesPage(value: unknown, selfId: string | null): MessagesPage {
  const messages = parseMessages(value, selfId);
  if (!record(value)) return { messages, hasMore: false, nextCursor: null };
  const nextPage = record(value.nextPage) ? value.nextPage : null;
  const cursor = number(nextPage?.nextCursor);
  return {
    messages,
    hasMore: value.hasMore === true,
    nextCursor: cursor,
  };
}

/** One flattened IM event line; malformed or unrelated lines are ignored. */
export function parseDwsEventLine(line: string): DwsEventRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!record(value)) return null;
  const payload = record(value.payload) ? value.payload : value;
  const messageId = string(payload.message_id) || string(payload.messageId);
  const conversationId = string(payload.conversation_id) || string(payload.conversationId);
  if (!messageId || !conversationId) return null;
  const senderId = string(payload.sender_open_dingtalk_id) || string(payload.senderId);
  const eventTime = parseDwsTime(payload.create_time) ?? parseDwsTime(payload.event_time);
  return {
    messageId,
    conversationId,
    senderName: string(payload.sender) || "未知成员",
    ...(senderId ? { senderId } : {}),
    text: string(payload.content) || string(payload.text),
    createdAt: eventTime ?? Date.now(),
  };
}

export interface DingTalkEventStream {
  stop(): void;
}

export interface DingTalkCli {
  executable(): Promise<string | null>;
  openEvents(input: {
    onRecord(record: DwsEventRecord): void;
    onExit?(): void;
  }): Promise<DingTalkEventStream | null>;
  authStatus(): Promise<{
    installed: boolean;
    authenticated: boolean;
    userId: string | null;
    userName: string | null;
    corpName: string | null;
    errorCode: string | null;
  }>;
  unreadConversations(
    count: number,
  ): Promise<{ conversations: DingTalkConversation[]; errorCode: string | null }>;
  conversationInfo(conversationId: string): Promise<DingTalkConversation | null>;
  messages(input: {
    conversationId: string;
    before?: number;
    limit: number;
    direction?: "older" | "newer";
    /** Bounded scrollback for resolving an older selected message. */
    pageAll?: boolean;
    maxItems?: number;
  }): Promise<MessagesPage & { errorCode: string | null }>;
  searchMessages(input: {
    query?: string;
    senderIds?: readonly string[];
    atMe?: boolean;
    days?: number;
    limit: number;
  }): Promise<{ messages: DingTalkMessage[]; errorCode: string | null }>;
  send(conversationId: string, text: string): Promise<{ ok: boolean; errorCode: string | null }>;
}

function formatDwsTime(ms: number): string {
  const shanghai = new Date(ms + SHANGHAI_OFFSET_MS);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${shanghai.getUTCFullYear()}-${pad(shanghai.getUTCMonth() + 1)}-${pad(
    shanghai.getUTCDate(),
  )} ${pad(shanghai.getUTCHours())}:${pad(shanghai.getUTCMinutes())}:${pad(
    shanghai.getUTCSeconds(),
  )}`;
}

function dataObject(result: DwsResult): Record<string, unknown> | null {
  return result.value;
}

export function createDingTalkCli(options: DingTalkCliOptions = {}): DingTalkCli {
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const external = options.runImpl;
  let cachedUser: { id: string; name: string } | null = null;

  const run = (args: readonly string[], requestTimeoutMs = timeoutMs): Promise<DwsResult> =>
    external
      ? external(args, requestTimeoutMs)
      : runDwsJson(args, {
          ...options,
          environment,
          timeoutMs: requestTimeoutMs,
        });

  const self = async (): Promise<{ id: string; name: string } | null> => {
    if (cachedUser) return cachedUser;
    const data = dataObject(await run(["auth", "status", "--readonly"], 10_000));
    if (data?.authenticated !== true) return null;
    const userId = string(data.user_id);
    const userName = string(data.user_name);
    if (!userId) return null;
    cachedUser = { id: userId, name: userName };
    return cachedUser;
  };

  return {
    executable: () =>
      external ? Promise.resolve("external") : resolveDwsExecutable({ ...options, environment }),
    async openEvents(input) {
      if (external) return null;
      const executable = await resolveDwsExecutable({ ...options, environment });
      if (!executable) return null;
      const spawnImpl = options.spawnImpl ?? spawn;
      const child = spawnImpl(
        executable,
        [
          "event",
          "consume",
          "user_im_message_receive_o2o_all",
          "user_im_message_receive_group_all",
          "--flatten",
          "-f",
          "ndjson",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: environment,
        },
      );
      let buffer = "";
      let stopped = false;
      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        if (buffer.length > 8 * EVENT_OUTPUT_BYTES) {
          buffer = buffer.slice(-EVENT_OUTPUT_BYTES);
        }
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const parsed = parseDwsEventLine(line);
          if (parsed) input.onRecord(parsed);
          newline = buffer.indexOf("\n");
        }
      });
      child.on("error", () => {
        if (!stopped) input.onExit?.();
      });
      child.on("close", () => {
        if (!stopped) input.onExit?.();
      });
      return {
        stop() {
          if (stopped) return;
          stopped = true;
          terminate(child);
        },
      };
    },
    async authStatus() {
      const executable = external
        ? "external"
        : await resolveDwsExecutable({ ...options, environment });
      if (!executable) {
        return {
          installed: false,
          authenticated: false,
          userId: null,
          userName: null,
          corpName: null,
          errorCode: "not_installed",
        };
      }
      const result = await run(["auth", "status", "--readonly"], 12_000);
      const data = dataObject(result);
      if ((result.errorCode !== null && result.exitCode !== 0) || !data) {
        return {
          installed: true,
          authenticated: false,
          userId: null,
          userName: null,
          corpName: null,
          errorCode: result.errorCode ?? "auth_failed",
        };
      }
      return {
        installed: true,
        authenticated: data.authenticated === true,
        userId: string(data.user_id) || null,
        userName: string(data.user_name) || null,
        corpName: string(data.corp_name) || null,
        errorCode: data.authenticated === true ? null : "not_logged_in",
      };
    },
    async unreadConversations(count) {
      const result = await run([
        "chat",
        "message",
        "list-unread-conversations",
        "--count",
        String(Math.max(1, Math.min(count, 200))),
      ]);
      return {
        conversations: parseUnreadConversations(result.value),
        errorCode: result.errorCode,
      };
    },
    async conversationInfo(conversationId) {
      const result = await run(["chat", "+conversation-info", "--group", conversationId], 15_000);
      return result.errorCode === null ? parseConversationInfo(result.value) : null;
    },
    async messages(input) {
      const args = [
        "chat",
        "message",
        "list",
        "--group",
        input.conversationId,
        "--limit",
        String(input.limit),
      ];
      if (input.before !== undefined) {
        args.push("--time", formatDwsTime(input.before), "--direction", input.direction ?? "older");
      }
      if (input.pageAll) {
        args.push("--page-all", "--page-limit", "10", "--max-items", String(input.maxItems ?? 300));
      }
      const result = await run(args, 45_000);
      const user = await self();
      return { ...parseMessagesPage(result.value, user?.id ?? null), errorCode: result.errorCode };
    },
    async searchMessages(input) {
      const args = ["chat", "+search-msg"];
      if (input.query) args.push("--query", input.query);
      for (const senderId of input.senderIds ?? []) args.push("--senders", senderId);
      if (input.atMe) args.push("--at-me");
      if (input.days !== undefined) args.push("--days", String(input.days));
      args.push("--limit", String(Math.max(1, Math.min(input.limit, 100))), "--order", "desc");
      const result = await run(args, 35_000);
      const user = await self();
      return {
        messages: parseMessages(result.value, user?.id ?? null),
        errorCode: result.errorCode,
      };
    },
    async send(conversationId, text) {
      const result = await run(
        ["chat", "message", "send", "--conversation-id", conversationId, "--content", text],
        30_000,
      );
      return { ok: result.errorCode === null, errorCode: result.errorCode };
    },
  };
}

export const DINGTALK_EVENT_MAX_LINE_BYTES = EVENT_OUTPUT_BYTES;
