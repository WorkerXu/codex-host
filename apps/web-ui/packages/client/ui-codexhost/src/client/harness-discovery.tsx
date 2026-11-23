/** Web product discovery over the existing slash menu and shared Harness catalog. */
import type { ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-model-selection/client";
import type {} from "@deepseek-ai/dsh-client-ui-commands/client";
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  CandidateRequest,
  InputTriggerCandidate,
  InputTriggerPick,
} from "@deepseek-ai/dsh-client-ui-input-trigger/client";
import {
  formatDelegationMentionLink,
  type DelegationMention,
  type HarnessCommandDescriptor,
  type HarnessCommandCatalog,
} from "@codexhost/shared-contracts";
import {
  RemotePluginIcon,
  IconDataOutlineRegular,
  type IconProps,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { harnessCommandApi, listDelegationPeers } from "./api.ts";
import { HARNESS_COMMAND_SOURCE, harnessCommandReference } from "./harness-command-reference.ts";
import type {} from "./HostConnectionStatus.tsx";

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionMap {
    nativeDiscovery: boolean | null;
  }
}
const AGENTS = "codexhost-delegation";
const PEER_AGENTS = "codexhost-peer-delegation";

function agentIcon(id: string) {
  return (props: IconProps) => (
    <RemotePluginIcon
      id={id}
      src={`/harness-icons/${encodeURIComponent(id)}`}
      presentationUrl="/harness-icons/presentation.json"
      size={props.size ?? 14}
      fallback={<IconDataOutlineRegular size={props.size ?? 14} />}
    />
  );
}

function insertDelegationMention(mention: DelegationMention) {
  const ref = formatDelegationMentionLink(mention);
  return {
    insert: {
      source: AGENTS,
      ref,
      label: mention.label,
      appearance: "session" as const,
      clipboardText: ref,
    },
  };
}

export function registerHarnessDiscovery(ctx: Context): void {
  const connection = ctx.get("connection") as ConnectionHandle;
  const cache = new Map<
    SessionId,
    {
      epoch: object | undefined;
      generation: number;
      connection: string | undefined;
      promise: Promise<{ catalog: HarnessCommandCatalog; reserved: ReadonlySet<string> }>;
    }
  >();
  const selected = new WeakMap<
    InputTriggerCandidate,
    { command: HarnessCommandDescriptor; entry: object }
  >();
  const peerCatalogs = new WeakMap<
    object,
    { generation: number; promise: ReturnType<typeof listDelegationPeers> }
  >();
  const peerMentions = new WeakMap<
    InputTriggerCandidate,
    { generation: number; mention: DelegationMention }
  >();
  const pending = new Set<SessionId>();
  let generation = 0;
  const listeners = new Set<() => void>();
  const t = ctx.locale.bind("codexhostImport");
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const supported = (id: SessionId) => {
    const row = ctx.sessions.list.getSnapshot().byId[id];
    if (!row || ctx.sessions.subagentAddress(id) !== undefined) return false;
    // A Codex draft has no Thread yet; the Host lists its workspace Skills from the draft's cwd.
    if (row.blank)
      return (
        row.projectionValues?.harnessIdentity?.id === "codex" &&
        (row.projectionValues.threadReference?.hostId ?? "local") === "local"
      );
    return (
      row.projectionValues?.nativeDiscovery === true &&
      row.projectionValues.threadReference?.hostId === "local"
    );
  };
  const supportsDelegation = (id: SessionId) => {
    const row = ctx.sessions.list.getSnapshot().byId[id];
    return (
      supported(id) ||
      (row?.blank === true &&
        row.projectionValues?.harnessIdentity != null &&
        ctx.sessions.subagentAddress(id) === undefined)
    );
  };
  const reason = (id: SessionId): string | undefined => {
    const row = ctx.sessions.list.getSnapshot().byId[id];
    if (
      !connection.generation.getSnapshot() ||
      row?.projectionValues?.nativeConnection?.state === "reconnecting"
    )
      return t("discovery.offline");
    if (pending.has(id)) return t("discovery.pending");
    if (row?.running) return t("discovery.busy");
    return undefined;
  };
  const input = (id: SessionId) => {
    const scope = ctx.sessions.scope(id);
    return scope?.get("conversation")?.input.for(scope);
  };
  const notify = (id: SessionId, text: string) => input(id)?.notify("error", text);
  const read = (id: SessionId, req: CandidateRequest) => {
    let entry = cache.get(id);
    if (!entry || entry.epoch !== req.menuEpoch || entry.generation !== generation) {
      entry = {
        epoch: req.menuEpoch,
        generation,
        connection:
          ctx.sessions.list.getSnapshot().byId[id]?.projectionValues?.nativeConnection?.state,
        promise: Promise.all([
          harnessCommandApi.inspect(id),
          ctx.commandUi.reservedNames({ sessionId: id }),
        ]).then(([catalog, reserved]) => ({ catalog, reserved })),
      };
      cache.set(id, entry);
    }
    return entry;
  };
  const subscribe = ({ sessionId }: { sessionId: SessionId }, listener: () => void) => {
    listeners.add(listener);
    const off = ctx.sessions.list.subscribe(listener);
    const catalogOff = ctx.modelDirectories.harnessCatalog.subscribe(listener);
    return () => {
      listeners.delete(listener);
      off();
      catalogOff();
      cache.delete(sessionId);
    };
  };
  ctx.effect(
    () =>
      connection.generation.subscribe(() => {
        generation++;
        cache.clear();
        changed();
      }),
    "ui-codexhost: browser connection generation",
  );
  // Native Host reconnects are projected independently of the browser transport.
  ctx.effect(
    () =>
      ctx.sessions.list.subscribe(() => {
        let invalidated = false;
        const rows = ctx.sessions.list.getSnapshot().byId;
        for (const [id, entry] of cache) {
          if (entry.connection !== rows[id]?.projectionValues?.nativeConnection?.state) {
            cache.delete(id);
            invalidated = true;
          }
        }
        if (invalidated) changed();
      }),
    "ui-codexhost: discovery connection generation",
  );

  const execute = (pick: InputTriggerPick, commandId: string) => {
    const id = pick.session.sessionId;
    const disabled = reason(id);
    if (!supported(id) || disabled) {
      notify(id, disabled ?? t("discovery.stale"));
      return;
    }
    const scope = ctx.sessions.scope(id);
    const composer = input(id);
    if (!scope || composer?.state.getSnapshot().draftRev !== pick.span.draftRev) return;
    if (
      pick.span.start !== pick.span.end &&
      scope.bail(scope, "slash/input-consume-token", {
        guard: { kind: "span", span: pick.span },
      }) !== true
    )
      return;
    pending.add(id);
    changed();
    // Never resend after an uncertain write. Accepted is admission; the Thread renders progress.
    void harnessCommandApi
      .execute(id, commandId)
      .catch((error: unknown) =>
        notify(
          id,
          `${t("discovery.unconfirmed")} ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      .finally(() => {
        pending.delete(id);
        changed();
      });
  };

  ctx.effect(
    () =>
      ctx.inputTriggers.registerSource({
        trigger: "/",
        aliases: ["#", "@"],
        name: HARNESS_COMMAND_SOURCE,
        codec: { clipboardText: (ref) => ref, serialize: async (ref) => ref },
        launcher: "command",
        order: 20,
        showGroupTitle: false,
        subscribeCandidates: subscribe,
        candidates: async ({ sessionId }, req) => {
          if (!supported(sessionId)) return [];
          if (!connection.generation.getSnapshot())
            return [
              {
                name: t("discovery.retry"),
                value: "retry",
                section: t("discovery.commands"),
                description: t("discovery.offline"),
              },
            ];
          const entry = read(sessionId, req);
          try {
            const { catalog, reserved } = await entry.promise;
            if (cache.get(sessionId) !== entry || !supported(sessionId)) return [];
            const query = req.query.toLocaleLowerCase();
            const codex =
              ctx.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.harnessIdentity
                ?.id === "codex";
            const rows: InputTriggerCandidate[] = catalog.commands
              .filter((command) =>
                `${command.invocation} ${command.label}`.toLocaleLowerCase().includes(query),
              )
              .map((command) => {
                const nativeCodexSkill = codex && command.kind === "skill";
                const disabledReason = reserved.has(command.invocation)
                  ? t("discovery.conflict")
                  : command.argumentMode === "none" || command.invocation === "/compact"
                    ? reason(sessionId)
                    : undefined;
                const row: InputTriggerCandidate = {
                  name: command.invocation,
                  label: nativeCodexSkill
                    ? command.label.replace(/^\/?skill:/iu, "")
                    : command.label,
                  showAlias: !nativeCodexSkill,
                  value: command.id,
                  section: t(nativeCodexSkill ? "discovery.skills" : "discovery.commands"),
                  description: command.description,
                  ...(disabledReason ? { disabledReason } : {}),
                };
                selected.set(row, { command, entry });
                return row;
              });
            if (catalog.warnings?.length && !query)
              rows.push({
                name: t("discovery.retry"),
                value: "retry",
                section: t("discovery.commands"),
                description: catalog.warnings.join("\n"),
              });
            if (catalog.source === "static" && !query)
              rows.push({
                name: t("discovery.static"),
                disabledReason: t("discovery.static"),
                section: t("discovery.commands"),
              });
            if (!catalog.commands.length && !query && catalog.source !== "static")
              rows.push({
                name: t("discovery.empty"),
                disabledReason: t("discovery.empty"),
                section: t("discovery.commands"),
              });
            return codex
              ? rows.toSorted(
                  (a, b) =>
                    Number(a.section === t("discovery.skills")) -
                    Number(b.section === t("discovery.skills")),
                )
              : rows;
          } catch (error) {
            if (cache.get(sessionId) !== entry) return [];
            return [
              {
                name: t("discovery.retry"),
                value: "retry",
                section: t("discovery.commands"),
                description: `${t("discovery.failed")} ${error instanceof Error ? error.message : String(error)}`,
              },
            ];
          }
        },
        onPick: (pick) => {
          const id = pick.session.sessionId;
          if (!supported(id)) {
            notify(id, t("discovery.stale"));
            return "handled";
          }
          if (pick.candidate.value === "retry") {
            cache.delete(id);
            return "refresh";
          }
          const entry = cache.get(id);
          if (!entry || entry.generation !== generation) {
            notify(id, t("discovery.stale"));
            return "handled";
          }
          // Rows carry stable IDs. Re-read the exact snapshot synchronously before any edit or write.
          const commandId = pick.candidate.value;
          if (!commandId) return "handled";
          if (pick.candidate.disabledReason) return "handled";
          // Descriptor metadata is retained alongside the row, never guessed from its label.
          const snapshot = selected.get(pick.candidate);
          const command = snapshot?.entry === entry ? snapshot.command : undefined;
          if (!command) {
            notify(id, t("discovery.stale"));
            return "handled";
          }
          if (command.argumentMode === "none" || command.invocation === "/compact") {
            execute(pick, commandId);
            return "handled";
          }
          try {
            return { insert: harnessCommandReference(command.invocation) };
          } catch {
            notify(id, t("discovery.stale"));
            return "handled";
          }
        },
      }),
    "ui-codexhost: native discovery",
  );

  ctx.effect(
    () =>
      ctx.inputTriggers.registerSource({
        trigger: "@",
        aliases: ["#"],
        name: AGENTS,
        launcher: "command",
        launcherOrder: 30,
        order: 10,
        showGroupTitle: false,
        codec: { clipboardText: (ref) => ref, serialize: async (ref) => ref },
        subscribeCandidates: subscribe,
        candidates: async ({ sessionId }, req) => {
          if (!supportsDelegation(sessionId)) return [];
          const catalog = ctx.modelDirectories.harnessCatalog.getSnapshot().value;
          return (catalog?.groups ?? [])
            .filter((group) =>
              `${group.name} ${group.id}`
                .toLocaleLowerCase()
                .includes(req.query.toLocaleLowerCase()),
            )
            .map((group) => ({
              name: group.id,
              label: group.name,
              value: group.id,
              section: t("discovery.agents"),
              icon: agentIcon(group.id),
            }));
        },
        onPick: (pick) => {
          const group = ctx.modelDirectories.harnessCatalog
            .getSnapshot()
            .value?.groups.find((item) => item.id === pick.candidate.value);
          if (!supportsDelegation(pick.session.sessionId) || !group) {
            notify(pick.session.sessionId, t("discovery.stale"));
            return "handled";
          }
          return insertDelegationMention({ harnessId: group.id, label: group.name });
        },
      }),
    "ui-codexhost: delegation discovery",
  );

  ctx.effect(
    () =>
      ctx.inputTriggers.registerSource({
        trigger: "@",
        aliases: ["#"],
        name: PEER_AGENTS,
        launcher: "command",
        launcherOrder: 31,
        order: 11,
        showGroupTitle: false,
        subscribeCandidates: subscribe,
        candidates: async ({ sessionId }, req) => {
          if (!supportsDelegation(sessionId) || !connection.generation.getSnapshot()) return [];
          const epoch = req.menuEpoch ?? {};
          let entry = peerCatalogs.get(epoch);
          if (!entry || entry.generation !== generation) {
            entry = { generation, promise: listDelegationPeers() };
            peerCatalogs.set(epoch, entry);
          }
          const section = t("discovery.otherMachines");
          const query = req.query.trim().toLocaleLowerCase();
          try {
            const { peers } = await entry.promise;
            if (req.signal.aborted || generation !== entry.generation) return [];
            const groups = ctx.modelDirectories.harnessCatalog.getSnapshot().value?.groups ?? [];
            return peers.flatMap((peer): InputTriggerCandidate[] => {
              const machine = `${peer.name} ${peer.label}`.toLocaleLowerCase();
              if (peer.status !== "ready") {
                return machine.includes(query)
                  ? [
                      {
                        name: peer.label,
                        section,
                        disabledReason: t(
                          peer.status === "timeout"
                            ? "discovery.peerTimeout"
                            : "discovery.peerFailed",
                        ),
                      },
                    ]
                  : [];
              }
              return peer.harnesses.flatMap((id) => {
                const name = groups.find((group) => group.id === id)?.name ?? id;
                if (!`${machine} ${id} ${name}`.toLocaleLowerCase().includes(query)) return [];
                const row: InputTriggerCandidate = {
                  name: id,
                  label: name,
                  showAlias: false,
                  section: `${section} · ${peer.label}`,
                  icon: agentIcon(id),
                };
                peerMentions.set(row, {
                  generation,
                  mention: { hostId: peer.name, harnessId: id, label: `${name} · ${peer.label}` },
                });
                return [row];
              });
            });
          } catch {
            return query ? [] : [{ name: section, disabledReason: t("discovery.peerFailed") }];
          }
        },
        onPick: (pick) => {
          const target = peerMentions.get(pick.candidate);
          if (
            target?.generation !== generation ||
            !supportsDelegation(pick.session.sessionId) ||
            !connection.generation.getSnapshot()
          ) {
            notify(pick.session.sessionId, t("discovery.stale"));
            return "handled";
          }
          return insertDelegationMention(target.mention);
        },
      }),
    "ui-codexhost: peer delegation discovery",
  );
}
