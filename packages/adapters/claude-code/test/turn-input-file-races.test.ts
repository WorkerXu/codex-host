import { beforeEach, describe, expect, it, vi } from "vitest";

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", () => ({ open }));

import { claudeUserContent } from "../src/turn-input.js";

describe("Claude image attachment changes during read", () => {
  beforeEach(() => open.mockReset());

  it.each([32, 34])("leaves a changed file of %i bytes as path text", async (size) => {
    const bytes = Buffer.alloc(size);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    const close = vi.fn().mockResolvedValue(undefined);
    open.mockResolvedValue({
      stat: async () => ({ isFile: () => true, size: 33 }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = bytes.copy(buffer, offset, position, position + length);
        return { bytesRead, buffer };
      },
      close,
    });
    const text =
      "# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\nImage attachment: true\n\n## My request:\nLook";
    await expect(claudeUserContent(text)).resolves.toBe(text);
    expect(close).toHaveBeenCalledOnce();
  });
});
