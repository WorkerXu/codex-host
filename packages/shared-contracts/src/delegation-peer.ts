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
