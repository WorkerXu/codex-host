import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createDingTalkTransport } from "../src/dingtalk-transport.js";
import type { PeerProcess, PeerSpawn } from "../src/peer-transport.js";

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
}
describe("DingTalk peer event streaming (fake SSH)", () => {
  it("runs dws on tencent, preserves split NDJSON and releases SSH on stop", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-peer-events-"));
    const child = processFixture();
    const spawn = vi.fn<PeerSpawn>(() => child as PeerProcess);
    const transport = createDingTalkTransport({
      environment: {
        HOME: directory,
        CODEXHOST_USER_DIR: directory,
        CODEXHOST_RUNTIME_TOKEN: "must-not-leave-mac",
      },
      peerSpawnImpl: spawn as PeerSpawn,
    });
    try {
      await transport.refresh();
      transport.configure({
        name: "tencent",
        hostId: "host-tencent",
        local: false,
        peer: {
          name: "tencent",
          ssh: "tencent",
          hostIds: ["host-tencent"],
          linkHostId: "host-tencent",
        },
      });
      const received = vi.fn();
      const stream = await transport.openEvents({ onRecord: received });
      expect(spawn.mock.calls[0]?.[1]).toEqual(
        expect.arrayContaining([
          "tencent",
          "~/.local/bin/dws",
          "event",
          "consume",
          "user_im_message_receive_o2o_all",
          "user_im_message_receive_group_all",
          "--flatten",
          "ndjson",
        ]),
      );
      expect(spawn.mock.calls[0]?.[2].env).not.toHaveProperty("CODEXHOST_RUNTIME_TOKEN");
      const line = JSON.stringify({
        type: "user_im_message_receive_o2o_all",
        message_id: "m1",
        conversation_id: "dm1",
        sender: "林晓",
        sender_open_dingtalk_id: "open-lin",
        content: "hi",
        event_time: 2000,
      });
      child.stdout.write(line.slice(0, 20));
      child.stdout.write(line.slice(20) + "\n");
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "direct", senderId: "open-lin" }),
      );
      stream?.stop();
      stream?.stop();
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
