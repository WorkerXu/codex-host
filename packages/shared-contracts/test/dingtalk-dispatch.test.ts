import { describe, expect, it } from "vitest";

import {
  DINGTALK_DISPATCH_DEFAULT_PICK_MIN,
  defaultDingTalkAgentDispatch,
  defaultDingTalkDispatchSettings,
  dingtalkAgentDispatchFor,
  dingtalkAgentReadyForDispatch,
  dingtalkDispatchRunParamsSchema,
  dingtalkDispatchRunResultSchema,
  dingtalkDispatchScoreResultSchema,
  dingtalkDispatchSettingsSchema,
} from "../src/dingtalk-dispatch.js";

describe("DingTalk manual dispatch contract", () => {
  it("defaults to an off agent with no automatic event types", () => {
    expect(defaultDingTalkDispatchSettings()).toEqual({ agents: {} });
    expect(defaultDingTalkAgentDispatch()).toEqual({
      enabled: false,
      replyScope: "group",
      sectionId: null,
      projectId: null,
      projectPath: null,
      projectRoots: [],
    });
    expect(DINGTALK_DISPATCH_DEFAULT_PICK_MIN).toBe(0.3);
  });

  it("resolves a missing agent to off instead of throwing", () => {
    expect(dingtalkAgentDispatchFor(defaultDingTalkDispatchSettings(), "missing.toml")).toEqual(
      defaultDingTalkAgentDispatch(),
    );
  });

  it("ignores retired eventTypes and threshold keys while keeping enabled and replyScope", () => {
    const parsed = dingtalkDispatchSettingsSchema.parse({
      threshold: 0.85,
      agents: {
        "old.toml": {
          enabled: true,
          eventTypes: ["mention_me", "approval_pending"],
          replyScope: "direct",
        },
      },
    });
    expect(parsed).toEqual({
      agents: {
        "old.toml": {
          enabled: true,
          replyScope: "direct",
          sectionId: null,
          projectId: null,
          projectPath: null,
          projectRoots: [],
        },
      },
    });
  });

  it("rejects a bad reply scope and invalid file names", () => {
    expect(
      dingtalkDispatchSettingsSchema.safeParse({
        agents: { "terra-worker.toml": { enabled: true, replyScope: "email" } },
      }).success,
    ).toBe(false);
    expect(
      dingtalkDispatchSettingsSchema.safeParse({
        agents: { "../escape.toml": { enabled: true, replyScope: "group" } },
      }).success,
    ).toBe(false);
  });

  it("requires the section, project and path before an agent can be dispatched", () => {
    expect(dingtalkAgentReadyForDispatch(undefined)).toBe(false);
    expect(
      dingtalkAgentReadyForDispatch({ ...defaultDingTalkAgentDispatch(), enabled: true }),
    ).toBe(false);
    expect(
      dingtalkAgentReadyForDispatch({
        enabled: true,
        replyScope: "group",
        sectionId: "section",
        projectId: "project",
        projectPath: "/Users/me/project",
        projectRoots: ["/Users/me/project"],
      }),
    ).toBe(true);
    expect(
      dingtalkAgentReadyForDispatch({
        enabled: false,
        replyScope: "group",
        sectionId: "section",
        projectId: "project",
        projectPath: "/Users/me/project",
        projectRoots: ["/Users/me/project"],
      }),
    ).toBe(false);
  });

  it("parses score and run results sorted by the panel", () => {
    const score = dingtalkDispatchScoreResultSchema.parse({
      failed: false,
      agents: [
        {
          agent: {
            fileName: "a.toml",
            name: "A",
            description: "duty",
            ready: true,
          },
          score: 0.8,
        },
      ],
    });
    expect(score.agents[0]?.score).toBe(0.8);
    expect(
      dingtalkDispatchRunParamsSchema.safeParse({
        conversationId: "cid",
        messageId: "m1",
        agents: ["a.toml"],
      }).success,
    ).toBe(true);
    const run = dingtalkDispatchRunResultSchema.parse({
      results: [{ fileName: "a.toml", name: "A", threadId: "thread-1", error: null }],
    });
    expect(run.results[0]?.threadId).toBe("thread-1");
  });
});
