/** Bind Desktop 26.1021 external draft creation and isolate its cwd-keyed pool.
 * Each invocation captures its route and prewarm consumption check before native
 * preparation awaits.
 * Self-contained because the controller embeds this installer in the Renderer.
 */
export function isolateRendererPrewarmConsumption(
  manager: unknown,
  discardExternal: (threadId: string) => void,
  folderRequest?: {
    client: unknown;
    send(method: string, params: unknown, options?: unknown): unknown;
  },
) {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object";
  if (!record(manager) || !record(manager.threadCreation)) return null;
  const creation = manager.threadCreation;
  const originalStart = manager.startConversation;
  const original = creation.createConversation;
  const params = creation.params;
  if (typeof originalStart !== "function" || typeof original !== "function" || !record(params))
    return null;
  const prototype: unknown = Object.getPrototypeOf(creation);
  if (!record(prototype) || typeof prototype.constructor !== "function") return null;
  // An invocation view is safe only for the reviewed params-only native class.
  // In particular, a class with private instance fields cannot use that view.
  if (
    Object.keys(creation).some((key) => key !== "params" && typeof creation[key] !== "function") ||
    /#[A-Za-z_$]/u.test(Function.prototype.toString.call(prototype.constructor))
  )
    return null;
  const pool = params.prewarmedThreadManager;
  if (
    !record(pool) ||
    typeof pool.hasPrewarmedThread !== "function" ||
    typeof pool.consumePrewarmedThread !== "function" ||
    typeof pool.deletePrewarmedThread !== "function"
  )
    return null;
  const consume = pool.consumePrewarmedThread;
  const hasPrewarm = pool.hasPrewarmedThread;
  const draftRoutes = new Map<string, { draftId: string; model: string }>();
  const draftFolders = new Map<string, readonly string[]>();
  const draftIdentity = Symbol("codexhost draft creation");
  const folderDraftIdentity = Symbol("codexhost draft folders");
  // A marker (even on a native copy) expires with this particular selection's route.
  const activeRoute = (marker: unknown) => {
    if (!record(marker) || typeof marker.draftId !== "string") return undefined;
    const route = draftRoutes.get(marker.draftId);
    return route === marker ? route : undefined;
  };
  const external = (model: unknown): model is string =>
    typeof model === "string" && model.startsWith("codexhost/");
  const routedStart = function (
    this: unknown,
    input: unknown,
    options: unknown,
    ...args: unknown[]
  ) {
    const draftId =
      record(options) && typeof options.clientThreadId === "string"
        ? options.clientThreadId
        : undefined;
    const mode = record(input) && record(input.collaborationMode) ? input.collaborationMode : null;
    const origin = mode ? Reflect.get(mode, draftIdentity) : undefined;
    const route = (draftId ? draftRoutes.get(draftId) : undefined) ?? activeRoute(origin);
    const folderOrigin = mode ? Reflect.get(mode, folderDraftIdentity) : undefined;
    const folderDraftId =
      route?.draftId ?? draftId ?? (typeof folderOrigin === "string" ? folderOrigin : undefined);
    const folders = folderDraftId ? draftFolders.get(folderDraftId) : undefined;
    if (record(input) && (folders || typeof folderOrigin === "string")) {
      input = {
        ...input,
        ...(mode
          ? {
              collaborationMode: {
                ...mode,
                [folderDraftIdentity]: folders ? folderDraftId : undefined,
              },
            }
          : {}),
        ...(folders ? { cwd: folders[0], workspaceRoots: [...folders] } : {}),
      };
    }
    if (mode && record(mode.settings) && external(mode.settings.model))
      return originalStart.call(this, input, options, ...args);
    const model = route?.model;
    if (!model) return originalStart.call(this, input, options, ...args);
    if (
      !record(input) ||
      !record(input.collaborationMode) ||
      !record(input.collaborationMode.settings)
    )
      throw new Error("External draft creation is missing its native Model settings");
    // Capture this draft's route before native preparation awaits. Codex reserve
    // fallback is Account-wide and cannot select the owner of an external Thread.
    const routed = {
      ...input,
      collaborationMode: {
        ...input.collaborationMode,
        settings: { ...input.collaborationMode.settings, model },
      },
    };
    return originalStart.call(this, routed, options, ...args);
  };
  const wrapped = function (this: unknown, input: unknown, ...args: unknown[]) {
    const mode = record(input) && record(input.collaborationMode) ? input.collaborationMode : null;
    const expected = mode && record(mode.settings) ? mode.settings.model : null;
    const identity = mode ? Reflect.get(mode, folderDraftIdentity) : null;
    const folders = typeof identity === "string" ? draftFolders.get(identity) : undefined;
    const scopedPool = Object.create(pool) as Record<string, unknown>;
    scopedPool.hasPrewarmedThread = (...parameters: unknown[]) =>
      hasPrewarm.apply(pool, parameters);
    scopedPool.consumePrewarmedThread = async (...consumeArgs: unknown[]) => {
      // A selected workspace must not consume a cwd-keyed prewarm with different extra roots.
      const warmed: unknown = await consume.apply(pool, consumeArgs);
      if (!record(warmed) || !record(warmed.response)) return warmed;
      const response = warmed.response;
      if (!folders && !external(expected) && !external(response.model)) return warmed;
      if (!folders && external(expected) && expected === response.model) return warmed;
      if (record(response.thread) && typeof response.thread.id === "string") {
        const threadId = response.thread.id;
        if (external(response.model)) discardExternal(threadId);
        else
          void Promise.resolve()
            .then(() => (pool.deletePrewarmedThread as (id: string) => unknown)(threadId))
            .catch(() => undefined);
      }
      return null;
    };
    // The reviewed native ThreadCreation class owns only `params`. Its methods
    // continue to register the real conversation through those native callbacks.
    const invocation = Object.create(creation) as Record<string, unknown>;
    const scopedParams: Record<string, unknown> = { ...params, prewarmedThreadManager: scopedPool };
    if (folders && folderRequest && record(folderRequest.client)) {
      // ThreadCreation dependencies are invocation-local. Bind requests to this draft even
      // when another Composer submits while native attachment preparation is awaiting.
      const client = folderRequest.client;
      const scopedClient = Object.create(client) as Record<string, unknown>;
      scopedClient.sendRequest = (method: string, value: unknown, options?: unknown) =>
        folderRequest.send(
          method,
          method === "thread/start" && record(value)
            ? {
                ...value,
                cwd: folders[0],
                runtimeWorkspaceRoots: [...folders],
                codexhostWorkingFolders: [...folders],
              }
            : value,
          options,
        );
      for (const [key, value] of Object.entries(params))
        if (value === client) scopedParams[key] = scopedClient;
    }
    invocation.params = scopedParams;
    if (folders && record(input))
      input = { ...input, cwd: folders[0], workspaceRoots: [...folders] };
    return original.call(invocation, input, ...args);
  };
  creation.createConversation = wrapped;
  manager.startConversation = routedStart;
  return {
    selectWorkingFolders(
      draftId: string,
      folders: readonly string[],
      creationModes: readonly Record<string, unknown>[] = [],
    ): void {
      if (!draftId.startsWith("client-new-thread:") || !folders.length)
        throw new Error("工作文件夹缺少草稿标识");
      draftFolders.set(draftId, [...folders]);
      for (const mode of creationModes)
        Object.defineProperty(mode, folderDraftIdentity, {
          configurable: true,
          enumerable: true,
          value: draftId,
        });
    },
    selectDraft(
      draftId: string | undefined,
      model: string | null,
      creationModes: readonly Record<string, unknown>[] = [],
    ): void {
      if (draftId === undefined) {
        if (model === null) draftRoutes.clear();
      } else if (model === null) draftRoutes.delete(draftId);
      else {
        if (!draftId.startsWith("client-new-thread:") || !external(model))
          throw new Error("External draft route is missing its client Thread identity");
        const route = draftRoutes.get(draftId) ?? { draftId, model };
        const toMark = creationModes.filter((mode) => {
          const marker = Object.getOwnPropertyDescriptor(mode, draftIdentity);
          if (marker?.value === route) return false;
          if (
            marker ? activeRoute(marker.value) || !marker.configurable : !Object.isExtensible(mode)
          )
            throw new Error("External creation mode cannot be marked for this draft");
          return true;
        });
        // Native preparation shallow-copies modes when it overrides effort.
        // Symbols survive those copies and are omitted from RPC JSON.
        for (const mode of toMark)
          Object.defineProperty(mode, draftIdentity, {
            configurable: true,
            enumerable: true,
            value: route,
          });
        route.model = model;
        draftRoutes.set(draftId, route);
      }
    },
    dispose() {
      draftRoutes.clear();
      draftFolders.clear();
      if (manager.startConversation === routedStart) manager.startConversation = originalStart;
      if (creation.createConversation === wrapped) creation.createConversation = original;
    },
  };
}
