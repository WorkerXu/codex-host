/** Resolve both themes from the exported Desktop stylesheet, without applying its global rules to the preview. */
export async function applyDesktopTheme(theme: "light" | "dark"): Promise<void> {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.srcdoc = `<!doctype html><html data-theme="${theme}" data-codex-window-type="electron" data-appearance-preset="codex"><head><link rel="stylesheet" href="/codex-desktop.css"></head><body></body></html>`;
  const loaded = new Promise<void>((resolve) => {
    frame.addEventListener("load", () => resolve(), { once: true });
  });
  document.body.append(frame);
  try {
    await loaded;
    const source = frame.contentDocument?.documentElement;
    const view = frame.contentWindow;
    if (!source || !view) throw new Error("无法读取 Desktop 主题样式");
    const computed = view.getComputedStyle(source);
    if (!computed.getPropertyValue("--app-color-background-surface").trim())
      throw new Error("预览需要 CODEX_DESKTOP_CSS 指向真实 Desktop 导出的样式");
    for (const name of computed) {
      if (name.startsWith("--"))
        document.documentElement.style.setProperty(name, computed.getPropertyValue(name).trim());
    }
    document.documentElement.style.colorScheme = theme;
    document.body.dataset.nativeTheme = theme;
  } finally {
    frame.remove();
  }
}
