import { describe, expect, it, vi } from "vitest";
import {
  attachmentContextPaths,
  uploadPreparedRemoteAttachments,
} from "../src/renderer-rpc-remote-attachments.js";

const image = "/Users/me/Downloads/shot.jpg";
const file = "/Users/me/notes/plan.md";
const manifest =
  "# Files mentioned by the user:\n\n" +
  `## shot.jpg: ${image}\nImage attachment: true\n\n` +
  `## plan.md: ${file} (lines 3-9)\n\n` +
  `## My request:\nlook at ${image}`;

function rpc(provider = "codexhost", fail: string[] = []) {
  const uploadLocalFileAttachments = vi.fn(
    async ({ attachments }: { attachments: { path: string; label: string }[] }) => {
      const [attachment] = attachments;
      if (!attachment || fail.includes(attachment.path)) throw new Error("ENOENT");
      return [{ ...attachment, path: `/home/u/.codex/attachments/x/${attachment.label}` }];
    },
  );
  return {
    uploadLocalFileAttachments,
    getConversation: vi.fn(async () => ({ modelProvider: provider })),
  };
}
const prepared = () => ({
  conversationId: "thread",
  steer: {
    input: [
      { type: "text", text: manifest },
      { type: "image", url: "data:image/jpeg;base64,AA==" },
    ],
  },
  start: {
    request: {
      input: [
        { type: "text", text: manifest },
        { type: "localImage", path: image },
      ],
      additionalContext: { kept: true },
    },
  },
});

describe("remote attachment upload during RPC preparation", () => {
  it("reads image and file paths from the attachment context only", () => {
    expect(attachmentContextPaths(manifest)).toEqual([image, file]);
    expect(attachmentContextPaths(`look at ${image}`)).toEqual([]);
  });

  it("uploads each local image and file once and rewrites the context, not the request", async () => {
    const target = rpc();
    const uploads = new Map();
    const result = await uploadPreparedRemoteAttachments(
      target,
      "remote-ssh:host",
      prepared(),
      uploads,
      () => {},
    );
    await uploadPreparedRemoteAttachments(target, "remote-ssh:host", prepared(), uploads, () => {});
    expect(target.uploadLocalFileAttachments).toHaveBeenCalledTimes(2);
    const start = result.start as { request: { input: { text?: string; path?: string }[] } };
    const text = start.request.input[0]?.text ?? "";
    expect(text).toContain("## shot.jpg: /home/u/.codex/attachments/x/shot.jpg\n");
    expect(text).toContain("## plan.md: /home/u/.codex/attachments/x/plan.md (lines 3-9)\n");
    expect(text.endsWith(`look at ${image}`)).toBe(true);
    expect(start.request.input[1]?.path).toBe("/home/u/.codex/attachments/x/shot.jpg");
    expect(result.start).toMatchObject({ request: { additionalContext: { kept: true } } });
    const steer = result.steer as { input: { text?: string }[] };
    expect(steer.input[0]?.text).toBe(text);
  });

  it("keeps paths the native upload cannot read, and leaves official or local Threads alone", async () => {
    const failing = rpc("codexhost", [image, file]);
    const original = prepared();
    expect(
      await uploadPreparedRemoteAttachments(failing, "remote", original, new Map(), () => {}),
    ).toBe(original);
    const official = rpc("openai");
    expect(
      await uploadPreparedRemoteAttachments(official, "remote", original, new Map(), () => {}),
    ).toBe(original);
    expect(official.uploadLocalFileAttachments).not.toHaveBeenCalled();
    const local = rpc();
    expect(
      await uploadPreparedRemoteAttachments(local, "local", original, new Map(), () => {}),
    ).toBe(original);
    expect(local.getConversation).not.toHaveBeenCalled();
  });
});
