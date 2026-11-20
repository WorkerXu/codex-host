#!/usr/bin/env node
import { parseArgs } from "node:util";
import { probeRemoteThreadFolders } from "@codexhost/host-runtime";

const { values } = parseArgs({
  options: { host: { type: "string" }, cli: { type: "string" }, help: { type: "boolean" } },
});
if (values.help) {
  console.log(
    "Usage: node tools/thread-folders-check.mjs --host <ssh-alias> [--cli <remote-codex-path>]\nStarts one ephemeral Codex Thread with two temporary writable roots, asks it to write into the second root, verifies the marker and removes both roots. Requires remote Codex authentication; uses one model Turn.",
  );
} else if (!values.host) {
  throw new Error("--host <ssh-alias> is required (use --help for details)");
} else {
  console.log(JSON.stringify(await probeRemoteThreadFolders(values.host, values.cli), null, 2));
}
