export interface AgentDeletionRequest {
  fileName: string;
  revision: string;
  remove(fileName: string, revision: string): Promise<void>;
  /** Refreshes cards and DingTalk participation after the file is gone. */
  reload(): Promise<void>;
  /** `revision_conflict` and `not_found` mean the list is out of date. */
  isStale(error: unknown): boolean;
}

export interface AgentDeletionResult {
  ok: boolean;
  /** The list was refreshed because the file changed outside this page. */
  refreshed: boolean;
}

/**
 * Deletes one agent file and refreshes the page. Failures are reported to the
 * caller instead of throwing, so the dialog can stay open with the reason.
 */
export async function deleteCodexAgent(
  request: AgentDeletionRequest,
): Promise<AgentDeletionResult> {
  try {
    await request.remove(request.fileName, request.revision);
    await request.reload();
    return { ok: true, refreshed: true };
  } catch (error) {
    if (!request.isStale(error)) return { ok: false, refreshed: false };
    await request.reload();
    return { ok: false, refreshed: true };
  }
}
