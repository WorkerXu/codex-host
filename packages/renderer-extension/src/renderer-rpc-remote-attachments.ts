type Method = (...args: unknown[]) => unknown;
type Rpc = Record<PropertyKey, unknown>;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const invoke = (target: Rpc, name: string, ...args: unknown[]) =>
  Reflect.apply(Reflect.get(target, name) as Method, target, args);

const ABSOLUTE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const CONTEXT_HEADING = /^\s*# Files mentioned by the user:[ \t]*(?:\r?\n|$)/u;
const REQUEST_HEADING = /(?:^|\n)## My request:[ \t]*(?:\r?\n|$)/u;
/** `## <label>: <absolute path>`, optionally followed by Desktop's ` (lines a-b)` range. */
const ENTRY =
  /^## [^\r\n]*?: ((?:\/|[A-Za-z]:[\\/]|\\\\)[^\r\n]*?)(?: \(lines? \d+(?:-\d+)?\))?\r?$/gmu;

function filePath(value: unknown): value is string {
  return typeof value === "string" && ABSOLUTE.test(value) && !CONTROL.test(value);
}

/** Absolute paths in Desktop's attachment context (images and files), before the request. */
export function attachmentContextPaths(text: string): string[] {
  if (!CONTEXT_HEADING.test(text)) return [];
  const end = text.search(REQUEST_HEADING);
  const context = end < 0 ? text : text.slice(0, end);
  return [...context.matchAll(ENTRY)].map((match) => match[1] ?? "").filter(filePath);
}

function inputPaths(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const paths: string[] = [];
  for (const item of input) {
    if (!record(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      paths.push(...attachmentContextPaths(item.text));
    } else if (item.type === "localImage" && filePath(item.path)) {
      paths.push(item.path);
    }
  }
  return paths;
}

function rewriteContext(text: string, paths: ReadonlyMap<string, string>): string {
  if (!CONTEXT_HEADING.test(text)) return text;
  const end = text.search(REQUEST_HEADING);
  const context = end < 0 ? text : text.slice(0, end);
  const rewritten = context.replace(ENTRY, (line: string, path: string) => {
    const remote = paths.get(path);
    return remote ? line.replace(`: ${path}`, `: ${remote}`) : line;
  });
  return end < 0 ? rewritten : rewritten + text.slice(end);
}

function rewriteInput(input: unknown, paths: ReadonlyMap<string, string>): unknown {
  if (!Array.isArray(input) || paths.size === 0) return input;
  return input.map((item) => {
    if (!record(item)) return item;
    if (item.type === "text" && typeof item.text === "string") {
      const text = rewriteContext(item.text, paths);
      return text === item.text ? item : { ...item, text };
    }
    if (item.type === "localImage" && typeof item.path === "string") {
      const remote = paths.get(item.path);
      return remote ? { ...item, path: remote } : item;
    }
    return item;
  });
}

/** One sendMessage prepares in "steer" then "start" mode; upload each file once per submission. */
export type RemoteAttachmentUploads = Map<string, Promise<string | null>>;

/**
 * Codex Desktop sends attachment paths of the machine it runs on. A native remote Thread copies
 * them at attach time, but an external codexhost Thread on a remote Host can still carry local
 * paths (images and files) its Harness cannot read. Before submission, copy every local path in
 * the prepared input through the Manager's native `uploadLocalFileAttachments` (the same copy
 * native remote Threads use) and point the input at the remote copy. A path the native upload
 * cannot read here is already a Host path and stays unchanged. Official Threads are untouched.
 */
export async function uploadPreparedRemoteAttachments(
  rpc: Rpc,
  hostId: string,
  prepared: Record<string, unknown>,
  uploads: RemoteAttachmentUploads,
  current: () => void,
): Promise<Record<string, unknown>> {
  if (hostId === "local" || typeof prepared.conversationId !== "string") return prepared;
  const steer = record(prepared.steer) ? prepared.steer : null;
  const start = record(prepared.start) && record(prepared.start.request) ? prepared.start : null;
  const startInput = start && record(start.request) ? start.request.input : undefined;
  const paths = [...new Set([...inputPaths(steer?.input), ...inputPaths(startInput)])];
  if (paths.length === 0) return prepared;
  try {
    const conversation: unknown = await invoke(rpc, "getConversation", prepared.conversationId);
    if (!record(conversation) || conversation.modelProvider !== "codexhost") return prepared;
  } catch {
    return prepared;
  }
  current();
  const replacements = new Map<string, string>();
  for (const path of paths) {
    let upload = uploads.get(path);
    if (!upload) {
      upload = (async () => {
        try {
          const saved: unknown = await invoke(rpc, "uploadLocalFileAttachments", {
            attachments: [
              { label: path.split(/[\\/]/u).at(-1) || "attachment", path, fsPath: path },
            ],
            allowSftpUpload: true,
          });
          const first: unknown = Array.isArray(saved) ? saved[0] : undefined;
          const remote = record(first) ? (first.path ?? first.fsPath) : undefined;
          return filePath(remote) && remote !== path ? remote : null;
        } catch {
          return null;
        }
      })();
      uploads.set(path, upload);
    }
    const remote = await upload;
    current();
    if (remote) replacements.set(path, remote);
  }
  if (replacements.size === 0) return prepared;
  return {
    ...prepared,
    ...(steer ? { steer: { ...steer, input: rewriteInput(steer.input, replacements) } } : {}),
    ...(start && record(start.request)
      ? {
          start: {
            ...start,
            request: { ...start.request, input: rewriteInput(start.request.input, replacements) },
          },
        }
      : {}),
  };
}
