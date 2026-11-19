import { describe, expect, it } from "vitest";

import type {
  CodexAgentCatalogResult,
  CodexAgentRecord,
  DingTalkDispatchSettings,
} from "@codexhost/shared-contracts";
import { defaultDingTalkDispatchSettings } from "@codexhost/shared-contracts";

import {
  agentDingTalkDraft,
  agentDraftFromRecord,
  agentSaveParamsFromDraft,
  duplicateAgentDraft,
  effortOptionsForModel,
  emptyAgentDraft,
  validateAgentDraft,
  withAgentDingTalk,
} from "../../src/settings/codex-agents-form.js";
import { codexAgentsMessagesChinese } from "../../src/settings/codex-agents-messages.js";

const record: CodexAgentRecord = {
  fileName: "terra-worker.toml",
  name: "terra_worker",
  description: "Bounded worker.",
  model: "gpt-5.6-terra",
  reasoningEffort: "xhigh",
  developerInstructions: "Do the work.",
  revision: "1700000000000-42",
};

const validDraft = {
  ...emptyAgentDraft(),
  name: "reviewer",
  description: "Reviews changes.",
  developerInstructions: "Review carefully.",
};

describe("Codex agent form logic", () => {
  it("accepts a valid draft and trims optional values on save", () => {
    const draft = {
      ...validDraft,
      name: "  new_worker  ",
      model: " gpt-5.6-terra ",
      reasoningEffort: "",
    };
    expect(validateAgentDraft(draft)).toBeNull();
    expect(agentSaveParamsFromDraft(draft)).toEqual({
      fileName: null,
      expectedRevision: null,
      name: "new_worker",
      description: "Reviews changes.",
      model: "gpt-5.6-terra",
      reasoningEffort: null,
      developerInstructions: "Review carefully.",
    });
  });

  it("reports the first invalid field with a stable code", () => {
    expect(validateAgentDraft(emptyAgentDraft())).toEqual({
      field: "name",
      error: "invalid_name",
    });
    expect(validateAgentDraft({ ...validDraft, name: "two\nlines" })).toEqual({
      field: "name",
      error: "invalid_name",
    });
    expect(validateAgentDraft({ ...validDraft, name: "   " })).toEqual({
      field: "name",
      error: "invalid_name",
    });
    expect(validateAgentDraft({ ...validDraft, name: "\nleading" })).toEqual({
      field: "name",
      error: "invalid_name",
    });
    expect(validateAgentDraft({ ...validDraft, description: "  " })).toEqual({
      field: "description",
      error: "description_required",
    });
    expect(validateAgentDraft({ ...validDraft, developerInstructions: "\n" })).toEqual({
      field: "developerInstructions",
      error: "instructions_required",
    });
    expect(validateAgentDraft({ ...validDraft, description: "x".repeat(4_097) })).toEqual({
      field: "description",
      error: "too_long",
    });
    expect(validateAgentDraft({ ...validDraft, model: "a\nb" })).toEqual({
      field: "model",
      error: "model_invalid",
    });
    expect(validateAgentDraft({ ...validDraft, reasoningEffort: "a\nb" })).toEqual({
      field: "reasoningEffort",
      error: "effort_invalid",
    });
  });

  it("accepts Chinese, spaces, punctuation and long duplicate names", () => {
    const longName = `发布与线上问题处理助手 ${"（夜间值守）".repeat(80)}`;
    expect(validateAgentDraft({ ...validDraft, name: "  发布 与 值守 助手  " })).toBeNull();
    expect(validateAgentDraft({ ...validDraft, name: "名字（华东区，夜间）" })).toBeNull();
    expect(validateAgentDraft({ ...validDraft, name: longName })).toBeNull();
    expect(
      validateAgentDraft({
        ...agentDraftFromRecord(record),
        name: "terra_worker",
        description: "Updated.",
      }),
    ).toBeNull();
  });

  it("offers only the efforts the selected model supports", () => {
    const catalog: CodexAgentCatalogResult = {
      available: true,
      defaultModel: "gpt-5.6-terra",
      models: [
        {
          model: "gpt-5.6-terra",
          displayName: "Terra",
          isDefault: true,
          efforts: [
            { id: "low", description: "Fast" },
            { id: "xhigh", description: "Deep" },
          ],
        },
      ],
    };
    expect(effortOptionsForModel(catalog, "gpt-5.6-terra").map((effort) => effort.id)).toEqual([
      "low",
      "xhigh",
    ]);
    expect(effortOptionsForModel(catalog, "gpt-5.6-sol")).toEqual([]);
    expect(effortOptionsForModel({ ...catalog, available: false }, "gpt-5.6-terra")).toEqual([]);
    expect(effortOptionsForModel(null, "gpt-5.6-terra")).toEqual([]);
  });

  it("duplicates into a new file without renaming the agent", () => {
    const duplicate = duplicateAgentDraft(record);
    expect(duplicate.fileName).toBeNull();
    expect(duplicate.expectedRevision).toBeNull();
    expect(duplicate.name).toBe("terra_worker");
    expect(duplicate.developerInstructions).toBe("Do the work.");
  });

  it("states that an agent needs its section and project", () => {
    expect(codexAgentsMessagesChinese.dingtalk.agentNeedsTarget).toBe("需要设置分区和工作项目");
    expect(codexAgentsMessagesChinese.dingtalk.agentProjectLabel).toBe("工作项目");
  });

  it("edits one agent's DingTalk choice without touching the others", () => {
    const saved: DingTalkDispatchSettings = {
      agents: {
        "reviewer.toml": {
          enabled: true,
          replyScope: "group",
          sectionId: "section-1",
          projectId: "project-1",
          projectPath: "/Users/me/project",
        },
      },
    };
    const draft = agentDingTalkDraft(saved, "reviewer.toml");
    expect(draft).toEqual({
      enabled: true,
      replyScope: "group",
      sectionId: "section-1",
      projectId: "project-1",
      projectPath: "/Users/me/project",
    });

    const next = withAgentDingTalk(saved, "writer.toml", {
      enabled: true,
      replyScope: "direct",
      sectionId: "section-2",
      projectId: "project-2",
      projectPath: "/Users/me/other",
    });
    expect(next.agents["reviewer.toml"]).toEqual(saved.agents["reviewer.toml"]);
    expect(next.agents["writer.toml"]).toEqual({
      enabled: true,
      replyScope: "direct",
      sectionId: "section-2",
      projectId: "project-2",
      projectPath: "/Users/me/other",
    });
  });

  it("gives a new agent the default choice and keeps it out of the map while off", () => {
    expect(agentDingTalkDraft(defaultDingTalkDispatchSettings(), null)).toEqual({
      enabled: false,
      replyScope: "group",
      sectionId: null,
      projectId: null,
      projectPath: null,
    });
    const saved = defaultDingTalkDispatchSettings();
    expect(
      withAgentDingTalk(saved, "new.toml", {
        enabled: false,
        replyScope: "group",
        sectionId: null,
        projectId: null,
        projectPath: null,
      }),
    ).toBe(saved);
  });

  it("keeps an entry when an existing agent turns listening off", () => {
    const saved: DingTalkDispatchSettings = {
      agents: {
        "reviewer.toml": {
          enabled: true,
          replyScope: "direct",
          sectionId: "section-1",
          projectId: "project-1",
          projectPath: "/Users/me/project",
        },
      },
    };
    const next = withAgentDingTalk(saved, "reviewer.toml", {
      enabled: false,
      replyScope: "direct",
      sectionId: "section-1",
      projectId: "project-1",
      projectPath: "/Users/me/project",
    });
    expect(next.agents["reviewer.toml"]).toEqual({
      enabled: false,
      replyScope: "direct",
      sectionId: "section-1",
      projectId: "project-1",
      projectPath: "/Users/me/project",
    });
  });
});
