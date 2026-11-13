import { describe, expect, it } from "vitest";

import {
  DINGTALK_EVENT_TYPES,
  DEFAULT_DINGTALK_MATCH_THRESHOLD,
  defaultDingTalkDispatchSettings,
  dingtalkDispatchSettingsSchema,
} from "../src/dingtalk-dispatch.js";

describe("DingTalk dispatch settings contract", () => {
  it("defaults to a disabled listener with every event, 0.85 and group replies", () => {
    const settings = defaultDingTalkDispatchSettings(["terra_worker"]);
    expect(settings).toEqual({
      enabled: false,
      eventTypes: [...DINGTALK_EVENT_TYPES],
      matchThreshold: 0.85,
      replyScope: "group",
      participatingAgents: ["terra_worker"],
    });
    expect(DEFAULT_DINGTALK_MATCH_THRESHOLD).toBe(0.85);
  });

  it("keeps the default agent list bounded by the agent-name rule", () => {
    const settings = defaultDingTalkDispatchSettings(["terra_worker", "bad name", "ok-agent"]);
    expect(settings.participatingAgents).toEqual(["terra_worker", "ok-agent"]);
  });

  it("rejects out-of-range thresholds and unknown events", () => {
    const valid = defaultDingTalkDispatchSettings([]);
    expect(dingtalkDispatchSettingsSchema.safeParse(valid).success).toBe(true);
    expect(
      dingtalkDispatchSettingsSchema.safeParse({ ...valid, matchThreshold: 1.01 }).success,
    ).toBe(false);
    expect(
      dingtalkDispatchSettingsSchema.safeParse({ ...valid, matchThreshold: -0.01 }).success,
    ).toBe(false);
    expect(
      dingtalkDispatchSettingsSchema.safeParse({
        ...valid,
        eventTypes: ["mention_me", "approval_approved"],
      }).success,
    ).toBe(false);
    expect(
      dingtalkDispatchSettingsSchema.safeParse({
        ...valid,
        replyScope: "email",
      }).success,
    ).toBe(false);
  });

  it("rejects repeated events and agents", () => {
    const valid = defaultDingTalkDispatchSettings([]);
    expect(
      dingtalkDispatchSettingsSchema.safeParse({
        ...valid,
        eventTypes: ["mention_me", "mention_me"],
      }).success,
    ).toBe(false);
    expect(
      dingtalkDispatchSettingsSchema.safeParse({
        ...valid,
        participatingAgents: ["terra_worker", "terra_worker"],
      }).success,
    ).toBe(false);
  });
});
