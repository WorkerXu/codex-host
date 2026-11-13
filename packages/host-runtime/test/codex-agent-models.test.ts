import { describe, expect, it } from "vitest";

import { codexAgentCatalogFromModelList } from "../src/codex-agent-models.js";

describe("codexAgentCatalogFromModelList", () => {
  it("projects the official model list with each model's supported efforts", () => {
    const catalog = codexAgentCatalogFromModelList({
      result: {
        data: [
          {
            model: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "xhigh", description: "Deep" },
            ],
          },
          {
            model: "gpt-5.6-sol",
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          },
        ],
      },
    });
    expect(catalog.available).toBe(true);
    expect(catalog.defaultModel).toBe("gpt-5.6-terra");
    expect(catalog.models).toEqual([
      {
        model: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        isDefault: true,
        efforts: [
          { id: "low", description: "Fast" },
          { id: "xhigh", description: "Deep" },
        ],
      },
      {
        model: "gpt-5.6-sol",
        displayName: "gpt-5.6-sol",
        isDefault: false,
        efforts: [{ id: "medium", description: "medium" }],
      },
    ]);
  });

  it("drops duplicate and malformed candidates without failing the catalog", () => {
    const catalog = codexAgentCatalogFromModelList({
      result: {
        data: [
          { model: "gpt-5.6-terra", isDefault: true },
          { model: "gpt-5.6-terra", isDefault: true },
          { model: 42 },
          { model: "  " },
          null,
        ],
      },
    });
    expect(catalog.models.map((model) => model.model)).toEqual(["gpt-5.6-terra"]);
    expect(catalog.defaultModel).toBe("gpt-5.6-terra");
  });

  it("returns an empty catalog for an error envelope", () => {
    expect(codexAgentCatalogFromModelList({ error: { message: "boom" } })).toEqual({
      available: false,
      models: [],
      defaultModel: null,
    });
    expect(codexAgentCatalogFromModelList({})).toEqual({
      available: false,
      models: [],
      defaultModel: null,
    });
  });
});
