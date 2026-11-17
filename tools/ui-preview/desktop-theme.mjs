import postcss from "postcss";

/** Keep Desktop's theme declarations and conditions, without its document/utility styles. */
export function desktopTheme(css) {
  const source = postcss.parse(css);
  const declared = new Set();
  let colorSchemes = false;
  function extract(node, inTheme = false) {
    if (node.type === "decl") {
      if (!inTheme || (!node.prop.startsWith("--") && node.prop !== "color-scheme")) return [];
      if (node.prop.startsWith("--")) declared.add(node.prop);
      if (node.value.includes("light-dark(") || node.parent.selector?.includes('data-theme="dark"'))
        colorSchemes = true;
      return [node.clone()];
    }
    if (node.type === "rule") {
      if (!inTheme && !/:root|:host|\[data-theme/u.test(node.selector)) return [];
      const children = (node.nodes ?? []).flatMap((child) => extract(child, true));
      return children.length ? [node.clone({ nodes: children })] : [];
    }
    if (node.type === "root" || node.type === "atrule") {
      if (node.type === "atrule" && !["layer", "media", "supports"].includes(node.name)) return [];
      const children = (node.nodes ?? []).flatMap((child) => extract(child, inTheme));
      if (node.type === "root" || node.name === "layer") return children;
      return children.length ? [node.clone({ nodes: children })] : [];
    }
    return [];
  }
  const nodes = extract(source);
  return { css: postcss.root({ nodes }).toString(), declared, colorSchemes };
}
