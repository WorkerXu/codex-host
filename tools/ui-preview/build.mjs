#!/usr/bin/env node
/**
 * Bundles the preview entry with the renderer-extension's own esbuild setup.
 * Preview code imports renderer source directly so a page can be inspected
 * without a Desktop, a Host, or a network.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { build } from "esbuild";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

const previewRoot = import.meta.dirname;
const repositoryRoot = path.resolve(previewRoot, "..", "..");
const contractsSource = path.resolve(repositoryRoot, "packages/shared-contracts/src");

/** Renderer packages import the built contracts; the preview reads the same TS sources. */
const contractsPlugin = {
  name: "codexhost-preview-contracts",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^@codexhost\/shared-contracts$/ }, () => ({
      path: path.join(contractsSource, "index.ts"),
    }));
    buildContext.onResolve({ filter: /^@codexhost\/shared-contracts\/version$/ }, () => ({
      path: path.join(contractsSource, "version.ts"),
    }));
    // Source files use NodeNext `.js` specifiers for their TypeScript siblings.
    buildContext.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.importer || !args.path.startsWith(".")) return null;
      const resolved = path.resolve(path.dirname(args.importer), args.path);
      if (existsSync(resolved)) return null;
      const typescript = resolved.replace(/\.js$/, ".ts");
      return existsSync(typescript) ? { path: typescript } : null;
    });
  },
};

await build({
  absWorkingDir: repositoryRoot,
  entryPoints: [path.join(previewRoot, "src/main.ts")],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2024",
  sourcemap: true,
  outfile: path.join(previewRoot, "dist/preview.js"),
  loader: { ".png": "dataurl", ".svg": "dataurl", ".css": "text" },
  plugins: [contractsPlugin, tailwindEsbuildPlugin()],
  logLevel: "info",
});
