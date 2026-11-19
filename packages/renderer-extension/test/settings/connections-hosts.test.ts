import { describe, expect, it } from "vitest";

import {
  visibleConnectionHosts,
  type RendererConnectionHostSnapshot,
} from "../../src/settings/connections-page.js";

const host = (hostId: string): RendererConnectionHostSnapshot => ({
  hostId,
  active: false,
  agents: [],
});

describe("Connections Host list", () => {
  it("hides Desktop's reserved durable execution Host", () => {
    expect(visibleConnectionHosts([host("local"), host("durable"), host("remote")])).toEqual([
      host("local"),
      host("remote"),
    ]);
    expect(visibleConnectionHosts([host("durable")])).toEqual([]);
  });
});
