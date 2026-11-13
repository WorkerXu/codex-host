import { open, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  jarvisCandidatesResultSchema,
  jarvisClassifyResultSchema,
  jarvisLoginForwardResultSchema,
  jarvisLoginStartResultSchema,
  jarvisSettingsResultSchema,
  jarvisSettingsTestResultSchema,
  jarvisStatusSchema,
  jarvisSuggestionsResultSchema,
  type JarvisCandidatesResult,
  type JarvisClassifyResult,
  type JarvisInstallResult,
  type JarvisInstallUploadParams,
  type JarvisInstallUploadResult,
  type JarvisKind,
  type JarvisLoginForwardParams,
  type JarvisLoginForwardResult,
  type JarvisLoginStartResult,
  type JarvisRankParams,
  type JarvisRelease,
  type JarvisSettingsResult,
  type JarvisSettingsSetParams,
  type JarvisSettingsTestResult,
  type JarvisStatus,
  type JarvisSuggestionsResult,
  type JarvisUser,
} from "@codexhost/shared-contracts";

import { JarvisCandidatePool } from "./jarvis-candidates.js";
import { createJarvisCli, type JarvisCli } from "./jarvis-cli.js";
import { createJarvisDecisions, type JarvisDecisions } from "./jarvis-decisions.js";
import {
  createJarvisArtifactPath,
  detectJarvisPlatform,
  downloadJarvisRelease,
  fetchLatestJarvisRelease,
  installJarvisArtifact,
  JarvisInstallError,
  sha256File,
  verifyJarvisArtifact,
} from "./jarvis-install.js";
import { JarvisLoginError, JarvisLoginForwarder, JarvisLoginManager } from "./jarvis-login.js";
import { expandJarvisMentions } from "./jarvis-mention-rewrite.js";
import { JarvisSettingsStore } from "./jarvis-settings.js";

const DOWNLOAD_TTL_MS = 10 * 60_000;
const CHUNK_BYTES = 1_048_576;

export class JarvisServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JarvisServiceError";
  }
}

export interface JarvisServiceOptions {
  environment?: NodeJS.ProcessEnv;
  /** Desktop-local Host owns the Gemini key and login callback forwarding. */
  isLocalHost: boolean;
  cli?: JarvisCli;
  settings?: JarvisSettingsStore;
  decisions?: JarvisDecisions;
  pool?: JarvisCandidatePool;
  login?: JarvisLoginManager;
  forwarder?: JarvisLoginForwarder;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface DownloadSession {
  release: JarvisRelease;
  path: string;
  createdAt: number;
}

interface UploadSession {
  path: string;
  received: number;
  nextIndex: number;
  totalSize: number;
  sha256: string;
  version: string;
  createdAt: number;
}

export class JarvisService {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #isLocalHost: boolean;
  readonly #cli: JarvisCli;
  readonly #settings: JarvisSettingsStore;
  readonly #decisions: JarvisDecisions;
  readonly #pool: JarvisCandidatePool;
  readonly #login: JarvisLoginManager;
  readonly #forwarder: JarvisLoginForwarder;
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => number;
  readonly #downloads = new Map<string, DownloadSession>();
  readonly #uploads = new Map<string, UploadSession>();

  constructor(options: JarvisServiceOptions) {
    this.#environment = options.environment ?? process.env;
    this.#isLocalHost = options.isLocalHost;
    this.#now = options.now ?? Date.now;
    this.#cli = options.cli ?? createJarvisCli({ environment: this.#environment });
    this.#settings =
      options.settings ?? new JarvisSettingsStore({ environment: this.#environment });
    this.#decisions =
      options.decisions ?? createJarvisDecisions({ readApiKey: () => this.#settings.readKey() });
    this.#pool = options.pool ?? new JarvisCandidatePool({ cli: this.#cli });
    this.#login =
      options.login ??
      new JarvisLoginManager({
        executable: () => this.#cli.executable(),
        environment: this.#environment,
      });
    this.#forwarder =
      options.forwarder ?? new JarvisLoginForwarder({ environment: this.#environment });
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  get isLocalHost(): boolean {
    return this.#isLocalHost;
  }

  async status(): Promise<JarvisStatus> {
    return jarvisStatusSchema.parse(await this.#cli.status());
  }

  async classify(query: string): Promise<JarvisClassifyResult> {
    try {
      const threshold = await this.#settings.readThreshold();
      return jarvisClassifyResultSchema.parse(await this.#decisions.classify(query, threshold));
    } catch {
      return { available: false, isJarvis: false, kind: "none", confidence: 0 };
    }
  }

  async candidates(kind: JarvisKind, refresh = false): Promise<JarvisCandidatesResult> {
    return jarvisCandidatesResultSchema.parse(await this.#pool.get(kind, { refresh }));
  }

  async rank(params: JarvisRankParams): Promise<JarvisSuggestionsResult> {
    try {
      const result = await this.#decisions.rank(
        params.query,
        params.kind,
        params.candidates,
        (params.user as JarvisUser | null | undefined) ?? null,
      );
      return jarvisSuggestionsResultSchema.parse(result);
    } catch {
      return { available: false, suggestions: [] };
    }
  }

  async settings(): Promise<JarvisSettingsResult> {
    this.#requireLocal();
    return jarvisSettingsResultSchema.parse(await this.#settings.read());
  }

  async updateSettings(params: JarvisSettingsSetParams): Promise<JarvisSettingsResult> {
    this.#requireLocal();
    if (params.geminiApiKey !== undefined) {
      const key = params.geminiApiKey?.trim() ?? null;
      if (key !== null && (!key || key.length > 512 || /\s/u.test(key))) {
        throw new JarvisServiceError("invalid_key", "Gemini API key is invalid");
      }
      await this.#settings.writeKey(key);
      this.#decisions.clear();
    }
    if (params.threshold !== undefined) await this.#settings.writeThreshold(params.threshold);
    return jarvisSettingsResultSchema.parse(await this.#settings.read());
  }

  async testSettings(): Promise<JarvisSettingsTestResult> {
    this.#requireLocal();
    return jarvisSettingsTestResultSchema.parse(await this.#decisions.test());
  }

  async install(): Promise<JarvisInstallResult> {
    let release: JarvisRelease;
    try {
      const platform = await this.#platform();
      release = await fetchLatestJarvisRelease({ platform, fetchImpl: this.#fetchImpl });
    } catch (error) {
      return {
        state: "failed",
        errorCode: error instanceof JarvisInstallError ? error.code : "release_lookup_failed",
      };
    }
    let artifact: string | null = null;
    try {
      artifact = await createJarvisArtifactPath(this.#environment);
      await downloadJarvisRelease({
        release,
        destination: artifact,
        fetchImpl: this.#fetchImpl,
      });
      await verifyJarvisArtifact(artifact, release);
      await installJarvisArtifact({ artifact, environment: this.#environment });
      artifact = null;
      return { state: "installed", status: await this.status() };
    } catch (error) {
      const slow = error instanceof JarvisInstallError && error.code === "slow_download";
      return slow
        ? { state: "relay-required", release, reason: "slow" }
        : {
            state: "failed",
            errorCode: error instanceof JarvisInstallError ? error.code : "install_failed",
          };
    } finally {
      if (artifact) await rm(artifact, { force: true }).catch(() => undefined);
    }
  }

  /** Download on this Host so a slow target can receive verified bytes. */
  async startDownload(release: JarvisRelease): Promise<{ token: string; size: number }> {
    this.#requireLocal("download");
    this.#pruneDownloads();
    const artifact = await createJarvisArtifactPath(this.#environment);
    try {
      await downloadJarvisRelease({
        release,
        destination: artifact,
        fetchImpl: this.#fetchImpl,
      });
      await verifyJarvisArtifact(artifact, release);
    } catch (error) {
      await rm(artifact, { force: true }).catch(() => undefined);
      throw error instanceof JarvisInstallError
        ? new JarvisServiceError(error.code, error.message)
        : new JarvisServiceError("download_failed", "Jarvis CLI download failed");
    }
    const token = randomUUID();
    this.#downloads.set(token, { release, path: artifact, createdAt: this.#now() });
    return { token, size: release.size };
  }

  async downloadChunk(
    token: string,
    offset: number,
    length: number,
  ): Promise<{ data: string; eof: boolean }> {
    this.#requireLocal("download");
    const session = this.#downloads.get(token);
    if (!session) throw new JarvisServiceError("unknown_download", "Download is unavailable");
    if (length > CHUNK_BYTES) throw new JarvisServiceError("chunk_too_large", "Chunk is too large");
    const size = (await stat(session.path)).size;
    if (offset >= size) return { data: "", eof: true };
    const read = Math.min(length, size - offset);
    const handle = await open(session.path, "r");
    try {
      const buffer = Buffer.allocUnsafe(read);
      const { bytesRead } = await handle.read(buffer, 0, read, offset);
      return {
        data: buffer.subarray(0, bytesRead).toString("base64"),
        eof: offset + bytesRead >= size,
      };
    } finally {
      await handle.close();
    }
  }

  async uploadChunk(params: JarvisInstallUploadParams): Promise<JarvisInstallUploadResult> {
    this.#pruneUploads();
    const data = Buffer.from(params.data, "base64");
    let session = this.#uploads.get(params.uploadId);
    if (!session) {
      if (params.index !== 0)
        throw new JarvisServiceError("invalid_upload", "Upload order is invalid");
      session = {
        path: await createJarvisArtifactPath(this.#environment),
        received: 0,
        nextIndex: 0,
        totalSize: params.totalSize,
        sha256: params.sha256,
        version: params.version,
        createdAt: this.#now(),
      };
      this.#uploads.set(params.uploadId, session);
    }
    if (params.index !== session.nextIndex) {
      throw new JarvisServiceError("invalid_upload", "Upload order is invalid");
    }
    if (session.received + data.byteLength > session.totalSize) {
      throw new JarvisServiceError("invalid_upload", "Upload is larger than expected");
    }
    const handle = await open(session.path, "a");
    try {
      await handle.write(data);
    } finally {
      await handle.close();
    }
    session.received += data.byteLength;
    session.nextIndex += 1;
    if (session.received < session.totalSize) {
      return { state: "uploading", received: session.received };
    }
    if ((await sha256File(session.path)) !== session.sha256) {
      await this.#discardUpload(params.uploadId);
      throw new JarvisServiceError(
        "sha256_mismatch",
        "Uploaded Jarvis CLI checksum does not match",
      );
    }
    try {
      await installJarvisArtifact({ artifact: session.path, environment: this.#environment });
    } finally {
      this.#uploads.delete(params.uploadId);
    }
    return { state: "installed", received: session.received, status: await this.status() };
  }

  async startLogin(): Promise<JarvisLoginStartResult> {
    const result = await this.#login.start().catch((error: unknown) => {
      throw error instanceof JarvisLoginError
        ? new JarvisServiceError(error.code, error.message)
        : new JarvisServiceError("login_failed", "jarvis login failed");
    });
    return jarvisLoginStartResultSchema.parse(result);
  }

  async forwardLogin(params: JarvisLoginForwardParams): Promise<JarvisLoginForwardResult> {
    this.#requireLocal("login-forward");
    return jarvisLoginForwardResultSchema.parse(
      await this.#forwarder.start({
        hostId: params.targetHostId,
        callbackPort: params.callbackPort,
        authUrl: params.authUrl,
      }),
    );
  }

  stopForward(forwardId: string): void {
    this.#forwarder.stop(forwardId);
  }

  async expandMentions(text: string): Promise<string> {
    return (await expandJarvisMentions(text, this.#cli)).text;
  }

  async resolveUser(): Promise<JarvisUser | null> {
    return await this.#cli.user();
  }

  dispose(): void {
    this.#login.cancel();
    this.#forwarder.dispose();
    for (const [token, session] of this.#downloads) {
      void rm(session.path, { force: true }).catch(() => undefined);
      this.#downloads.delete(token);
    }
    for (const [id, session] of this.#uploads) {
      void rm(session.path, { force: true }).catch(() => undefined);
      this.#uploads.delete(id);
    }
  }

  #requireLocal(operation = "settings"): void {
    if (!this.#isLocalHost) {
      throw new JarvisServiceError(
        "local_only",
        `${operation} is only available on the local Host`,
      );
    }
  }

  async #platform(): Promise<string> {
    const status = await this.status();
    return status.platform ?? detectJarvisPlatform();
  }

  #pruneDownloads(): void {
    for (const [token, session] of this.#downloads) {
      if (this.#now() - session.createdAt <= DOWNLOAD_TTL_MS) continue;
      void rm(session.path, { force: true }).catch(() => undefined);
      this.#downloads.delete(token);
    }
  }

  #pruneUploads(): void {
    for (const [id, session] of this.#uploads) {
      if (this.#now() - session.createdAt <= DOWNLOAD_TTL_MS) continue;
      void rm(session.path, { force: true }).catch(() => undefined);
      this.#uploads.delete(id);
    }
  }

  async #discardUpload(id: string): Promise<void> {
    const session = this.#uploads.get(id);
    if (!session) return;
    this.#uploads.delete(id);
    await rm(session.path, { force: true }).catch(() => undefined);
  }
}

export function createJarvisService(options: JarvisServiceOptions): JarvisService {
  return new JarvisService(options);
}
