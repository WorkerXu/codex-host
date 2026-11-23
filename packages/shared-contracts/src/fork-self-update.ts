import policy from "./fork-self-update.json" with { type: "json" };

export const FORK_SELF_UPDATE_ENABLED: boolean = policy.enabled;
export const FORK_SELF_UPDATE_DISABLED_MESSAGE = policy.disabledMessage;

export function requireForkSelfUpdate(): void {
  if (!FORK_SELF_UPDATE_ENABLED) throw new Error(FORK_SELF_UPDATE_DISABLED_MESSAGE);
}
