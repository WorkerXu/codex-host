import { z } from "zod";

/** Renderer-facing catalog of machines configured for cross-host delegation. */
export const DELEGATION_PEER_LIST_METHOD = "codexhost/delegation/peers/list";

export const delegationPeerListParamsSchema = z
  .object({
    /** Bypass the Host Runtime's short cache. */
    refresh: z.boolean().optional(),
  })
  .strict();

export const delegationPeerStateSchema = z.enum(["ready", "unreachable"]);

export const delegationPeerCatalogEntrySchema = z
  .object({
    /** Peer name used in --host and in a mention's hostId. */
    name: z.string().min(1).max(256),
    hostIds: z.array(z.string().min(1).max(1024)),
    /** SSH alias from peers.json, used only to match a Desktop display name. */
    ssh: z.string().min(1).max(256).optional(),
    state: delegationPeerStateSchema,
    /** Harness IDs reported by the peer's `harness list`. */
    harnesses: z.array(z.string().min(1).max(256)),
    /** Bounded diagnostic for an unreachable peer. */
    error: z.string().max(1024).optional(),
  })
  .strict();

export const delegationPeerCatalogSchema = z
  .object({
    peers: z.array(delegationPeerCatalogEntrySchema),
    self: z
      .object({
        hostIds: z.array(z.string().min(1).max(1024)),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DelegationPeerListParams = z.infer<typeof delegationPeerListParamsSchema>;
export type DelegationPeerState = z.infer<typeof delegationPeerStateSchema>;
export type DelegationPeerCatalogEntry = z.infer<typeof delegationPeerCatalogEntrySchema>;
export type DelegationPeerCatalog = z.infer<typeof delegationPeerCatalogSchema>;

export const WEB_DELEGATION_PEERS_METHOD = "codexhost/web/delegation/peers/list";

const webDelegationPeerIdentity = {
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
  label: z.string().min(1),
};

export const webDelegationPeersSchema = z
  .object({
    peers: z.array(
      z.discriminatedUnion("status", [
        z
          .object({
            ...webDelegationPeerIdentity,
            status: z.literal("ready"),
            harnesses: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/u)),
          })
          .strict(),
        z.object({ ...webDelegationPeerIdentity, status: z.enum(["timeout", "failed"]) }).strict(),
      ]),
    ),
  })
  .strict();
export type WebDelegationPeers = z.infer<typeof webDelegationPeersSchema>;
