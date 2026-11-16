import { describe, expect, it } from "vitest";

import {
  DINGTALK_EVENT_TYPES,
  DEFAULT_DINGTALK_MATCH_THRESHOLD,
  defaultDingTalkAgentDispatch,
  defaultDingTalkDispatchSettings,
  dingtalkAgentDispatchFor,
  dingtalkDispatchSettingsSchema,
  dingtalkDispatchTargets,
} from "../src/dingtalk-dispatch.js";

describe("DingTalk dispatch settings contract", () => {
  it("defaults to 0.85 with every agent off", () => {
    const settings = defaultDingTalkDispatchSettings();
    expect(settings).toEqual({ threshold: 0.85, agents: {} });
    expect(DEFAULT_DINGTALK_MATCH_THRESHOLD).toBe(0.85);
    expect(defaultDingTalkAgentDispatch()).toEqual({
      enabled: false,
      eventTypes: [...DINGTALK_EVENT_TYPES],
      replyScope: "group",
    });
  });

  it("resolves a missing agent to off instead of throwing", () => {
    expect(dingtalkAgentDispatchFor(defaultDingTalkDispatchSettings(), "missing.toml")).toEqual(
      defaultDingTalkAgentDispatch(),
    );
  });

  it("rejects out-of-range thresholds and unknown events", () => {
    const valid = defaultDingTalkDispatchSettings();
    expect(dingtalkDispatchSettingsSchema.safeParse(valid).success).toBe(true);
    expect(
      dingtalkDispatchSettingsSchema.safeParse({
        ...valid,
        agents: {
          "terra-worker.toml": {
            enabled: true,
            eventTypes: ["mention_me", "approval_approved"],
            replyScope: "group",
          },
        },
      }).success,
    ).toBe(false);
    expect(dingtalkDispatchSettingsSchema.safeParse({ ...valid, threshold: 1.01 }).success).toBe(
      false,
    );
    expect(dingtalkDispatchSettingsSchema.safeParse({ ...valid, threshold: -0.01 }).success).toBe(
      false,
    );
    expect(
      dingtalkDispatchSettingsSchema.safeParse({
        ...valid,
        agents: {
          "terra-worker.toml": { enabled: true, eventTypes: [], replyScope: "email" },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects repeated events, invalid file names and the old global shape", () => {
    const valid = defaultDingTalkDispatchSettings();
    expect(
      dingtalkDispatchSettingsSchema.safeParse({
        ...valid,
        agents: {
          "terra-worker.toml": {
            enabled: true,
            eventTypes: ["mention_me", "mention_me"],
            replyScope: "group",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      dingtalkDispatchSettingsSchema.safeParse({
        ...valid,
        agents: {
          "../escape.toml": { enabled: true, eventTypes: ["mention_me"], replyScope: "group" },
        },
      }).success,
    ).toBe(false);
    expect(
      dingtalkDispatchSettingsSchema.safeParse({
        enabled: true,
        eventTypes: ["mention_me"],
        matchThreshold: 0.85,
        replyScope: "group",
        participatingAgents: ["terra_worker"],
      }).success,
    ).toBe(false);
  });

  it("filters dispatchers by each agent's own event types and reply scope", () => {
    const settings = {
      threshold: 0.85,
      agents: {
        "reviewer.toml": {
          enabled: true,
          eventTypes: ["mention_me" as const],
          replyScope: "group" as const,
        },
        "writer.toml": {
          enabled: true,
          eventTypes: ["mention_me" as const, "approval_pending" as const],
          replyScope: "direct" as const,
        },
        "ops.toml": {
          enabled: false,
          eventTypes: [...DINGTALK_EVENT_TYPES],
          replyScope: "group" as const,
        },
      },
    };
    expect(dingtalkDispatchTargets(settings, "mention_me")).toEqual([
      { fileName: "reviewer.toml", replyScope: "group" },
      { fileName: "writer.toml", replyScope: "direct" },
    ]);
    expect(dingtalkDispatchTargets(settings, "approval_pending")).toEqual([
      { fileName: "writer.toml", replyScope: "direct" },
    ]);
    expect(dingtalkDispatchTargets(settings, "mention_all")).toEqual([]);
  });
});
