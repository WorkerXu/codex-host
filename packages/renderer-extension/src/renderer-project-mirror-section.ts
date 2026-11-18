import {
  findCodexAppScope,
  loadCodexNativeSections,
  type NativeSectionApi,
  type NativeSectionScope,
} from "./codex-native-sections.js";

const SECTIONS_ATOM = "electron-persisted-atom-state";
const SECTIONS_KEY = "sidebar-custom-sections-v3";
const PROJECT_ITEM_PREFIX = "codex:project:";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const callable = (value: unknown): boolean =>
  (typeof value === "object" || typeof value === "function") && value !== null;

interface SavedSection {
  id: string;
  name: string;
  hostSectionIds: Record<string, string>;
  itemKeys: string[];
}

interface MirrorSectionTransition {
  createSection(input: {
    hostId: string;
    logicalSectionId: string;
    name: string;
  }): Promise<unknown>;
  saveReplica(input: { sectionId: string; hostId: string; replicaId: string }): Promise<unknown>;
  complete(): Promise<unknown>;
}

interface SavedSectionService {
  applySavedCustomSectionCommand(input: unknown): Promise<unknown>;
}

export interface MirrorSectionServices {
  applicationState?: {
    read(key: string): Promise<unknown>;
  };
  savedCustomSections?: SavedSectionService;
}

export interface MirrorSectionInput {
  services: MirrorSectionServices;
  sourceProjectId: string;
  remoteProjectId: string;
  projectName: string;
  targetHostId: string;
  /** The window whose sidebar owns the section state; defaults to the global window. */
  ownerWindow?: Window;
}

/** Native section commands are injectable so tests can drive the same shape the bundle exposes. */
export interface MirrorSectionNativeDeps {
  loadSections?: (ownerWindow: Window) => Promise<NativeSectionApi | null>;
  findScope?: (ownerWindow: Window) => NativeSectionScope | null;
}

export type MirrorSectionOutcome = "created" | "joined" | "unchanged";

function sectionEntries(entries: unknown[]): SavedSection[] | null {
  const sections: SavedSection[] = [];
  for (const entry of entries) {
    if (!record(entry) || typeof entry.id !== "string" || !Array.isArray(entry.itemKeys))
      return null;
    const hostSectionIds: Record<string, string> = {};
    if (record(entry.hostSectionIds)) {
      for (const [hostId, sectionId] of Object.entries(entry.hostSectionIds)) {
        if (typeof sectionId === "string") hostSectionIds[hostId] = sectionId;
      }
    }
    sections.push({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : "",
      hostSectionIds,
      itemKeys: entry.itemKeys.filter((key): key is string => typeof key === "string"),
    });
  }
  return sections;
}

function savedSections(value: unknown): SavedSection[] | null {
  if (!record(value) || !Array.isArray(value.sections)) return null;
  return sectionEntries(value.sections);
}

async function atomAccountStates(
  services: MirrorSectionServices,
): Promise<Array<{ accountId: string; sections: SavedSection[] }>> {
  const applicationState = services.applicationState;
  if (!applicationState) throw new Error("分区状态服务不可用");
  const read = await applicationState.read(SECTIONS_ATOM);
  const value = record(read) && "value" in read ? read.value : read;
  const states = record(value) ? value[SECTIONS_KEY] : undefined;
  if (!record(states)) return [];
  return Object.entries(states).flatMap(([accountId, state]) => {
    const sections = savedSections(state);
    return sections ? [{ accountId, sections }] : [];
  });
}

function saveOutcome(value: unknown): "applied" | "unchanged" | "conflict" | null {
  return value === "applied" || value === "unchanged" || value === "conflict" ? value : null;
}

/**
 * Places the mirrored project in the same native section as its local source.
 * Desktop's `savedCustomSections` command owns the sidebar state and the
 * per-Host section replicas; this module only builds the command and drives
 * the returned transition for the two machines that now own the project.
 *
 * Builds without that command keep the state in the persisted
 * `sidebar-custom-sections-v3` atom, so they are driven through the same native
 * create/move functions the sidebar menu calls. No state is written here.
 */
export async function joinMirroredProjectSection(
  input: MirrorSectionInput,
  deps: MirrorSectionNativeDeps = {},
): Promise<MirrorSectionOutcome> {
  const saved = input.services.savedCustomSections;
  if (saved) return joinSavedSection(input, saved);
  return joinNativeSection(input, deps);
}

async function joinSavedSection(
  input: MirrorSectionInput,
  saved: SavedSectionService,
): Promise<MirrorSectionOutcome> {
  const accounts = await atomAccountStates(input.services);
  const sourceKey = `${PROJECT_ITEM_PREFIX}${input.sourceProjectId}`;
  const remoteKey = `${PROJECT_ITEM_PREFIX}${input.remoteProjectId}`;
  const containing = accounts.find(({ sections }) =>
    sections.some((section) => section.itemKeys.includes(sourceKey)),
  );
  const account = containing ?? (accounts.length === 1 ? accounts[0] : undefined);
  if (!account) throw new Error("无法确定当前账号，未能加入分区");
  const existing = containing?.sections.find((section) => section.itemKeys.includes(sourceKey));
  const sectionId = existing?.id ?? crypto.randomUUID();
  const name = existing?.name || input.projectName.trim() || "项目";
  const command = existing
    ? { type: "move", sectionId, itemKey: remoteKey }
    : {
        type: "create",
        sectionId,
        name,
        itemKeys: [sourceKey, remoteKey],
        legacy: false,
      };
  const before = existing ?? null;
  const result: unknown = await saved.applySavedCustomSectionCommand({
    accountId: account.accountId,
    operationId: crypto.randomUUID(),
    command,
    requiresServerWork: true,
  });
  if (!record(result)) throw new Error("分区服务返回无效结果");
  if (result.status === "unchanged") return "unchanged";
  if (result.status !== "applied" || !callable(result.transition))
    throw new Error("分区服务不可用");
  const transition = result.transition as MirrorSectionTransition;
  const hostSectionIds = before?.hostSectionIds ?? {};
  const hosts = [...new Set(["local", input.targetHostId])];
  try {
    for (const hostId of hosts) {
      if (hostSectionIds[hostId]) continue;
      const created = await transition.createSection({
        hostId,
        logicalSectionId: sectionId,
        name,
      });
      const replicaId = record(created) && typeof created.id === "string" ? created.id : null;
      if (!replicaId) throw new Error("分区创建失败");
      const savedReplica = await transition.saveReplica({ sectionId, hostId, replicaId });
      const outcome = saveOutcome(savedReplica);
      if (outcome !== "applied" && outcome !== "unchanged") throw new Error("分区副本保存失败");
    }
    await transition.complete();
  } finally {
    const dispose = (result.transition as { [Symbol.dispose]?: () => void })[Symbol.dispose];
    if (typeof dispose === "function") dispose.call(result.transition);
    const receipt = result.receipt;
    const disposeReceipt = (receipt as { [Symbol.dispose]?: () => void } | undefined)?.[
      Symbol.dispose
    ];
    if (typeof disposeReceipt === "function") disposeReceipt.call(receipt);
  }
  return existing ? "joined" : "created";
}

function nativeSections(scope: NativeSectionScope, api: NativeSectionApi): SavedSection[] | null {
  let value: unknown;
  try {
    value = scope.get(api.QV);
  } catch {
    return null;
  }
  return Array.isArray(value) ? sectionEntries(value) : null;
}

async function joinNativeSection(
  input: MirrorSectionInput,
  deps: MirrorSectionNativeDeps,
): Promise<MirrorSectionOutcome> {
  const ownerWindow = input.ownerWindow ?? (typeof window === "undefined" ? null : window);
  if (!ownerWindow) throw new Error("分区服务不可用");
  const api = await (deps.loadSections ?? loadCodexNativeSections)(ownerWindow);
  if (!api) throw new Error("分区服务不可用");
  const scope = (deps.findScope ?? findCodexAppScope)(ownerWindow);
  if (!scope) throw new Error("分区服务不可用");
  const sections = nativeSections(scope, api);
  if (!sections) throw new Error("无法读取侧栏分区");
  const sourceKey = `${PROJECT_ITEM_PREFIX}${input.sourceProjectId}`;
  const remoteKey = `${PROJECT_ITEM_PREFIX}${input.remoteProjectId}`;
  const existing = sections.find((section) => section.itemKeys.includes(sourceKey));
  if (existing) {
    if (existing.itemKeys.includes(remoteKey)) return "unchanged";
    api.f2(scope, existing.id, remoteKey);
    if (!placedInSection(scope, api, existing.id, remoteKey)) throw new Error("分区服务不可用");
    return "joined";
  }
  const name = input.projectName.trim() || "项目";
  const sectionId = api.Jn(scope, name, [sourceKey, remoteKey]);
  if (typeof sectionId !== "string" || !sectionId) throw new Error("分区创建失败");
  if (!placedInSection(scope, api, sectionId, remoteKey)) throw new Error("分区创建失败");
  return "created";
}

function placedInSection(
  scope: NativeSectionScope,
  api: NativeSectionApi,
  sectionId: string,
  itemKey: string,
): boolean {
  return (
    nativeSections(scope, api)?.some(
      (section) => section.id === sectionId && section.itemKeys.includes(itemKey),
    ) ?? false
  );
}
