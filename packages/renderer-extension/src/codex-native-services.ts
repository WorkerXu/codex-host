const MAX_RUNTIME_MODULES = 32_768;
const MAX_RUNTIME_EXPORTS = 131_072;
const RUNTIME_SCAN_SLICE = 2_048;
/** Compiler-generated live bindings and re-exports: property reads only, never a call. */
const COMPILED_EXPORT_GETTER =
  /^(?:\(\)=>|function\(\)\{return )[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[(?:[A-Za-z_$][\w$]*|"[^"\\]*"|'[^'\\]*')\])*\}?$/;

const objectLike = (value: unknown): value is object =>
  (typeof value === "object" || typeof value === "function") && value !== null;

/** The already-instantiated module table of a bundled entry. Bundled Desktop exposes only its
 * runtime from the entry namespace. Only `.c` is read: the runtime function and its `.m`
 * factories would execute modules, so neither is ever called. */
function instantiatedModules(namespace: Record<string, unknown>): object | null {
  const runtime = namespace.__webpack_require__;
  if (typeof runtime !== "function") return null;
  const cache = Object.getOwnPropertyDescriptor(runtime, "c")?.value as unknown;
  return objectLike(cache) ? cache : null;
}

/** Values an instantiated module exports through compiled namespace bindings. Whole-module
 * matching also accepts plain data bindings. Unrecognized accessors are never read. */
function compiledExports(
  exports: Record<string, unknown>,
  matchModule: boolean,
): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(exports))) {
    if (!descriptor.enumerable) continue;
    if ("value" in descriptor) {
      if (matchModule || !descriptor.configurable) entries.push([key, descriptor.value]);
      continue;
    }
    if (descriptor.configurable || !descriptor.get) continue;
    try {
      if (COMPILED_EXPORT_GETTER.test(Function.prototype.toString.call(descriptor.get)))
        entries.push([key, descriptor.get.call(exports)]);
    } catch {
      // A binding still in its temporal dead zone holds no service yet.
    }
  }
  return Object.fromEntries(entries);
}

/** Discover exports of loaded native modules: direct ES exports, and instantiated modules of a
 * bundled runtime. The Controller's CDP catalog includes deep chunks without following or
 * executing unloaded lazy imports. Windows without a catalog retain the legacy modulepreload
 * discovery path.
 */
export async function loadCodexNativeServices<T>(
  ownerWindow: Window,
  matchesServices: (value: unknown) => value is T,
  importModule: (url: string) => Promise<Record<string, unknown>> = (url) => import(url),
): Promise<T | null> {
  return scanNativeExports(ownerWindow, matchesServices, importModule, false);
}

/** Matches the exports of a loaded module that exposes commands as named bindings. */
export function loadCodexNativeModule<T>(
  ownerWindow: Window,
  matchesModule: (value: unknown) => value is T,
  importModule: (url: string) => Promise<Record<string, unknown>> = (url) => import(url),
): Promise<T | null> {
  return scanNativeExports(ownerWindow, matchesModule, importModule, true);
}

async function scanNativeExports<T>(
  ownerWindow: Window,
  matches: (value: unknown) => value is T,
  importModule: (url: string) => Promise<Record<string, unknown>>,
  matchModule: boolean,
): Promise<T | null> {
  if (!ownerWindow.document || !ownerWindow.location) return null;
  const page = new URL(ownerWindow.location.href);
  const urls = new Set<string>();
  const catalog: unknown = Reflect.get(ownerWindow, "__codexhostLoadedModulesV1");
  let sources: string[];
  if (catalog !== undefined) {
    if (
      typeof catalog !== "object" ||
      catalog === null ||
      !("complete" in catalog) ||
      catalog.complete !== true ||
      !("documentUrl" in catalog) ||
      catalog.documentUrl !== page.href ||
      !("urls" in catalog) ||
      !Array.isArray(catalog.urls) ||
      catalog.urls.length > 4096 ||
      catalog.urls.some((url) => typeof url !== "string")
    )
      throw new Error("Codex loaded module catalog is unavailable in this window");
    sources = catalog.urls as string[];
  } else {
    sources = [...ownerWindow.document.querySelectorAll('link[rel="modulepreload"][href]')].map(
      (link) => link.getAttribute("href") ?? "",
    );
  }
  for (const source of sources) {
    let url: URL;
    try {
      url = new URL(source, page);
    } catch {
      continue;
    }
    if (
      url.protocol === page.protocol &&
      url.host === page.host &&
      url.pathname.endsWith(".js") &&
      !url.search &&
      !url.hash
    )
      urls.add(url.href);
  }
  // Preserve legacy shared-first ordering; still check every eligible module.
  const candidates = [...urls].sort(
    (a, b) => Number(b.includes("/app-shared-")) - Number(a.includes("/app-shared-")),
  );
  const found = new Set<T>();
  const addMatch = (value: unknown, original = value): void => {
    if (matches(value)) found.add(original as T);
    if (found.size > 1) throw new Error("Codex native services are unavailable in this window");
  };
  const runtimes = new Set<object>();
  for (const url of candidates) {
    let module: Record<string, unknown>;
    try {
      module = await importModule(url);
    } catch {
      continue;
    }
    if (matchModule) addMatch(module);
    else Object.values(module).forEach((value) => addMatch(value));
    const runtime = instantiatedModules(module);
    if (runtime) runtimes.add(runtime);
  }
  let scannedExports = 0;
  for (const runtime of runtimes) {
    const modules = Object.values(runtime);
    if (modules.length > MAX_RUNTIME_MODULES)
      throw new Error("Codex native services are unavailable in this window");
    for (const [index, module] of modules.entries()) {
      if (index > 0 && index % RUNTIME_SCAN_SLICE === 0)
        await new Promise((resolve) => setTimeout(resolve));
      if (!objectLike(module) || Object.hasOwn(module, "error")) continue;
      const exports: unknown = Object.getOwnPropertyDescriptor(module, "exports")?.value;
      if (!isCodexServiceRegistry(exports)) continue;
      const bindings = compiledExports(exports, matchModule);
      const values = Object.values(bindings);
      scannedExports += values.length;
      if (scannedExports > MAX_RUNTIME_EXPORTS)
        throw new Error("Codex native services are unavailable in this window");
      if (matchModule) addMatch(bindings, exports);
      else values.forEach((value) => addMatch(value));
    }
  }
  if (catalog !== undefined && Reflect.get(ownerWindow, "__codexhostLoadedModulesV1") !== catalog)
    throw new Error("Codex loaded module catalog changed during discovery. Try again once ready.");
  return [...found][0] ?? null;
}

export function isCodexServiceRegistry(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}
