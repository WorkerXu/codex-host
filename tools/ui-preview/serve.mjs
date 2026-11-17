#!/usr/bin/env node
import { desktopTheme } from "./desktop-theme.mjs";
/**
 * Static preview server. It only listens on the loopback interface and serves
 * the preview bundle plus the Desktop shadow-root context exported by the
 * reviewer. The export lives outside this repository; never copy it in.
 */
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const previewRoot = import.meta.dirname;
const distFile = path.join(previewRoot, "dist/preview.js");
const shadowContextPath = process.env.CODEX_SHADOW_CONTEXT ?? "";
// Global Desktop stylesheet for native-DOM scenarios (Composer @ popup).
const desktopCssPath = process.env.CODEX_DESKTOP_CSS ?? "";
const host = "127.0.0.1";
const port = Number(process.env.UI_PREVIEW_PORT ?? 4417);

if (!existsSync(distFile)) {
  execFileSync(process.execPath, [path.join(previewRoot, "build.mjs")], { stdio: "inherit" });
}

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

let context;
let theme;
function readDesktopTheme() {
  if (theme === undefined)
    theme = desktopCssPath ? desktopTheme(readFileSync(desktopCssPath, "utf8")) : null;
  return theme;
}
function readShadowContext() {
  if (context !== undefined) return context;
  if (!shadowContextPath) {
    throw new Error("CODEX_SHADOW_CONTEXT must point at the exported shadow-context.json");
  }
  context = JSON.parse(readFileSync(shadowContextPath, "utf8"));
  return context;
}

function shadowContextCss() {
  const context = readShadowContext();
  const theme = readDesktopTheme();
  const declarations = Object.entries(context.vars ?? {})
    .filter(([name]) => !theme?.declared.has(name))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return `:root {\n${declarations}\n  font-family: ${context.fontFamily ?? "system-ui, sans-serif"};\n}\nhtml, body { font-family: ${context.fontFamily ?? "system-ui, sans-serif"}; }\n${theme?.css ?? ""}`;
}

function shadowContextMetadata() {
  const context = readShadowContext();
  return {
    path: shadowContextPath,
    varCount: Object.keys(context.vars ?? {}).length,
    colorScheme: context.colorScheme ?? "light",
    desktopCssPath,
    themeSource: readDesktopTheme() ? "desktop-css" : "shadow-export",
    darkApproximate:
      !readDesktopTheme()?.colorSchemes && (context.colorScheme ?? "light") !== "dark",
  };
}

function send(response, status, type, body) {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    send(response, 200, types.get(".html"), readFileSync(path.join(previewRoot, "index.html")));
    return;
  }
  if (url.pathname === "/shadow-context.css") {
    try {
      send(response, 200, types.get(".css"), shadowContextCss());
    } catch (error) {
      send(
        response,
        500,
        "text/plain; charset=utf-8",
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }
  if (url.pathname === "/codex-desktop.css") {
    const css = desktopCssPath && existsSync(desktopCssPath) ? readFileSync(desktopCssPath) : "";
    send(response, 200, types.get(".css"), css);
    return;
  }
  if (url.pathname === "/shadow-context.json") {
    try {
      send(response, 200, types.get(".json"), `${JSON.stringify(shadowContextMetadata())}\n`);
    } catch (error) {
      send(
        response,
        500,
        "text/plain; charset=utf-8",
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }
  if (url.pathname === "/preview.js" || url.pathname === "/preview.js.map") {
    const file = path.join(previewRoot, "dist", url.pathname.slice(1));
    if (existsSync(file)) {
      send(response, 200, types.get(path.extname(file)) ?? "text/plain", readFileSync(file));
      return;
    }
  }
  const candidate = path.resolve(previewRoot, `.${url.pathname}`);
  if (candidate.startsWith(previewRoot) && existsSync(candidate) && statSync(candidate).isFile()) {
    response.writeHead(200, {
      "content-type": types.get(path.extname(candidate)) ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(candidate).pipe(response);
    return;
  }
  send(response, 404, "text/plain; charset=utf-8", "not found");
});

server.listen(port, host, () => {
  console.log(`[ui-preview] http://${host}:${port}/`);
  console.log(
    `[ui-preview] shadow context: ${shadowContextPath || "(CODEX_SHADOW_CONTEXT is unset)"}`,
  );
  console.log(`[ui-preview] Desktop CSS: ${desktopCssPath || "(CODEX_DESKTOP_CSS is unset)"}`);
});
