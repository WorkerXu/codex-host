import { describe, expect, it } from "vitest";

import type { CodexAgentCatalogResult, CodexAgentRecord } from "@codexhost/shared-contracts";

import {
  agentDraftFromRecord,
  agentSaveParamsFromDraft,
  duplicateAgentDraft,
  effortOptionsForModel,
  emptyAgentDraft,
  nextDuplicateName,
  parseDingTalkMatchThreshold,
  validateAgentDraft,
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

const existing = [
  { name: "terra_worker", fileName: "terra-worker.toml" },
  { name: "reviewer", fileName: "reviewer.toml" },
];

describe("Codex agent form logic", () => {
  it("accepts a valid draft and trims optional values on save", () => {
    const draft = {
      ...validDraft,
      name: "  new_worker  ",
      model: " gpt-5.6-terra ",
      reasoningEffort: "",
    };
    expect(validateAgentDraft(draft, [])).toBeNull();
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
    expect(validateAgentDraft(emptyAgentDraft(), [])).toEqual({
      field: "name",
      error: "invalid_name",
    });
    expect(validateAgentDraft({ ...validDraft, name: "bad name" }, [])).toEqual({
      field: "name",
      error: "invalid_name",
    });
    expect(validateAgentDraft(validDraft, existing)).toEqual({
      field: "name",
      error: "name_taken",
    });
    expect(validateAgentDraft({ ...validDraft, description: "  " }, [])).toEqual({
      field: "description",
      error: "description_required",
    });
    expect(validateAgentDraft({ ...validDraft, developerInstructions: "\n" }, [])).toEqual({
      field: "developerInstructions",
      error: "instructions_required",
    });
    expect(validateAgentDraft({ ...validDraft, description: "x".repeat(4_097) }, [])).toEqual({
      field: "description",
      error: "too_long",
    });
    expect(validateAgentDraft({ ...validDraft, model: "a\nb" }, [])).toEqual({
      field: "model",
      error: "model_invalid",
    });
    expect(validateAgentDraft({ ...validDraft, reasoningEffort: "a\nb" }, [])).toEqual({
      field: "reasoningEffort",
      error: "effort_invalid",
    });
  });

  it("allows an agent to keep its own name and reports a new-file name collision", () => {
    expect(
      validateAgentDraft({ ...agentDraftFromRecord(record), description: "Updated." }, existing),
    ).toBeNull();
    expect(validateAgentDraft({ ...validDraft, name: "terra_worker" }, existing)).toEqual({
      field: "name",
      error: "name_taken",
    });
    expect(
      validateAgentDraft({ ...validDraft, name: "other" }, [
        { name: "different", fileName: "other.toml" },
      ]),
    ).toEqual({ field: "name", error: "name_taken" });
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

  it("duplicates into a new file with a free name", () => {
    expect(nextDuplicateName("terra_worker", [])).toBe("terra_worker-copy");
    expect(
      nextDuplicateName("terra_worker", [
        { name: "terra_worker-copy", fileName: "terra_worker-copy.toml" },
      ]),
    ).toBe("terra_worker-copy-2");
    const duplicate = duplicateAgentDraft(record, existing);
    expect(duplicate.fileName).toBeNull();
    expect(duplicate.expectedRevision).toBeNull();
    expect(duplicate.name).toBe("terra_worker-copy");
    expect(duplicate.developerInstructions).toBe("Do the work.");
  });

  it("parses the DingTalk threshold, rejecting empty and out-of-range input", () => {
    expect(parseDingTalkMatchThreshold("0.85")).toBe(0.85);
    expect(parseDingTalkMatchThreshold("0")).toBe(0);
    expect(parseDingTalkMatchThreshold(" 1 ")).toBe(1);
    expect(parseDingTalkMatchThreshold("")).toBeNull();
    expect(parseDingTalkMatchThreshold("   ")).toBeNull();
    expect(parseDingTalkMatchThreshold("-0.01")).toBeNull();
    expect(parseDingTalkMatchThreshold("1.01")).toBeNull();
    expect(parseDingTalkMatchThreshold("abc")).toBeNull();
  });

  it("states the approval rule without granting approval changes", () => {
    expect(codexAgentsMessagesChinese.dingtalk.approvalNote).toBe(
      "审批由你决定：智能体可以整理材料并给出建议，但不会代为同意、拒绝或撤销。",
    );
    expect(codexAgentsMessagesChinese.dingtalk.approvalNote).not.toMatch(/自动通过/);
  });
});
