import type { StoredDelegationRecordV1 } from "@codexhost/mapping-store";
import { delegationProjectsResultSchema } from "@codexhost/shared-contracts";

import { originClientName } from "./external-client-origin.js";

export function delegationDesktopProject(
  parentThreadId: string,
  projectId: string | null | undefined,
): NonNullable<StoredDelegationRecordV1["desktopProject"]> | undefined {
  const client = originClientName(parentThreadId);
  const peer = client?.match(/^peer:([^:]+)(?::([A-Za-z0-9._-]+))?$/u);
  let sourceHostId: string | undefined;
  try {
    if (peer?.[1]) sourceHostId = decodeURIComponent(peer[1]);
  } catch {
    return undefined;
  }
  const sourceThreadId = client === undefined ? parentThreadId : peer?.[2];
  if (sourceThreadId === undefined && projectId === undefined) return undefined;
  return {
    ...(sourceHostId ? { sourceHostId } : {}),
    ...(sourceThreadId ? { sourceThreadId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

export function delegationProjectAssignments(delegations: readonly StoredDelegationRecordV1[]) {
  return delegationProjectsResultSchema.parse({
    assignments: delegations.flatMap((entry) =>
      entry.desktopProject ? [{ threadId: entry.childHostThreadId, ...entry.desktopProject }] : [],
    ),
  });
}
