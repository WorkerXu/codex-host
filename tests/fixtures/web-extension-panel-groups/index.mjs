export function activate(api) {
  let count = 2;
  const groupId = "library";
  api.panels.registerGroup({ id: groupId, title: { en: "Library", "zh-CN": "资料库" } });
  for (const [id, title, heading] of [
    ["prompts", { en: "Instructions", "zh-CN": "指令" }, "指令"],
    ["memory", { en: "Memory", "zh-CN": "记忆" }, "记忆"],
    ["mcp", "MCP", "MCP"],
  ]) {
    api.panels.register({
      id,
      placement: "main",
      groupId,
      title,
      ...(id === "prompts" && { badgeCount: count }),
      render(root, signal) {
        const section = document.createElement("section");
        section.style.padding = "24px";
        const header = document.createElement("h1");
        header.textContent = heading;
        section.append(header);
        if (id === "prompts") {
          const increment = document.createElement("button");
          increment.type = "button";
          increment.textContent = "增加计数";
          increment.addEventListener("click", () => api.panels.setBadgeCount(id, ++count), {
            signal,
          });
          section.append(increment);
        }
        root.append(section);
      },
    });
  }
}
