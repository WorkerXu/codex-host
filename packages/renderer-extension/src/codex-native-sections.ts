import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

import { isCodexServiceRegistry, loadCodexNativeModule } from "./codex-native-services.js";

/** A Desktop AppScope instance, the store-aware facade the native hooks hand to components. */
export interface NativeSectionScope {
  get(atom: unknown): unknown;
}

/** The derived sidebar-custom-sections-v3 atom in the native sidebar module. */
export interface NativeSectionApi {
  QV: unknown;
}

const SECTION_COMMANDS = ["Jn", "f2", "qF", "HW"] as const;
const MAX_HOOKS_PER_FIBER = 256;

function isSectionApi(value: unknown): value is NativeSectionApi {
  if (!isCodexServiceRegistry(value)) return false;
  try {
    return (
      SECTION_COMMANDS.every((name) => typeof value[name] === "function") &&
      typeof value.QV === "object" &&
      value.QV !== null
    );
  } catch {
    return false;
  }
}

/** Resolve the native section commands, or null when this Desktop does not expose them or more
 * than one module claims the shape. The export names are internal, so discovery inspects the
 * instantiated module containers rather than a chunk name or module id. */
export async function loadCodexNativeSections(
  ownerWindow: Window,
  importModule?: (url: string) => Promise<Record<string, unknown>>,
): Promise<NativeSectionApi | null> {
  try {
    return await loadCodexNativeModule(ownerWindow, isSectionApi, importModule);
  } catch {
    return null;
  }
}

function isAppScope(value: unknown): value is NativeSectionScope {
  if (typeof value !== "object" || value === null) return false;
  const scope = value as Record<string, unknown>;
  if (
    typeof scope.get !== "function" ||
    typeof scope.set !== "function" ||
    typeof scope.watch !== "function" ||
    typeof scope.query !== "object" ||
    scope.query === null
  )
    return false;
  const node = scope.node as { token?: { __scopeBrand?: unknown } } | undefined;
  return node?.token?.__scopeBrand === "AppScope";
}

/** The AppScope wrapper React hands to hooks. Every wrapper shares one store, so the first
 * committed one found from the shell is the store the sidebar itself reads and writes. */
export function findCodexAppScope(ownerWindow: Window): NativeSectionScope | null {
  const document = ownerWindow.document;
  if (!document) return null;
  const element =
    document.querySelector("aside") ??
    document.querySelector("main") ??
    document.querySelector("[data-app-shell-root]");
  if (!element) return null;
  const fiberKey = Object.getOwnPropertyNames(element).find((name) =>
    name.startsWith("__reactFiber$"),
  );
  if (!fiberKey) return null;
  for (const fiber of committedReactAncestors(Reflect.get(element, fiberKey))) {
    let hook = (fiber as { memoizedState?: unknown }).memoizedState as
      { memoizedState?: unknown; next?: unknown } | null | undefined;
    for (let index = 0; hook && index < MAX_HOOKS_PER_FIBER; index += 1) {
      const state = hook.memoizedState as { current?: unknown } | null | undefined;
      if (isAppScope(state?.current)) return state.current;
      hook = hook.next as typeof hook;
    }
  }
  return null;
}
