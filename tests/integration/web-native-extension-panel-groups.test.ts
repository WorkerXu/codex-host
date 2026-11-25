import { Context } from "@deepseek-ai/cordis";
import { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/src/client/registry.ts";
import type { SidebarPanelGroupContribution } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { WebExtensionPanel } from "@codexhost/shared-contracts";
import { describe, expect, test } from "vitest";
import { ExtensionContributionRegistry } from "../../apps/web-ui/packages/client/ui-codexhost/src/client/native-extensions/contributions.ts";

const group = { id: "library", title: { en: "Library", "zh-CN": "资料库" } };
const panel = { id: "prompts", title: "Prompts", placement: "main", render: () => {} } as const;

function createRegistries() {
  const ctx = new Context();
  const slots = new SlotRegistry(ctx);
  slots.register(
    {
      name: "root",
      children: {
        main: { kind: "keyed", scope: "root" },
        "sidebar.panellist": { kind: "list", scope: "root" },
      },
    },
    () => null,
  );
  return {
    slots,
    extension: (id: string) =>
      new ExtensionContributionRegistry(ctx, id, new AbortController().signal),
  };
}

function panelGroups(slots: SlotRegistry) {
  return slots
    .entriesOfSlot("sidebar.panellist")
    .map(({ inject }) => inject?.().panelGroup as SidebarPanelGroupContribution | undefined);
}

describe("Web extension panel registration", () => {
  test("uses only the owning extension's group and rejects invalid members", () => {
    const { slots, extension } = createRegistries();
    const first = extension("first");
    const second = extension("second");
    const firstGroupDisposer = first.registerPanelGroup(group);
    const secondGroupDisposer = first.registerPanelGroup(group);
    expect(firstGroupDisposer).not.toBe(secondGroupDisposer);
    expect(firstGroupDisposer).toBeTypeOf("function");
    expect(() => second.registerPanel({ ...panel, groupId: group.id })).toThrow(
      /registered main panel group/,
    );
    expect(() => first.registerPanel({ ...panel, groupId: group.id, badgeCount: -1 })).toThrow();
    for (const invalid of [
      { ...panel, placement: "sidebar", groupId: group.id },
      { ...panel, badgeCount: 2 },
    ]) {
      expect(() => first.registerPanel(invalid as WebExtensionPanel)).toThrow();
    }
    expect(slots.entriesOfSlot("main")).toHaveLength(0);
    expect(panelGroups(slots)).toEqual([]);

    second.registerPanelGroup(group);
    first.registerPanel({ ...panel, groupId: group.id });
    second.registerPanel({ ...panel, groupId: group.id });
    expect(new Set(panelGroups(slots).map((entry) => entry?.id)).size).toBe(2);
    firstGroupDisposer();
    expect(new Set(panelGroups(slots).map((entry) => entry?.id)).size).toBe(2);
    first.disposeAll();
    expect(slots.entriesOfSlot("main")).toHaveLength(1);
    expect(panelGroups(slots)).toHaveLength(1);
  });

  test("updates the registered navigation badge without removing the panel, including zero and clearing", () => {
    const { slots, extension } = createRegistries();
    const registry = extension("sample");
    registry.registerPanelGroup(group);
    registry.registerPanel({ ...panel, groupId: group.id, badgeCount: 2 });
    const [navigation] = panelGroups(slots);
    expect(navigation?.label()).toBe("Library");
    expect(navigation?.badgeCount.getSnapshot()).toBe(2);
    const main = slots.entriesOfSlot("main")[0];

    registry.setPanelBadgeCount(panel.id, 0);
    expect(navigation?.badgeCount.getSnapshot()).toBe(0);
    expect(() => registry.setPanelBadgeCount(panel.id, 0.5)).toThrow();
    expect(navigation?.badgeCount.getSnapshot()).toBe(0);
    registry.setPanelBadgeCount(panel.id);
    expect(navigation?.badgeCount.getSnapshot()).toBeUndefined();
    expect(slots.entriesOfSlot("main")[0]).toBe(main);
  });

  test("removes members individually or with their group while leaving flat panels alone", () => {
    const { slots, extension } = createRegistries();
    const registry = extension("sample");
    const removeGroup = registry.registerPanelGroup(group);
    registry.registerPanel(panel);
    const removeFirst = registry.registerPanel({ ...panel, id: "first", groupId: group.id });
    const removeSecond = registry.registerPanel({ ...panel, id: "second", groupId: group.id });

    expect(panelGroups(slots).filter(Boolean)).toHaveLength(2);
    removeFirst();
    expect(panelGroups(slots).filter(Boolean)).toHaveLength(1);
    removeGroup();
    removeSecond();
    expect(() => registry.setPanelBadgeCount("second", 1)).toThrow(/not a registered group member/);
    expect(panelGroups(slots)).toEqual([undefined]);
    expect(slots.entriesOfSlot("main")).toHaveLength(1);

    registry.disposeAll();
    expect(panelGroups(slots)).toEqual([]);
    expect(slots.entriesOfSlot("main")).toHaveLength(0);
  });
});
