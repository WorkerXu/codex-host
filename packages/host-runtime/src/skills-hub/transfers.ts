import { randomUUID } from "node:crypto";
import { z } from "zod";
import { skillBundleSchema, type SkillBundle } from "@codexhost/shared-contracts";
import { fail } from "./files.js";

export const TRANSFER_CHARS = 512 * 1024;
export const MAX_TRANSFER_CHARS = 96 * 1024 * 1024;
const descriptor = skillBundleSchema.omit({ data: true });
export const skillExportSchema = descriptor.extend({
  data: z.string(),
  token: z.string().uuid().optional(),
  length: z.number().int().nonnegative().optional(),
});
export const skillChunkSchema = z.object({ data: z.string().max(TRANSFER_CHARS) }).strict();
interface Transfer {
  created: number;
  data: string;
  bundle: z.infer<typeof descriptor>;
  expected: string | null;
  length: number;
  direction: "in" | "out";
}
/** In-memory, single-use transfer tokens never identify filesystem paths. */
export class SkillTransfers {
  readonly #sessions = new Map<string, Transfer>();
  #prune(): void {
    for (const [id, session] of this.#sessions)
      if (Date.now() - session.created > 600_000) this.#sessions.delete(id);
  }
  #create(session: Transfer): string {
    this.#prune();
    const reserved = [...this.#sessions.values()].reduce((sum, entry) => sum + entry.length, 0);
    if (this.#sessions.size >= 8 || reserved + session.length > 2 * MAX_TRANSFER_CHARS)
      fail("too_many_transfers");
    const token = randomUUID();
    this.#sessions.set(token, session);
    return token;
  }
  export(bundle: SkillBundle): z.infer<typeof skillExportSchema> {
    if (bundle.data.length <= TRANSFER_CHARS) return bundle;
    const { data, ...metadata } = bundle;
    const token = this.#create({
      created: Date.now(),
      data,
      bundle: metadata,
      expected: null,
      length: data.length,
      direction: "out",
    });
    return { ...metadata, data: "", token, length: data.length };
  }
  chunk(value: unknown): { data: string } {
    const { token, offset } = z
      .object({
        token: z.string().uuid(),
        offset: z.number().int().nonnegative().max(MAX_TRANSFER_CHARS),
      })
      .strict()
      .parse(value);
    this.#prune();
    const session = this.#sessions.get(token);
    if (!session || session.direction !== "out" || offset >= session.length)
      fail("expired_transfer");
    const data = session.data.slice(offset, offset + TRANSFER_CHARS);
    if (offset + data.length >= session.length) this.#sessions.delete(token);
    return { data };
  }
  begin(value: unknown): { token: string } {
    const { bundle, expected, length } = z
      .object({
        bundle: descriptor,
        expected: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        length: z.number().int().positive().max(MAX_TRANSFER_CHARS),
      })
      .strict()
      .parse(value);
    return {
      token: this.#create({
        created: Date.now(),
        data: "",
        bundle,
        expected,
        length,
        direction: "in",
      }),
    };
  }
  append(value: unknown): { received: number } {
    const { token, offset, data } = z
      .object({
        token: z.string().uuid(),
        offset: z.number().int().nonnegative(),
        data: z
          .string()
          .min(1)
          .max(TRANSFER_CHARS)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/u),
      })
      .strict()
      .parse(value);
    this.#prune();
    const session = this.#sessions.get(token);
    if (
      !session ||
      session.direction !== "in" ||
      session.data.length !== offset ||
      offset + data.length > session.length
    )
      fail("invalid_transfer");
    session.data += data;
    return { received: session.data.length };
  }
  finish(value: unknown): { bundle: SkillBundle; expected: string | null } {
    const { token } = z.object({ token: z.string().uuid() }).strict().parse(value);
    this.#prune();
    const session = this.#sessions.get(token);
    this.#sessions.delete(token);
    if (!session || session.direction !== "in" || session.data.length !== session.length)
      fail("invalid_transfer");
    return { bundle: { ...session.bundle, data: session.data }, expected: session.expected };
  }
}
