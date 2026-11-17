import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  DingTalkConversation,
  DingTalkMember,
  DingTalkMessage,
} from "@codexhost/shared-contracts";

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
  /** Working directory for commands that must write inside it (media download). */
  cwd?: string;
  /** Runs on the configured DingTalk Host instead of the local CLI. */
  runImpl?: (args: readonly string[], timeoutMs: number) => Promise<DwsResult>;
  /** Opens the event stream on a peer; null means this Host is local. */
  openEventsImpl?: (input: {
    onRecord(record: DwsEventRecord): void;
    onExit?(): void;
  }) => Promise<DingTalkEventStream | null>;
}

export interface DwsEventRecord {
  messageId: string;
  conversationId: string;
  senderName: string;
  /** Sender openDingTalkId when dws provides it. */
  senderId?: string;
  text: string;
  createdAt: number;
  kind: "group" | "direct";
  atMe: boolean;
  atAll: boolean;
  senderUserId?: string;
  conversationTitle?: string;
  bot?: boolean;
  mine?: boolean;
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
      ...(options.cwd ? { cwd: options.cwd } : {}),
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
  if (
    value.errorCode !== undefined &&
    value.errorCode !== null &&
    value.errorCode !== 0 &&
    value.errorCode !== "0"
  ) {
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
    errorCode: raw.timedOut
      ? "timeout"
      : raw.exitCode === null
        ? "cli_failed"
        : (failure.code ?? (raw.exitCode === 0 ? null : "cli_failed")),
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

/** `dws chat search --query` → group rows with type and member count. */
export function parseGroupSearch(value: unknown): DingTalkConversation[] {
  const root = record(value) ? value : null;
  const result = root && record(root.result) ? root.result : null;
  const rows = result && Array.isArray(result.groups) ? result.groups : [];
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
      singleChat: false,
      unreadCount: 0,
      lastMessageAt: parseDwsTime(row.createAt),
      muted: false,
      groupType: string(row.groupType) || null,
      memberCount: number(row.memberCount),
    });
  }
  return conversations;
}

export interface DingTalkPerson {
  name: string;
  title: string;
  userId: string;
  openDingTalkId: string;
}

/** `dws contact user search --query` → people; each resolves to one direct chat. */
export function parsePersonSearch(value: unknown): DingTalkPerson[] {
  const root = record(value) ? value : null;
  const rows = root && Array.isArray(root.result) ? root.result : [];
  const people: DingTalkPerson[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!record(row)) continue;
    const openDingTalkId = string(row.openDingTalkId);
    const name = string(row.name) || string(row.nick);
    if (!openDingTalkId || !name || seen.has(openDingTalkId)) continue;
    seen.add(openDingTalkId);
    people.push({
      name,
      title: string(row.title),
      userId: string(row.userId),
      openDingTalkId,
    });
  }
  return people;
}

export interface DingTalkGroupMeta {
  title: string;
  groupType: string | null;
  memberCount: number | null;
}

/** `dws chat +chat-members-list` → human members, de-duplicated by open id. */
export function parseMembers(value: unknown): DingTalkMember[] {
  const root = record(value) ? value : null;
  const rows = root && Array.isArray(root.users) ? root.users : [];
  const members: DingTalkMember[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!record(row)) continue;
    const openDingTalkId = string(row.openDingtalkId) || string(row.openDingTalkId);
    const name =
      string(row.memberEmpName) || string(row.name) || string(row.memberNick) || string(row.nick);
    if (!openDingTalkId || !name || seen.has(openDingTalkId)) continue;
    seen.add(openDingTalkId);
    const title = string(row.memberRoleDesc) || string(row.role) || string(row.title);
    members.push({
      openDingTalkId,
      name,
      ...(title ? { title } : {}),
    });
  }
  return members;
} /** `dws chat group list-all` → group metadata keyed by conversation id. */
export function parseGroupDirectory(value: unknown): Map<string, DingTalkGroupMeta> {
  const root = record(value) ? value : null;
  const result = root && record(root.result) ? root.result : null;
  const rows = result && Array.isArray(result.groups) ? result.groups : [];
  const directory = new Map<string, DingTalkGroupMeta>();
  for (const row of rows) {
    if (!record(row)) continue;
    const conversationId = string(row.openConversationId);
    if (!conversationId) continue;
    directory.set(conversationId, {
      title: string(row.title),
      groupType: string(row.groupType) || null,
      memberCount: number(row.memberCount),
    });
  }
  return directory;
}

export interface DingTalkAtMeHit {
  conversationId: string;
  createdAt: number | null;
}

/** `dws chat +at-me` → conversation ids with their newest mention time. */
export function parseAtMeHits(value: unknown): DingTalkAtMeHit[] {
  const root = record(value) ? value : null;
  const rows = root && Array.isArray(root.items) ? root.items : [];
  const hits: DingTalkAtMeHit[] = [];
  for (const row of rows) {
    if (!record(row)) continue;
    const conversationId = string(row.conversationId);
    if (!conversationId) continue;
    hits.push({ conversationId, createdAt: parseDwsTime(row.time) });
  }
  return hits;
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
    memberCount: number(info.memberCount),
    groupType: string(info.groupType) || null,
  };
}

const IMAGE_CONTENT_PATTERN = /<imageContent>[\s\S]*?<\/imageContent>/giu;
const MEDIA_MARKER_PATTERN =
  /\[(?:图片消息|语音消息|视频消息|表情|链接|卡片消息|合并转发|文件)\]\s*(?:\([^)\n]*\)|fileId:\s*\S+)?/giu;
const MEDIA_ID_PATTERN = /(?:mediaId|fileId)\s*[=:]\s*[^\s,，;；)）\]】]+/giu;
const HTML_TAG_PATTERN = /<\/?[a-zA-Z][^>]*>/gu;
const LEADING_CARD_MARKER = /^\s*(?:\[卡片\]|\[卡片消息\])\s*/u;

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/&amp;/giu, "&");
}

/** Remove media markers, `<imageContent>` blocks and raw resource ids. */
export function sanitizeDingTalkText(text: string): string {
  return decodeEntities(
    text
      .replace(IMAGE_CONTENT_PATTERN, "\n")
      .replace(MEDIA_MARKER_PATTERN, "")
      .replace(MEDIA_ID_PATTERN, "")
      .replace(/图片内容[:：]/gu, "")
      .replace(HTML_TAG_PATTERN, "")
      .replace(/\r\n?/gu, "\n"),
  )
    .replace(LEADING_CARD_MARKER, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function looksLikeMarkdown(text: string): boolean {
  return (
    /(^|\n)\s{0,3}(#{1,6}\s|>\s?|[-*]\s|\d+\.\s|---|___)/u.test(text) ||
    /\*\*[^*\n]+\*\*/u.test(text) ||
    /\[[^\]\n]+\]\([^)\n]+\)/u.test(text)
  );
}

function plainTitle(text: string): string {
  return text
    .replace(/^[#>\s]+/u, "")
    .replace(/\*\*(.+?)\*\*/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .trim()
    .slice(0, 160);
}

export interface DingTalkMessageBody {
  text: string;
  cardTitle: string | null;
  format: "text" | "markdown";
}

/** Turn one raw dws body into renderable text, separating a card title. */
export function parseMessageBody(rawText: string): DingTalkMessageBody {
  const text = sanitizeDingTalkText(rawText);
  if (!text) return { text: "", cardTitle: null, format: "text" };
  const cardish = /<imageContent>/iu.test(rawText) || /^\s*(?:\[卡片|【)/u.test(text);
  if (!cardish && !looksLikeMarkdown(text)) {
    return { text, cardTitle: null, format: "text" };
  }
  if (!looksLikeMarkdown(text)) {
    return { text, cardTitle: null, format: "text" };
  }
  const lines = text.split("\n");
  const first = lines[0]?.trim() ?? "";
  const title = cardish && first && !/^[-*>#\d]|\[[^\]]+\]\(/u.test(first) ? plainTitle(first) : "";
  const body = title ? lines.slice(1).join("\n").trimStart() : text;
  return { text: body || text, cardTitle: title || null, format: "markdown" };
}

function parseQuoted(value: unknown): DingTalkMessage["quotedMessage"] | undefined {
  if (!record(value)) return undefined;
  const senderName = string(value.sender) || "未知成员";
  const text = sanitizeDingTalkText(string(value.content) || string(value.text));
  const messageId = string(value.openMessageId) || string(value.messageId);
  const createdAt = parseDwsTime(value.createTime);
  if (!text && !messageId) return undefined;
  return {
    senderName,
    text,
    ...(messageId ? { messageId } : {}),
    ...(createdAt !== null ? { createdAt } : {}),
  };
}

function parseReactions(row: Record<string, unknown>): DingTalkMessage["reactions"] {
  const parsed: { emoji: string; count: number }[] = [];
  const seen = new Set<string>();
  const reactions = record(row.reactions) ? row.reactions : null;
  const counts = reactions && Array.isArray(reactions.counts) ? reactions.counts : [];
  for (const item of counts) {
    if (!record(item)) continue;
    const emoji = string(item.emoji);
    const count = Math.floor(number(item.count) ?? 0);
    if (!emoji || count <= 0 || seen.has(emoji)) continue;
    seen.add(emoji);
    parsed.push({ emoji, count });
  }
  if (parsed.length === 0 && Array.isArray(row.emotionReplyList)) {
    const grouped = new Map<string, number>();
    for (const item of row.emotionReplyList) {
      if (!record(item)) continue;
      const emoji = string(item.emoji);
      if (!emoji) continue;
      const users = Array.isArray(item.replyUsers) ? item.replyUsers.length : 0;
      grouped.set(emoji, (grouped.get(emoji) ?? 0) + Math.max(1, users));
    }
    for (const [emoji, count] of grouped) parsed.push({ emoji, count });
  }
  return parsed.length > 0 ? parsed : undefined;
}

function parseResources(
  row: Record<string, unknown>,
  rawText: string,
): DingTalkMessage["resources"] {
  const refs = (Array.isArray(row.resourceRefs) ? row.resourceRefs : []).filter(
    (ref): ref is Record<string, unknown> => record(ref),
  );
  const hasImageMarker = /\[图片消息\]/u.test(rawText);
  const hasTypedImage = refs.some((ref) => string(ref.contentType).toLowerCase() === "image");
  const resources: NonNullable<DingTalkMessage["resources"]> = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const resourceId = string(ref.resourceId);
    const contentType = string(ref.contentType).toLowerCase();
    const type = string(ref.type) || string(ref.resourceIdType);
    const resourceIdType = string(ref.resourceIdType) || type;
    if (!resourceId || !resourceIdType || seen.has(resourceId)) continue;
    const file = contentType === "file" || resourceIdType === "fileId" || type === "fileId";
    // Some images also list an untyped thumbnail first. Prefer the typed image
    // resources; fall back to media ids only when the body carries an image.
    const image =
      !file &&
      (contentType === "image" || (type === "mediaId" && hasImageMarker && !hasTypedImage));
    if (!file && !image) continue;
    seen.add(resourceId);
    const name = string(ref.name) || null;
    const sizeBytes = number(ref.sizeBytes) ?? number(ref.size) ?? number(ref.fileSize);
    resources.push({
      kind: file ? "file" : "image",
      ...(name ? { name } : {}),
      ...(sizeBytes !== null ? { sizeBytes } : {}),
      resourceId,
      resourceIdType,
    });
  }
  return resources.length > 0 ? resources : undefined;
}

type SelfIdentity = string | readonly string[] | null;
type SelfUser = { id: string; name: string; openId?: string };

function messageFromRow(
  row: Record<string, unknown>,
  selfId: SelfIdentity,
): DingTalkMessage | null {
  const messageId = string(row.messageId) || string(row.openMessageId);
  const conversationId = string(row.conversationId) || string(row.openConversationId);
  if (!messageId || !conversationId) return null;
  const rawText = string(row.text) || string(row.content);
  const resources = parseResources(row, rawText);
  let body = parseMessageBody(rawText);
  if (resources && resources.some(({ kind }) => kind === "file")) {
    const fileNames = new Set(resources.flatMap(({ name }) => (name ? [name] : [])));
    if (fileNames.has(body.text.trim())) {
      body = { text: "", cardTitle: null, format: "text" };
    }
  }
  const senderId = string(row.senderId) || string(row.senderOpenDingTalkId);
  const quotedMessage = parseQuoted(row.quotedMessage);
  const reactions = parseReactions(row);
  return {
    messageId,
    conversationId,
    senderName: string(row.sender) || "未知成员",
    ...(senderId ? { senderId } : {}),
    createdAt: parseDwsTime(row.createTime) ?? parseDwsTime(row.time) ?? 0,
    text: body.text,
    unsupported: body.text.length === 0 && !resources,
    mine: (typeof selfId === "string" ? [selfId] : (selfId ?? [])).some((id) =>
      [senderId, string(row.senderUserId), string(row.senderOpenDingTalkId)].includes(id),
    ),
    ...(quotedMessage ? { quotedMessage } : {}),
    ...(reactions ? { reactions } : {}),
    ...(resources ? { resources } : {}),
    ...(row.sendType === "bot" ? { bot: true } : {}),
    ...(body.cardTitle ? { cardTitle: body.cardTitle } : {}),
    ...(body.format === "markdown" ? { format: "markdown" as const } : {}),
  };
}

/** `dws chat message list` / `+search-msg` → message rows, newest first. */
export function parseMessages(value: unknown, selfId: SelfIdentity): DingTalkMessage[] {
  if (!record(value)) return [];
  const rows = Array.isArray(value.messages) ? value.messages : [];
  const messages = rows
    .filter((row): row is Record<string, unknown> => record(row))
    .map((row) => messageFromRow(row, selfId))
    .filter((message): message is DingTalkMessage => message !== null)
    .sort((left, right) => right.createdAt - left.createdAt);
  return [...new Map(messages.map((message) => [message.messageId, message])).values()];
}

export interface MessagesPage {
  messages: DingTalkMessage[];
  hasMore: boolean;
  nextCursor: number | null;
}

export function parseMessagesPage(value: unknown, selfId: SelfIdentity): MessagesPage {
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
  let data: unknown = value.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const payload = record(value.payload) ? value.payload : record(data) ? data : value;
  const messageId = string(payload.message_id) || string(payload.messageId);
  const conversationId = string(payload.conversation_id) || string(payload.conversationId);
  if (!messageId || !conversationId) return null;
  const senderId = string(payload.sender_open_dingtalk_id) || string(payload.senderId);
  const eventTime = parseDwsTime(payload.create_time) ?? parseDwsTime(payload.event_time);
  const text = string(payload.content) || string(payload.text);
  const eventType = string(payload.type) || string(value.event_type) || string(value.type);
  if (!eventType.startsWith("user_im_message_receive_")) return null;
  return {
    messageId,
    conversationId,
    senderName: string(payload.sender) || "未知成员",
    ...(senderId ? { senderId } : {}),
    text,
    createdAt: eventTime ?? parseDwsTime(payload.timestamp) ?? 0,
    kind: eventType.includes("o2o") ? "direct" : "group",
    ...(string(payload.sender_user_id) ? { senderUserId: string(payload.sender_user_id) } : {}),
    ...(string(payload.conversation_title)
      ? { conversationTitle: string(payload.conversation_title) }
      : {}),
    ...(payload.sendType === "bot" || payload.sender_type === "bot" ? { bot: true } : {}),
    ...(payload.mine === true ? { mine: true } : {}),
    atMe: payload.at_me === true,
    atAll: /@所有人|<@all>/iu.test(text),
  };
}

export interface DingTalkEventStream {
  stop(): void;
}

export interface DingTalkPendingApproval {
  taskId: string;
  processInstanceId: string;
  title: string;
  originatorName: string;
  originatorId: string | null;
  formMessage: string;
  createdAt: number;
  url: string | null;
}

export type DingTalkCardTarget = { group: string } | { openDingTalkId: string };

export interface DingTalkCardInput {
  target: DingTalkCardTarget;
  content: string;
  flowStatus: 1 | 2 | 3 | 4 | 5;
  atOpenDingTalkIds?: readonly string[];
  atAll?: boolean;
}

export interface DingTalkCardResult {
  ok: boolean;
  bizId: string | null;
  errorCode: string | null;
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
  searchGroups(
    query: string,
  ): Promise<{ conversations: DingTalkConversation[]; errorCode: string | null }>;
  searchPeople(query: string): Promise<{ people: DingTalkPerson[]; errorCode: string | null }>;
  groupDirectory(): Promise<{
    directory: Map<string, DingTalkGroupMeta> | null;
    errorCode: string | null;
  }>;
  atMeHits(
    days: number,
    limit: number,
  ): Promise<{ hits: DingTalkAtMeHit[]; errorCode: string | null }>;
  conversationInfo(conversationId: string): Promise<DingTalkConversation | null>;
  conversationInfoForUser(openDingTalkId: string): Promise<DingTalkConversation | null>;
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
  members(conversationId: string): Promise<{ members: DingTalkMember[]; errorCode: string | null }>;
  send(
    conversationId: string,
    text: string,
    options?: { atOpenDingTalkIds?: readonly string[]; atAll?: boolean },
  ): Promise<{ ok: boolean; messageId?: string | null; errorCode: string | null }>;
  sendDirect(
    openDingTalkId: string,
    text: string,
    options?: { atOpenDingTalkIds?: readonly string[]; atAll?: boolean },
  ): Promise<{ ok: boolean; errorCode: string | null }>;
  sendCard(input: DingTalkCardInput): Promise<DingTalkCardResult>;
  updateCard(input: {
    bizId: string;
    content: string;
    flowStatus: 1 | 2 | 3 | 4 | 5;
  }): Promise<{ ok: boolean; errorCode: string | null }>;
  pendingApprovals(limit: number): Promise<{
    approvals: DingTalkPendingApproval[];
    errorCode: string | null;
  }>;
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

function findString(value: unknown, keys: readonly string[], depth = 0): string | null {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const entry = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = entry[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const candidate of Object.values(entry)) {
    const found = findString(candidate, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

export function parsePendingApprovals(value: unknown): DingTalkPendingApproval[] {
  if (!record(value)) return [];
  const result = record(value.result) ? value.result : value;
  const values = Array.isArray(result.values) ? result.values : [];
  const approvals: DingTalkPendingApproval[] = [];
  for (const item of values) {
    if (!record(item)) continue;
    const taskId = string(item.taskId);
    const processInstanceId = string(item.processInstanceId);
    const title = string(item.title);
    if (!taskId || !processInstanceId || !title) continue;
    approvals.push({
      taskId,
      processInstanceId,
      title,
      originatorName: string(item.originatorName) || "未知发起人",
      originatorId: string(item.originatorId),
      formMessage: string(item.formMassage) || string(item.formMessage),
      createdAt: parseDwsTime(item.processCreateTime) ?? 0,
      url: string(item.url),
    });
  }
  return approvals;
}

export function createDingTalkCli(options: DingTalkCliOptions = {}): DingTalkCli {
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const external = options.runImpl;
  let cachedUser: SelfUser | null = null;
  let identityPromise: Promise<SelfUser | null> | null = null;
  let authRead: Promise<DwsResult> | null = null;

  const run = (args: readonly string[], requestTimeoutMs = timeoutMs): Promise<DwsResult> =>
    external
      ? external(args, requestTimeoutMs)
      : runDwsJson(args, {
          ...options,
          environment,
          timeoutMs: requestTimeoutMs,
        });

  const readAuth = (): Promise<DwsResult> => {
    authRead ??= run(["auth", "status", "--readonly"], 12_000).finally(() => {
      authRead = null;
    });
    return authRead;
  };

  const self = (): Promise<SelfUser | null> => {
    if (cachedUser?.openId) return Promise.resolve(cachedUser);
    identityPromise ??= (async () => {
      let user = cachedUser;
      if (!user) {
        const data = dataObject(await readAuth());
        if (data?.authenticated !== true || !string(data.user_id)) return null;
        user = { id: string(data.user_id), name: string(data.user_name) };
      }
      const profile = await run(["contact", "user", "get-self"], 10_000).catch(() => null);
      const rows = profile?.value?.result;
      const org = (Array.isArray(rows) ? rows : [])
        .filter(record)
        .map((row) => row.orgEmployeeModel)
        .find((row) => record(row) && row.userId === user.id);
      const openId = record(org) ? string(org.openDingTalkId) : "";
      if (cachedUser && cachedUser.id !== user.id) return null;
      cachedUser = { ...user, ...(openId ? { openId } : {}) };
      return cachedUser;
    })().finally(() => {
      identityPromise = null;
    });
    return identityPromise;
  };

  return {
    executable: () =>
      external ? Promise.resolve("external") : resolveDwsExecutable({ ...options, environment }),
    async openEvents(input) {
      const remote = await options.openEventsImpl?.(input);
      if (remote) return remote;
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
      const result = await readAuth();
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
      const id = string(data.user_id);
      cachedUser =
        data.authenticated === true && id
          ? { ...(cachedUser?.id === id ? cachedUser : {}), id, name: string(data.user_name) }
          : null;
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
    async searchGroups(query) {
      const result = await run(["chat", "search", "--query", query, "--limit", "20"], 20_000);
      return {
        conversations: parseGroupSearch(result.value),
        errorCode: result.errorCode,
      };
    },
    async searchPeople(query) {
      const result = await run(["contact", "user", "search", "--query", query], 20_000);
      return { people: parsePersonSearch(result.value), errorCode: result.errorCode };
    },
    async groupDirectory() {
      const result = await run(["chat", "group", "list-all", "--limit", "200"], 25_000);
      return {
        directory: result.errorCode === null ? parseGroupDirectory(result.value) : null,
        errorCode: result.errorCode,
      };
    },
    async atMeHits(days, limit) {
      const result = await run(
        ["chat", "+at-me", "--days", String(days), "--limit", String(Math.max(1, limit))],
        20_000,
      );
      return { hits: parseAtMeHits(result.value), errorCode: result.errorCode };
    },
    async conversationInfo(conversationId) {
      const result = await run(["chat", "+conversation-info", "--group", conversationId], 15_000);
      return result.errorCode === null ? parseConversationInfo(result.value) : null;
    },
    async conversationInfoForUser(openDingTalkId) {
      const result = await run(
        ["chat", "+conversation-info", "--open-dingtalk-id", openDingTalkId],
        15_000,
      );
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
      const [result, user] = await Promise.all([run(args, 45_000), self()]);
      return {
        ...parseMessagesPage(
          result.value,
          user ? [user.id, user.openId ?? ""].filter(Boolean) : null,
        ),
        errorCode: result.errorCode,
      };
    },
    async searchMessages(input) {
      const args = ["chat", "+search-msg"];
      if (input.query) args.push("--query", input.query);
      for (const senderId of input.senderIds ?? []) args.push("--senders", senderId);
      if (input.atMe) args.push("--at-me");
      if (input.days !== undefined) args.push("--days", String(input.days));
      args.push("--limit", String(Math.max(1, Math.min(input.limit, 100))), "--order", "desc");
      const [result, user] = await Promise.all([run(args, 35_000), self()]);
      return {
        messages: parseMessages(
          result.value,
          user ? [user.id, user.openId ?? ""].filter(Boolean) : null,
        ),
        errorCode: result.errorCode,
      };
    },
    async members(conversationId) {
      const result = await run(
        [
          "chat",
          "+chat-members-list",
          "--conversation-id",
          conversationId,
          "--member-types",
          "user",
          "--page-limit",
          "20",
        ],
        35_000,
      );
      return { members: parseMembers(result.value), errorCode: result.errorCode };
    },
    async send(conversationId, text, options = {}) {
      const args = [
        "chat",
        "message",
        "send",
        "--conversation-id",
        conversationId,
        "--content",
        text,
        "--yes",
      ];
      const atIds = [...new Set((options.atOpenDingTalkIds ?? []).filter(Boolean))];
      if (atIds.length > 0) args.push("--at-open-dingtalk-ids", atIds.join(","));
      if (options.atAll === true) args.push("--at-all");
      const result = await run(args, 30_000);
      return {
        ok: result.errorCode === null,
        messageId: findString(result.value, ["messageId", "openMessageId"]),
        errorCode: result.errorCode,
      };
    },
    async sendDirect(openDingTalkId, text, options = {}) {
      const args = [
        "chat",
        "message",
        "send",
        "--open-dingtalk-id",
        openDingTalkId,
        "--content",
        text,
        "--yes",
      ];
      const atIds = [...new Set((options.atOpenDingTalkIds ?? []).filter(Boolean))];
      if (atIds.length > 0) args.push("--at-open-dingtalk-ids", atIds.join(","));
      if (options.atAll === true) args.push("--at-all");
      const result = await run(args, 30_000);
      return { ok: result.errorCode === null, errorCode: result.errorCode };
    },
    async sendCard(input) {
      const args = ["chat", "+messages-send-card"];
      if ("group" in input.target) {
        args.push("--group", input.target.group);
        const atIds = [...new Set((input.atOpenDingTalkIds ?? []).filter(Boolean))];
        if (atIds.length > 0) args.push("--at-open-dingtalk-ids", atIds.join(","));
        if (input.atAll === true) args.push("--at-all");
      } else {
        args.push("--receiver-open-dingtalk-id", input.target.openDingTalkId);
      }
      args.push("--content", input.content, "--flow-status", String(input.flowStatus), "--yes");
      const result = await run(args, 30_000);
      return {
        ok: result.errorCode === null,
        bizId: findString(result.value, ["bizId", "biz_id", "bizid"]),
        errorCode: result.errorCode,
      };
    },
    async updateCard(input) {
      const result = await run(
        [
          "chat",
          "+messages-update-card",
          "--biz-id",
          input.bizId,
          "--content",
          input.content,
          "--flow-status",
          String(input.flowStatus),
          "--yes",
        ],
        30_000,
      );
      return { ok: result.errorCode === null, errorCode: result.errorCode };
    },
    async pendingApprovals(limit) {
      const result = await run(
        ["oa", "approval", "list-pending", "--limit", String(limit), "--page", "1"],
        30_000,
      );
      return {
        approvals: result.errorCode === null ? parsePendingApprovals(result.value) : [],
        errorCode: result.errorCode,
      };
    },
  };
}

export const DINGTALK_EVENT_MAX_LINE_BYTES = EVENT_OUTPUT_BYTES;
