#!/usr/bin/env node
/**
 * Static preview server. It only listens on the loopback interface and serves
 * the preview bundle plus the locally installed Desktop stylesheet.
 */
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const previewRoot = import.meta.dirname;
const distFile = path.join(previewRoot, "dist/preview.js");
const cssPath =
  process.env.CODEX_DESKTOP_CSS ??
  "/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-reference/codex-desktop.css";
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
]);

let desktopCss;
function readDesktopCss() {
  if (desktopCss !== undefined) return desktopCss;
  try {
    desktopCss = readFileSync(cssPath, "utf8");
  } catch {
    console.warn(`[ui-preview] ${cssPath} is missing; using the token stub only.`);
    desktopCss = "";
  }
  return desktopCss;
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
  if (url.pathname === "/token-stub.css") {
    send(response, 200, types.get(".css"), readFileSync(path.join(previewRoot, "token-stub.css")));
    return;
  }
  if (url.pathname === "/codex-desktop.css") {
    send(response, 200, types.get(".css"), readDesktopCss());
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
    `[ui-preview] Desktop CSS: ${existsSync(cssPath) ? cssPath : "(missing, stub only)"}`,
  );
});
