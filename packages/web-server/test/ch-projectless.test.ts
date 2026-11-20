import {
  THREAD_FOLDERS_GET_METHOD,
  THREAD_FOLDERS_PARAM,
  THREAD_FOLDERS_SET_METHOD,
} from "@codexhost/shared-contracts";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { EventHub, RpcError, RpcRegistry, StreamRegistry } from "../src/transport.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeChHost } from "./support/ch-host.ts";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "ch-projectless-web-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = new FakeChHost();
  host.add("selected", root);
  const workspaces = new Workspaces(new DataDir(root), root, true);
  const selected = workspaces.create(root).workspace;
  const sessions = new ChSessions(host, workspaces, new EventHub(root));
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  sessions.register(rpc, new StreamRegistry());
  const call = async <T>(method: string, request: object = {}): Promise<T> => {
    const result = await rpc.dispatch(method, { args: { request } });
    assert.ok(result.ok, result.ok ? undefined : result.error.message);
    return result.value as T;
  };
  return { root, host, workspaces, selected, sessions, rpc, call };
}

it("keeps an unselected draft directory-free, commits through the owner, and never registers its cwd", async (t) => {
  const { root, host, workspaces, call } = setup(t);
  await call("session/list");
  const before = workspaces.list().map((workspace) => workspace.workspaceId);
  const draft = await call<{ sessionId: string }>("session/create");
  const list = await call<{ items: Array<{ sessionId: string; cwd?: string }> }>("session/list");
  assert.equal(list.items.find((item) => item.sessionId === draft.sessionId)?.cwd, undefined);
  assert.equal(workspaces.ownerOf(draft.sessionId), undefined);
  assert.equal(host.requests.filter((request) => request.method === "thread/start").length, 0);
  assert.deepEqual(readdirSync(root), ["workspaces.json"]);
  await call("session/prompt", {
    sessionId: draft.sessionId,
    requestId: "first",
    content: [{ type: "text", text: "Build a fresh task" }],
  });
  const start = host.requests.find((request) => request.method === "thread/start");
  assert.ok(start);
  assert.deepEqual(start.params.projectlessWorkspace, { prompt: "Build a fresh task" });
  assert.equal("cwd" in start.params, false);
  assert.equal("projectId" in start.params, false);
  const canonical = [...host.threads.values()].find((row) => row.id !== "selected");
  assert.ok(canonical);
  assert.equal(canonical.workspaceKind, "projectless");
  await call("session/list");
  assert.equal(workspaces.ownerOf(canonical.id), undefined);
  assert.deepEqual(
    workspaces.list().map((workspace) => workspace.workspaceId),
    before,
  );
  assert.deepEqual(
    readdirSync(root),
    ["workspaces.json"],
    "Web does not allocate owner execution directories or an extra Thread index",
  );
  await call("session/prompt", {
    sessionId: canonical.id,
    requestId: "second",
    content: [{ type: "text", text: "Continue" }],
  });
  assert.equal(host.requests.filter((request) => request.method === "thread/start").length, 1);
  const another = await call<{ sessionId: string }>("session/create");
  await call("session/prompt", {
    sessionId: another.sessionId,
    content: [{ type: "text", text: "Build a fresh task" }],
  });
  const paths = [...host.threads.values()]
    .filter((row) => row.workspaceKind === "projectless")
    .map((row) => row.cwd);
  assert.equal(new Set(paths).size, 2);
});

it("defaults only known local Session terminals to home without assigning a workspace", async (t) => {
  const { root, host, sessions, selected, workspaces, call } = setup(t);
  const noDirectory = host.add("no-directory", root, "No directory", false);
  noDirectory.cwd = "";
  const official = host.add("official", root);
  official.modelProvider = "openai";
  await call("session/list");
  assert.equal(sessions.terminalWorkspaceRoot("selected"), root);
  assert.equal(sessions.terminalWorkspaceRoot("no-directory"), homedir());
  assert.equal(sessions.terminalWorkspaceRoot("official"), undefined);
  assert.equal(sessions.terminalWorkspaceRoot("unknown"), undefined);

  const draft = await call<{ sessionId: string }>("session/create");
  assert.equal(sessions.terminalWorkspaceRoot(draft.sessionId), homedir());
  assert.equal(sessions.fileWorkspaceRoot(draft.sessionId), undefined);
  assert.equal(workspaces.ownerOf(draft.sessionId), undefined);
  assert.equal(
    host.requests.some(({ method }) => method === "thread/start"),
    false,
  );
  const selectedDraft = await call<{ sessionId: string }>("session/create", {
    workspaceId: selected.workspaceId,
  });
  assert.equal(sessions.terminalWorkspaceRoot(selectedDraft.sessionId), root);
  sessions.discardUnsubmittedDraft(selectedDraft.sessionId);
  assert.equal(sessions.terminalWorkspaceRoot(selectedDraft.sessionId), undefined);

  await call("session/prompt", {
    sessionId: draft.sessionId,
    content: [{ type: "text", text: "Create a task" }],
  });
  const canonical = [...host.threads.values()].find((row) => row.workspaceKind === "projectless");
  assert.ok(canonical);
  assert.equal(sessions.terminalWorkspaceRoot(draft.sessionId), canonical.cwd);
  assert.equal(sessions.terminalWorkspaceRoot(canonical.id), canonical.cwd);
  assert.notEqual(canonical.cwd, homedir());
});

it("uses an explicitly selected workspace and rejects stale choices instead of selecting none", async (t) => {
  const { root, host, workspaces, selected, rpc, call } = setup(t);
  await call("session/list");
  const draft = await call<{ sessionId: string }>("session/create", {
    workspaceId: selected.workspaceId,
  });
  assert.equal(workspaces.ownerOf(draft.sessionId)?.path, root);
  await call("session/prompt", {
    sessionId: draft.sessionId,
    content: [{ type: "text", text: "Use the selected folder" }],
  });
  const start = host.requests.find((request) => request.method === "thread/start");
  assert.ok(start);
  assert.equal(start.params.cwd, root);
  assert.equal("projectlessWorkspace" in start.params, false);
  const rejected = await rpc.dispatch("session/create", {
    args: { request: { workspaceId: "deleted" } },
  });
  assert.ok(!rejected.ok);
  assert.equal(rejected.error.code, "workspace/invalid-path");
});

it("does not resend an uncertain creation or allow reusing that draft to allocate another directory", async (t) => {
  const { host, rpc, call } = setup(t);
  const request = host.request.bind(host);
  let starts = 0;
  host.request = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (method === "thread/start") {
      starts++;
      throw new RpcError("host/outcome-unknown", "Outcome is unknown; do not retry automatically.");
    }
    return request<T>(method, params);
  };
  const draft = await call<{ sessionId: string }>("session/create");
  for (let index = 0; index < 2; index++) {
    const reply = await rpc.dispatch("session/prompt", {
      args: {
        request: { sessionId: draft.sessionId, content: [{ type: "text", text: "New task" }] },
      },
    });
    assert.ok(!reply.ok);
    assert.equal(reply.error.code, "host/outcome-unknown");
  }
  const replace = await rpc.dispatch("session/create", {
    args: { request: { sessionId: draft.sessionId } },
  });
  assert.ok(!replace.ok);
  assert.equal(replace.error.code, "session/busy");
  assert.equal(starts, 1);
});

it("applies draft folders through the Host and shares updates on the canonical Thread", async (t) => {
  const { root, host, workspaces, call, rpc } = setup(t);
  const draft = await call<{ sessionId: string }>("session/create");
  const folders = [join(root, "second"), join(root, "first")];
  const invalid = await rpc.dispatch(THREAD_FOLDERS_SET_METHOD, {
    args: { sessionId: draft.sessionId, folders: ["relative"] },
  });
  assert.equal(invalid.ok, false);

  const folderRequest = (method: string, args: object) => rpc.dispatch(method, { args });
  const savedDraft = await folderRequest(THREAD_FOLDERS_SET_METHOD, {
    sessionId: draft.sessionId,
    folders,
  });
  assert.ok(savedDraft.ok);
  assert.equal(host.workingFolders.size, 0);
  await call("session/prompt", {
    sessionId: draft.sessionId,
    requestId: "use-folders",
    content: [{ type: "text", text: "Work in both folders" }],
  });
  const started = host.requests.find(({ method }) => method === "thread/start");
  assert.deepEqual(started?.params[THREAD_FOLDERS_PARAM], folders);
  assert.ok(started?.params.projectlessWorkspace);
  const canonical = [...host.threads.values()].find((thread) => thread.id !== "selected");
  assert.ok(canonical);
  assert.equal(canonical.cwd, folders[0]);
  assert.equal(workspaces.ownerOf(canonical.id), undefined);
  assert.deepEqual(host.workingFolders.get(canonical.id)?.folders, folders);

  const next = [join(root, "third"), folders[0]];
  const saved = await folderRequest(THREAD_FOLDERS_SET_METHOD, {
    sessionId: canonical.id,
    folders: next,
  });
  assert.ok(saved.ok);
  assert.deepEqual(host.workingFolders.get(canonical.id)?.folders, next);
  const reopened = await folderRequest(THREAD_FOLDERS_GET_METHOD, { sessionId: canonical.id });
  assert.ok(reopened.ok);
  assert.deepEqual((reopened.value as { folders: string[] }).folders, next);
  assert.equal(workspaces.ownerOf(canonical.id), undefined);
});

it("keeps the selected project when a draft chooses a different primary folder", async (t) => {
  const { root, host, selected, call, rpc } = setup(t);
  const draft = await call<{ sessionId: string }>("session/create", {
    workspaceId: selected.workspaceId,
  });
  const worktree = join(root, "isolated-worktrees", "working-copy");
  const result = await rpc.dispatch(THREAD_FOLDERS_SET_METHOD, {
    args: { sessionId: draft.sessionId, folders: [worktree, join(root, "docs")] },
  });
  assert.ok(result.ok);
  await call("session/prompt", {
    sessionId: draft.sessionId,
    requestId: "keep-project",
    content: [{ type: "text", text: "Inspect the working copy" }],
  });
  const canonical = [...host.threads.values()].find((thread) => thread.id !== "selected");
  assert.ok(canonical);
  assert.equal(canonical.cwd, worktree);
  assert.equal(host.projectSnapshot.assignments[canonical.id], "project-selected");
});
