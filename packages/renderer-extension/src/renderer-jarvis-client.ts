import {
  JARVIS_CANDIDATES_METHOD,
  JARVIS_CLASSIFY_METHOD,
  JARVIS_DOWNLOAD_CHUNK_METHOD,
  JARVIS_DOWNLOAD_START_METHOD,
  JARVIS_INSTALL_METHOD,
  JARVIS_INSTALL_UPLOAD_METHOD,
  JARVIS_LOGIN_FORWARD_METHOD,
  JARVIS_LOGIN_START_METHOD,
  JARVIS_LOGIN_STOP_METHOD,
  JARVIS_RANK_METHOD,
  JARVIS_SETTINGS_GET_METHOD,
  JARVIS_SETTINGS_SET_METHOD,
  JARVIS_SETTINGS_TEST_METHOD,
  JARVIS_STATUS_METHOD,
  jarvisCandidatesResultSchema,
  jarvisClassifyResultSchema,
  jarvisDownloadChunkResultSchema,
  jarvisDownloadStartResultSchema,
  jarvisInstallResultSchema,
  jarvisInstallUploadResultSchema,
  jarvisLoginForwardResultSchema,
  jarvisLoginStartResultSchema,
  jarvisSettingsResultSchema,
  jarvisSettingsTestResultSchema,
  jarvisStatusSchema,
  jarvisSuggestionsResultSchema,
  type JarvisCandidatesResult,
  type JarvisClassifyResult,
  type JarvisInstallResult,
  type JarvisKind,
  type JarvisLoginForwardResult,
  type JarvisLoginStartResult,
  type JarvisRelease,
  type JarvisSettingsResult,
  type JarvisSettingsSetParams,
  type JarvisSettingsTestResult,
  type JarvisStatus,
  type JarvisSuggestionsResult,
} from "@codexhost/shared-contracts";

import type { RendererSettingsLocale } from "./settings/localization.js";

export interface RendererJarvisRequestOptions {
  priority?: "background" | "interactive";
  timeoutMs?: number;
}

export interface RendererJarvisManager {
  sendRequest(
    method: string,
    params: unknown,
    options?: RendererJarvisRequestOptions,
  ): Promise<unknown> | unknown;
}

export interface RendererJarvisRoute {
  hostId: string;
  manager: RendererJarvisManager;
}

export interface RendererJarvisHost {
  hostId: string;
  displayName: string;
  local: boolean;
  reachable: boolean;
}

export interface RendererJarvisClientOptions {
  forHost(hostId: string): RendererJarvisRoute | null;
  listHosts?(): Promise<RendererJarvisHost[]>;
  openExternal?(url: string): void;
}

export interface RendererJarvisInstallProgress {
  phase: "downloading" | "transferring" | "verifying";
  received: number;
  total: number;
}

export interface RendererJarvisLoginSession {
  authUrl: string;
  callbackPort: number;
  forwardId: string | null;
  forwardErrorCode: string | null;
  close(): void;
}

export interface RendererJarvisClient {
  hosts(): Promise<RendererJarvisHost[]>;
  localAvailable(): boolean;
  status(hostId: string): Promise<JarvisStatus>;
  settings(): Promise<JarvisSettingsResult>;
  updateSettings(input: JarvisSettingsSetParams): Promise<JarvisSettingsResult>;
  testSettings(): Promise<JarvisSettingsTestResult>;
  suggest(hostId: string, query: string): Promise<JarvisSuggestionsResult | null>;
  classify(query: string): Promise<JarvisClassifyResult>;
  candidates(hostId: string, kind: JarvisKind, refresh?: boolean): Promise<JarvisCandidatesResult>;
  install(
    hostId: string,
    onProgress?: (progress: RendererJarvisInstallProgress) => void,
  ): Promise<JarvisInstallResult>;
  login(hostId: string): Promise<RendererJarvisLoginSession>;
  stopLogin(session: RendererJarvisLoginSession): void;
}

const LOCALLY_ORCHESTRATED = "local";
const KNOWN_ERROR_CODES = new Set([
  "not_installed",
  "auth_failed",
  "invalid_key",
  "missing_key",
  "unauthorized",
  "timeout",
  "network",
  "local_only",
  "peer_unavailable",
  "forward_failed",
  "slow_download",
  "sha256_mismatch",
  "size_mismatch",
  "release_lookup_failed",
  "install_failed",
  "download_failed",
  "unknown_download",
  "invalid_upload",
  "login_failed",
  "not_logged_in",
  "cli_failed",
  "jarvis_failed",
]);
const CHUNK_BYTES = 512 * 1024;

/** Browser-safe byte length of a base64 payload, without decoding it into a Buffer. */
function base64ByteLength(value: string): number {
  const clean = value.replace(/[\r\n]/gu, "").replace(/=+$/u, "");
  return Math.floor((clean.length * 3) / 4);
}

export function jarvisErrorText(
  code: string | null | undefined,
  locale: RendererSettingsLocale,
): string {
  const zh: Record<string, string> = {
    not_installed: "未安装 jarvis CLI",
    auth_failed: "jarvis CLI 未登录",
    invalid_key: "Gemini API Key 无效",
    missing_key: "尚未配置 Gemini API Key",
    unauthorized: "Gemini API Key 被拒绝",
    timeout: "请求超时",
    network: "网络不可用",
    local_only: "该操作只能在本地 Host 执行",
    peer_unavailable: "找不到该机器的 SSH 配置，无法转发登录回调",
    forward_failed: "无法建立登录回调转发",
    slow_download: "下载速度过慢",
    sha256_mismatch: "安装包校验失败",
    size_mismatch: "安装包大小不符",
    release_lookup_failed: "无法获取 jarvis CLI 版本列表",
    install_failed: "安装失败",
    download_failed: "下载失败",
    unknown_download: "下载已失效，请重试",
    invalid_upload: "上传顺序无效",
    login_failed: "登录未完成",
    not_logged_in: "未登录",
    cli_failed: "jarvis CLI 调用失败",
    jarvis_failed: "Jarvis 请求失败",
  };
  const en: Record<string, string> = {
    not_installed: "jarvis CLI is not installed",
    auth_failed: "jarvis CLI is not signed in",
    invalid_key: "Gemini API key is invalid",
    missing_key: "Gemini API key is not configured",
    unauthorized: "Gemini API key was rejected",
    timeout: "Request timed out",
    network: "Network is unavailable",
    local_only: "This action is available on the local Host only",
    peer_unavailable:
      "No SSH configuration matches that machine, so the login callback cannot be forwarded",
    forward_failed: "The login callback forward could not be established",
    slow_download: "Download is too slow",
    sha256_mismatch: "Installer checksum verification failed",
    size_mismatch: "Installer size does not match",
    release_lookup_failed: "Could not read the jarvis CLI release list",
    install_failed: "Installation failed",
    download_failed: "Download failed",
    unknown_download: "The download expired; try again",
    invalid_upload: "Upload order is invalid",
    login_failed: "Sign-in did not complete",
    not_logged_in: "Not signed in",
    cli_failed: "jarvis CLI call failed",
    jarvis_failed: "Jarvis request failed",
  };
  const table = locale === "zh-CN" ? zh : en;
  return (
    (code && table[code]) || (locale === "zh-CN" ? "Jarvis 操作失败" : "Jarvis request failed")
  );
}

/** RPC error messages carry a stable code from the Host; localize it in the UI. */
export function jarvisCodeFromError(error: unknown): string {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? (error as { message?: unknown }).message
      : undefined;
  if (typeof message === "string" && KNOWN_ERROR_CODES.has(message)) return message;
  return "jarvis_failed";
}

export function createRendererJarvisClient(
  options: RendererJarvisClientOptions,
): RendererJarvisClient {
  const route = (hostId: string): RendererJarvisRoute | null => {
    try {
      return options.forHost(hostId);
    } catch {
      return null;
    }
  };
  const request = async <T>(
    hostId: string,
    method: string,
    params: unknown,
    schema: { parse(value: unknown): T },
    requestOptions: RendererJarvisRequestOptions,
    missing: T,
  ): Promise<T> => {
    const target = route(hostId);
    if (!target) return missing;
    try {
      return schema.parse(await target.manager.sendRequest(method, params, requestOptions));
    } catch {
      return missing;
    }
  };
  const requireRoute = (hostId: string): RendererJarvisRoute => {
    const target = route(hostId);
    if (!target) throw new Error("Host connection is unavailable");
    return target;
  };

  const client: RendererJarvisClient = {
    async hosts() {
      if (options.listHosts) return await options.listHosts();
      return [{ hostId: "local", displayName: "Local", local: true, reachable: true }];
    },
    localAvailable: () => route("local") !== null,
    async status(hostId) {
      const target = route(hostId);
      if (!target) {
        return {
          installed: false,
          version: null,
          platform: null,
          authenticated: false,
          userName: null,
          userId: null,
          errorCode: "unreachable",
        };
      }
      return await request(
        hostId,
        JARVIS_STATUS_METHOD,
        {},
        jarvisStatusSchema,
        { priority: "interactive", timeoutMs: 20_000 },
        {
          installed: false,
          version: null,
          platform: null,
          authenticated: false,
          userName: null,
          userId: null,
          errorCode: "unreachable",
        },
      );
    },
    async settings() {
      return await request(
        "local",
        JARVIS_SETTINGS_GET_METHOD,
        {},
        jarvisSettingsResultSchema,
        { priority: "interactive", timeoutMs: 5_000 },
        { hasKey: false, threshold: 0.5 },
      );
    },
    async updateSettings(input) {
      const target = requireRoute("local");
      return jarvisSettingsResultSchema.parse(
        await target.manager.sendRequest(JARVIS_SETTINGS_SET_METHOD, input, {
          priority: "interactive",
          timeoutMs: 5_000,
        }),
      );
    },
    async testSettings() {
      const target = requireRoute("local");
      return jarvisSettingsTestResultSchema.parse(
        await target.manager.sendRequest(
          JARVIS_SETTINGS_TEST_METHOD,
          {},
          {
            priority: "interactive",
            timeoutMs: 15_000,
          },
        ),
      );
    },
    async classify(query) {
      const missing: JarvisClassifyResult = {
        available: false,
        isJarvis: false,
        kind: "none",
        confidence: 0,
      };
      return await request(
        "local",
        JARVIS_CLASSIFY_METHOD,
        { query },
        jarvisClassifyResultSchema,
        { priority: "interactive", timeoutMs: 12_000 },
        missing,
      );
    },
    async candidates(hostId, kind, refresh = false) {
      const missing: JarvisCandidatesResult = {
        available: false,
        candidates: [],
        user: null,
        fetchedAt: null,
      };
      return await request(
        hostId,
        JARVIS_CANDIDATES_METHOD,
        { kind, ...(refresh ? { refresh: true } : {}) },
        jarvisCandidatesResultSchema,
        { priority: "interactive", timeoutMs: 90_000 },
        missing,
      );
    },
    async suggest(hostId, query) {
      const classified = await client.classify(query);
      if (!classified.available || !classified.isJarvis || classified.kind === "none") return null;
      const pool = await client.candidates(hostId, classified.kind);
      if (!pool.available || pool.candidates.length === 0) return null;
      const missing: JarvisSuggestionsResult = { available: false, suggestions: [] };
      return await request(
        "local",
        JARVIS_RANK_METHOD,
        {
          query,
          kind: classified.kind,
          candidates: pool.candidates.slice(0, 200),
          user: pool.user,
        },
        jarvisSuggestionsResultSchema,
        { priority: "interactive", timeoutMs: 15_000 },
        missing,
      );
    },
    async install(hostId, onProgress) {
      const target = requireRoute(hostId);
      const first = jarvisInstallResultSchema.parse(
        await target.manager.sendRequest(
          JARVIS_INSTALL_METHOD,
          { mode: "auto" },
          {
            priority: "interactive",
            timeoutMs: 180_000,
          },
        ),
      );
      if (first.state !== "relay-required") return first;
      return await relayInstall(target, first.release, onProgress);
    },
    async login(hostId) {
      const target = requireRoute(hostId);
      const started: JarvisLoginStartResult = jarvisLoginStartResultSchema.parse(
        await target.manager.sendRequest(
          JARVIS_LOGIN_START_METHOD,
          {},
          {
            priority: "interactive",
            timeoutMs: 20_000,
          },
        ),
      );
      let forward: JarvisLoginForwardResult | null = null;
      if (hostId !== LOCALLY_ORCHESTRATED) {
        forward = await request(
          "local",
          JARVIS_LOGIN_FORWARD_METHOD,
          { targetHostId: hostId, callbackPort: started.callbackPort, authUrl: started.authUrl },
          jarvisLoginForwardResultSchema,
          { priority: "interactive", timeoutMs: 15_000 },
          {
            forwarded: false,
            authUrl: started.authUrl,
            forwardId: null,
            errorCode: "forward_failed",
          },
        );
      }
      const authUrl = forward?.authUrl ?? started.authUrl;
      options.openExternal?.(authUrl);
      return {
        authUrl,
        callbackPort: started.callbackPort,
        forwardId: forward?.forwardId ?? null,
        forwardErrorCode: forward?.errorCode ?? null,
        close: () => {
          if (!forward?.forwardId) return;
          void Promise.resolve(
            route("local")?.manager.sendRequest(
              JARVIS_LOGIN_STOP_METHOD,
              { forwardId: forward?.forwardId },
              { priority: "background", timeoutMs: 5_000 },
            ),
          ).catch(() => undefined);
        },
      };
    },
    stopLogin(session) {
      session.close();
    },
  };
  return client;

  async function relayInstall(
    target: RendererJarvisRoute,
    release: JarvisRelease,
    onProgress?: (progress: RendererJarvisInstallProgress) => void,
  ): Promise<JarvisInstallResult> {
    const local = requireRoute("local");
    const download = jarvisDownloadStartResultSchema.parse(
      await local.manager.sendRequest(
        JARVIS_DOWNLOAD_START_METHOD,
        { release },
        {
          priority: "interactive",
          timeoutMs: 300_000,
        },
      ),
    );
    let offset = 0;
    let index = 0;
    while (offset < download.size) {
      const chunk = jarvisDownloadChunkResultSchema.parse(
        await local.manager.sendRequest(
          JARVIS_DOWNLOAD_CHUNK_METHOD,
          { token: download.token, offset, length: CHUNK_BYTES },
          { priority: "background", timeoutMs: 30_000 },
        ),
      );
      const received = base64ByteLength(chunk.data);
      const uploaded = jarvisInstallUploadResultSchema.parse(
        await target.manager.sendRequest(
          JARVIS_INSTALL_UPLOAD_METHOD,
          {
            uploadId: download.token,
            index,
            data: chunk.data,
            totalSize: download.size,
            sha256: release.sha256,
            version: release.version,
            platform: release.platform,
          },
          { priority: "background", timeoutMs: 60_000 },
        ),
      );
      offset += received;
      index += 1;
      onProgress?.({ phase: "transferring", received: offset, total: download.size });
      if (uploaded.state === "installed") {
        const status = uploaded.status ?? (await client.status(target.hostId));
        return { state: "installed", status };
      }
      if (received === 0) break;
    }
    return { state: "failed", errorCode: "install_failed" };
  }
}
