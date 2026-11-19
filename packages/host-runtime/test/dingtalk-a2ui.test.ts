import { describe, expect, it } from "vitest";
import {
  dingtalkA2uiCreate,
  dingtalkA2uiUpdate,
  dingtalkMentionLine,
  type DingTalkCardState,
} from "../src/dingtalk-a2ui.js";

const LOADING_LIGHT =
  "https://g.alicdn.com/dingding/card_a2ui/0.1.1/img/loading-circular/loading_circular_light.DlX94S3.gif";
const LOADING_DARK =
  "https://g.alicdn.com/dingding/card_a2ui/0.1.1/img/loading-circular/loading_circular_dark.D-pS11K.gif";

interface Component {
  id: string;
  component: string;
  [key: string]: unknown;
}

interface WireMessage {
  createSurface?: {
    surfaceId: string;
    catalogId: string;
    dataModel: { answer: { displayText: string } };
  };
  updateComponents?: { components: Component[] };
  updateDataModel?: { surfaceId: string; path: string; value: string };
}

function parse(payload: string): WireMessage[] {
  return (JSON.parse(payload) as string[]).map((message) => JSON.parse(message) as WireMessage);
}

function components(messages: WireMessage[]): Component[] {
  return messages.flatMap((message) => message.updateComponents?.components ?? []);
}

function component(list: Component[], id: string): Component | undefined {
  return list.find((entry) => entry.id === id);
}

const contextStep = {
  id: "context",
  kind: "context" as const,
  title: "读取会话上下文",
  detail: "已读取 12 条更早消息",
  status: "done" as const,
};

const commandStep = {
  id: "item:cmd-1",
  kind: "command" as const,
  title: "执行命令",
  detail: "dws chat message list --limit 5",
  status: "running" as const,
};

const failedCommandStep = {
  id: "item:cmd-2",
  kind: "command" as const,
  title: "执行命令",
  detail: "dws chat +chat-members-list",
  status: "failed" as const,
};

const steps = [contextStep, commandStep, failedCommandStep];

function state(overrides: Partial<DingTalkCardState> = {}): DingTalkCardState {
  return {
    phase: "running",
    steps,
    status: "正在执行命令…",
    answer: "",
    mentions: '<a atId="open-user">徐涛</a>',
    ...overrides,
  };
}

describe("DingTalk Agent-run A2UI card", () => {
  it("creates a reasoning panel with the real timeline and no answer component", () => {
    const messages = parse(dingtalkA2uiCreate(state()));
    expect(messages[0]?.createSurface).toMatchObject({
      surfaceId: "codexhost-dispatch",
      catalogId: "https://dingtalk.com/card/a2ui/catalogs/public/catalog.json",
      dataModel: { answer: { displayText: "" } },
    });
    const list = components(messages);
    expect(component(list, "root")?.children).toEqual(["mentions", "executionPanel"]);
    expect(component(list, "mentions")?.content).toContain('<a atId="open-user">徐涛</a>');
    expect(component(list, "executionPanel")).toMatchObject({
      title: "[AIGenerating]正在执行命令…",
      textEffect: "shimmer",
      variant: "reasoning",
      defaultExpanded: true,
      children: ["executionTimeline"],
      colorToken: "common_level2_base_color",
    });
    expect(component(list, "executionTimeline")).toMatchObject({
      component: "Column",
      gap: 6,
      children: ["step_1", "step_2", "step_3"],
    });
    // Completed step: a check, no loading image.
    expect(component(list, "step_1")).toMatchObject({
      variant: "indented",
      icon: "Check_L_outlined",
      children: ["step_1_detail"],
    });
    // Running step: the official light and dark loading images.
    expect(component(list, "step_2")).toMatchObject({
      icon: LOADING_LIGHT,
      darkIcon: LOADING_DARK,
    });
    // Failed step: no success check.
    expect(component(list, "step_3")).toMatchObject({ icon: "Error_L_outlined" });
    expect(component(list, "step_3")?.children).toEqual(["step_3_detail"]);
    expect(component(list, "step_3_detail")).toMatchObject({
      component: "Text",
      text: "dws chat +chat-members-list",
      icon: { name: "CodeProgram_L_outlined" },
      colorToken: "common_level2_base_color",
      sizeToken: "common_action_text_style__font_size",
    });
    expect(list.some((entry) => entry.id === "answer")).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("/answer/displayText");
  });

  it("updates the running title and timeline without resetting the user toggle", () => {
    const messages = parse(dingtalkA2uiUpdate(state()));
    expect(messages).toHaveLength(1);
    const list = components(messages);
    expect(component(list, "executionPanel")).toMatchObject({
      title: "[AIGenerating]正在执行命令…",
      textEffect: "shimmer",
      children: ["executionTimeline"],
    });
    expect(component(list, "executionPanel")?.defaultExpanded).toBeUndefined();
    expect(component(list, "root")?.children).toEqual(["mentions", "executionPanel"]);
    expect(list.some((entry) => entry.id === "answer")).toBe(false);
    expect(messages[0]?.updateDataModel).toBeUndefined();
  });

  it("finishes with completion text, every check, and the answer outside the panel", () => {
    const messages = parse(
      dingtalkA2uiUpdate(
        state({
          phase: "completed",
          status: "正在撰写回答…",
          answer: "最终答案",
          steps: steps.map((step) => ({ ...step, status: "done" as const })),
        }),
      ),
    );
    const list = components(messages);
    expect(component(list, "executionPanel")).toMatchObject({
      title: "已完成 · 3 步",
      children: ["executionTimeline"],
    });
    expect(component(list, "executionPanel")?.textEffect).toBeUndefined();
    const root = component(list, "root")?.children as string[];
    expect(root).toEqual(["mentions", "executionPanel", "answer"]);
    expect(root.indexOf("answer")).toBeGreaterThan(root.indexOf("executionPanel"));
    expect(component(list, "answer")).toMatchObject({
      component: "Markdown",
      content: { path: "/answer/displayText" },
    });
    for (const id of ["step_1", "step_2", "step_3"])
      expect(component(list, id)?.icon).toBe("Check_L_outlined");
    expect(messages[1]?.updateDataModel).toEqual({
      surfaceId: "codexhost-dispatch",
      path: "/answer/displayText",
      value: "最终答案",
    });
  });

  it("names a failed run with a visible Chinese reason and no success check", () => {
    const messages = parse(
      dingtalkA2uiUpdate(
        state({
          phase: "failed",
          answer: "处理失败：智能体处理失败，请在 Desktop 查看对话",
          steps: [
            contextStep,
            { ...commandStep, status: "stopped" as const },
            { ...failedCommandStep, status: "failed" as const },
          ],
        }),
      ),
    );
    const list = components(messages);
    const panel = component(list, "executionPanel");
    expect(panel?.title).toBe("处理失败");
    expect(panel?.textEffect).toBeUndefined();
    expect(component(list, "step_1")?.icon).toBe("Check_L_outlined");
    expect(component(list, "step_2")?.icon).toBeUndefined();
    expect(component(list, "step_3")?.icon).toBe("Error_L_outlined");
    expect(component(list, "root")?.children).toEqual(["mentions", "executionPanel", "answer"]);
    expect(messages[1]?.updateDataModel?.value).toBe(
      "处理失败：智能体处理失败，请在 Desktop 查看对话",
    );
    expect(JSON.stringify(messages)).not.toContain("shimmer");
  });

  it("names a cancelled run and stops running steps without checks", () => {
    const messages = parse(
      dingtalkA2uiUpdate(
        state({
          phase: "cancelled",
          answer: "处理已中断，可重新派发",
          steps: [contextStep, { ...commandStep, status: "stopped" as const }, failedCommandStep],
        }),
      ),
    );
    const list = components(messages);
    expect(component(list, "executionPanel")?.title).toBe("已取消");
    expect(component(list, "executionPanel")?.textEffect).toBeUndefined();
    expect(component(list, "step_2")?.icon).toBeUndefined();
    expect(component(list, "root")?.children).toEqual(["mentions", "executionPanel", "answer"]);
    expect(messages[1]?.updateDataModel?.value).toBe("处理已中断，可重新派发");
    expect(JSON.stringify(messages)).not.toContain("shimmer");
  });

  it("keeps component ids stable between create and update", () => {
    const created = components(parse(dingtalkA2uiCreate(state())));
    const updated = components(parse(dingtalkA2uiUpdate(state({ status: "正在撰写回答…" }))));
    const ids = ["root", "executionPanel", "executionTimeline", "step_1", "step_1_detail"];
    for (const id of ids) {
      expect(component(created, id)).toBeDefined();
      expect(component(updated, id)).toBeDefined();
    }
  });
});

describe("DingTalk mention line", () => {
  it("labels each declared member and @all in the official Markdown form", () => {
    expect(dingtalkMentionLine(["open-user"], true, { "open-user": "徐涛" })).toBe(
      '<a atId="open-user">徐涛</a> <a atId="all">所有人</a>',
    );
  });

  it("omits the line when nothing is declared and strips HTML from names", () => {
    expect(dingtalkMentionLine([], false)).toBeNull();
    expect(dingtalkMentionLine(["u"], false, { u: "<b>徐涛</b>" })).toBe('<a atId="u">b徐涛/b</a>');
  });
});
