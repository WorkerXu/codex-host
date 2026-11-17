import postcss from "postcss";

/** Use the exported Desktop theme declarations without bringing native component rules into settings. */
export function desktopThemeCss(source) {
  const stylesheet = postcss.parse(source);
  stylesheet.walkRules((rule) => {
    if (!/:root|:host|\[data-theme/u.test(rule.selector)) {
      rule.remove();
      return;
    }
    rule.walkDecls((declaration) => {
      if (!declaration.prop.startsWith("--") && declaration.prop !== "color-scheme")
        declaration.remove();
    });
    if (!rule.nodes.length) rule.remove();
  });
  stylesheet.walkAtRules((rule) => {
    if (!rule.nodes?.length) rule.remove();
  });
  return stylesheet.toString();
}
