import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import {
  DELEGATION_PROJECTS_CHANGED_METHOD,
  DELEGATION_PROJECTS_METHOD,
  DESKTOP_PROJECTS_CATALOG_METHOD,
  harnessIdSchema,
  hostThreadIdSchema,
  type ThreadProjectAssignment,
} from "@codexhost/shared-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createFixture,
  JsonLineCollector,
  requestId,
  startExternalThread,
  stopFixture,
  writeRequest,
} from "../../packages/host-runtime/test/app-server-host-fixture.js";
import { clientOrigin } from "../../packages/host-runtime/src/external-client-origin.js";
import type { DelegationControlRegistration } from "../../packages/host-runtime/src/delegation-types.js";
import {
  installRendererDelegationProjects,
  type AssignmentServices,
} from "../../packages/renderer-extension/src/renderer-delegation-projects.js";

const sourceHostId = "remote-ssh-discovered:oracle-main";
const inherited = { projectKind: "remote", projectId: "workspace", hostId: sourceHostId } as const;
const override = { projectKind: "remote", projectId: "override", hostId: sourceHostId } as const;

describe("remote external parent → delegated Host record → Desktop membership", () => {
  for (const crossHost of [false, true]) {
    for (const harnessId of ["codex", "claude-code"] as const) {
      it.each([undefined, "override", null])(
        `${crossHost ? "cross-host" : "same remote Host"}, ${harnessId} child, project %s`,
        async (projectId) => {
          let delegation: DelegationControlRegistration | undefined;
          // This Host has no Mac Desktop catalog. Both parent and external children use a real
          // coordinator/repository, with only the Harness process and native app-server faked.
          const fixture = createFixture({
            externalAdapters: new Map([
              ["claude-code", new FakeHarnessAdapter(harnessIdSchema.parse("claude-code"))],
            ]),
            onDelegationApi(api) {
              delegation = api;
            },
          });
          let renderer: ReturnType<typeof installRendererDelegationProjects> | undefined;
          try {
            const parentId = await startExternalThread(fixture, "codexhost/claude-code-native");
            const incoming = new JsonLineCollector(fixture.official.stdin);
            fixture.official.stdin.on("data", () => {
              for (const message of incoming.messages.splice(0)) {
                const result =
                  message.method === "thread/start"
                    ? { thread: { id: "native-child", cwd: "/different-folder" } }
                    : message.method === "turn/start"
                      ? { turn: { id: "native-turn" } }
                      : {};
                fixture.official.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
              }
            });
            const targetHostId = crossHost ? "remote-ssh-discovered:other" : sourceHostId;
            let request = 100;
            const callbacks = new Set<() => void>();
            const notifications = new JsonLineCollector(fixture.desktopOutput);
            fixture.desktopOutput.on("data", () => {
              for (const message of notifications.messages.splice(0)) {
                if (message.method === DELEGATION_PROJECTS_CHANGED_METHOD)
                  callbacks.forEach((callback) => callback());
              }
            });
            const remote = {
              manager: {
                async sendRequest(method: string) {
                  const id = request++;
                  writeRequest(fixture.desktopInput, { id, method, params: {} });
                  const response = await fixture.collector.waitFor((message) =>
                    requestId(message, id),
                  );
                  expect(response.error).toBeUndefined();
                  return response.result;
                },
                addNotificationCallback(_method: string, callback: () => void) {
                  callbacks.add(callback);
                  return () => callbacks.delete(callback);
                },
              },
            };
            const memberships = {
              assignments: { [parentId]: inherited } as Record<string, ThreadProjectAssignment>,
              projectlessThreadIds: [] as string[],
            };
            const setMembership = vi.fn<
              AssignmentServices["threadProjectAssignments"]["setMembership"]
            >(async (input) => {
              if (input.assignment) memberships.assignments[input.threadId] = input.assignment;
              if (input.projectless) memberships.projectlessThreadIds.push(input.threadId);
            });
            const catalog = {
              localProjects: {},
              remoteProjects: [inherited, override].map((project) => ({
                id: project.projectId,
                hostId: project.hostId,
                remotePath: "/workspace",
                label: project.projectId,
              })),
              // Parent membership is available only through the live Desktop service.
              threadProjectAssignments: {},
              codexManagedRemoteConnections: [],
              projectOrder: [],
              readAt: new Date().toISOString(),
            };
            const owner = {
              setInterval: () => 0,
              clearInterval: () => {},
              localStorage: { getItem: () => null, setItem: () => {} },
              __codexhostHostRoutingV1: {
                knownHostIds: () => ["local", targetHostId],
                forHost: (id: string) =>
                  id === targetHostId
                    ? remote
                    : {
                        manager: {
                          sendRequest: async (method: string) => {
                            if (method === DESKTOP_PROJECTS_CATALOG_METHOD) return catalog;
                            if (method === DELEGATION_PROJECTS_METHOD) return { assignments: [] };
                            throw new Error(method);
                          },
                        },
                      },
              },
            } as unknown as Window;
            renderer = installRendererDelegationProjects(owner, async () => ({
              threadProjectAssignments: {
                readMemberships: async () => structuredClone(memberships),
                setMembership,
              },
            }));
            renderer.refresh();
            await vi.waitFor(() => expect(callbacks.size).toBe(1));
            if (!delegation) throw new Error("No delegation API");
            const child = await delegation.start({
              harnessId,
              task: "check project inheritance",
              cwd: "/different-folder",
              ...(crossHost
                ? {
                    parentThreadId: clientOrigin(
                      `peer:${encodeURIComponent(sourceHostId)}:${parentId}`,
                    ),
                  }
                : { parentThreadId: parentId }),
              ...(projectId !== undefined ? { projectId } : {}),
            });
            const expected =
              projectId === null ? null : projectId === "override" ? override : inherited;
            await vi.waitFor(() =>
              expect(setMembership).toHaveBeenCalledWith({
                hostId: targetHostId,
                threadId: child.threadId,
                assignment: expected,
                projectless: expected === null,
              }),
            );
            const saved = await fixture.mappingStore.getDelegationByChild(
              hostThreadIdSchema.parse(child.threadId),
            );
            expect(saved?.desktopProject).toEqual({
              ...(crossHost ? { sourceHostId } : {}),
              sourceThreadId: parentId,
              ...(projectId !== undefined ? { projectId } : {}),
            });
          } finally {
            renderer?.dispose();
            await stopFixture(fixture);
          }
        },
      );
    }
  }
});
