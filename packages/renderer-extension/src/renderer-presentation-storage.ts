/** Renderer display caches reuse the per-Host keys of the Desktop fork. */
export function rendererPresentationStorage(hostId: string) {
  try {
    const storage = window.localStorage;
    if (hostId === "local") return storage;
    const scoped = (key: string) => `${key}.host.${encodeURIComponent(hostId)}`;
    return {
      getItem: (key: string) => storage.getItem(scoped(key)),
      setItem: (key: string, value: string) => storage.setItem(scoped(key), value),
    };
  } catch {
    return null;
  }
}
