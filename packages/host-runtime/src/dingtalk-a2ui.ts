/**
 * DingTalk public A2UI card for one dispatched Turn.
 *
 * It follows the official Agent-run pattern: a `reasoning` CollapsiblePanel
 * whose title names the current operation and whose `executionTimeline` lists
 * the Turn's real public steps. The final answer is a top-level Markdown
 * component after the panel, so it is readable without expanding anything.
 */
import type {
  DingTalkProgressStepKind,
  DingTalkProgressStepStatus,
} from "./dingtalk-dispatch-types.js";

const SURFACE = "codexhost-dispatch";
const CATALOG = "https://dingtalk.com/card/a2ui/catalogs/public/catalog.json";
/** Official loading images from the DingTalk A2UI example. */
const LOADING_LIGHT =
  "https://g.alicdn.com/dingding/card_a2ui/0.1.1/img/loading-circular/loading_circular_light.DlX94S3.gif";
const LOADING_DARK =
  "https://g.alicdn.com/dingding/card_a2ui/0.1.1/img/loading-circular/loading_circular_dark.D-pS11K.gif";
const encode = (messages: unknown[]): string =>
  JSON.stringify(messages.map((message) => JSON.stringify(message)));

export type DingTalkCardPhase = "running" | "completed" | "failed" | "cancelled";
/** `stopped` ends a step without claiming either success or a specific failure. */
export type DingTalkCardStepStatus = DingTalkProgressStepStatus | "stopped";

export interface DingTalkCardStep {
  id: string;
  kind: DingTalkProgressStepKind;
  title: string;
  detail: string;
  status: DingTalkCardStepStatus;
}

/** Everything the card needs to render one state; no DingTalk call data. */
export interface DingTalkCardState {
  phase: DingTalkCardPhase;
  steps: readonly DingTalkCardStep[];
  /** Current operation while running, for example 正在读取上下文… */
  status: string;
  /** Final answer, or the visible Chinese reason for a failed or cancelled run. */
  answer: string;
  /** Markdown mention line fixed at creation; only a group card has one. */
  mentions: string | null;
}

const STEP_ICON: Record<DingTalkProgressStepKind, string> = {
  context: "ListView_L_outlined",
  command: "CodeProgram_L_outlined",
  tool: "Tool_L_outlined",
  file: "Edit_L_outlined",
  search: "Search_L_outlined",
  answer: "Edit_L_outlined",
};

const STEP_ACTION: Record<DingTalkProgressStepKind, string> = {
  context: "读取上下文",
  command: "执行命令",
  tool: "调用工具",
  file: "修改文件",
  search: "搜索资料",
  answer: "撰写回答",
};

/** Panel title for a newly started step, without the generating marker. */
export function dingtalkStepStatus(kind: DingTalkProgressStepKind): string {
  return `正在${STEP_ACTION[kind]}…`;
}

/** Stable component ids: steps are append-only, so an index never moves. */
const stepId = (index: number): string => `step_${index + 1}`;
const stepDetailId = (index: number): string => `step_${index + 1}_detail`;

function panelTitle(state: DingTalkCardState): string {
  if (state.phase === "running") return `[AIGenerating]${state.status}`;
  if (state.phase === "completed")
    return state.steps.length > 0 ? `已完成 · ${state.steps.length} 步` : "已完成";
  return state.phase === "failed" ? "处理失败" : "已取消";
}

function stepIcon(
  step: DingTalkCardStep,
): { icon: string; darkIcon?: string } | Record<string, never> {
  if (step.status === "running") return { icon: LOADING_LIGHT, darkIcon: LOADING_DARK };
  if (step.status === "done") return { icon: "Check_L_outlined" };
  if (step.status === "failed") return { icon: "Error_L_outlined" };
  return {};
}

function stepComponents(step: DingTalkCardStep, index: number): unknown[] {
  const id = stepId(index);
  return [
    {
      id,
      component: "CollapsiblePanel",
      title: step.title,
      children: [stepDetailId(index)],
      colorToken: "common_level2_base_color",
      variant: "indented",
      fallbackMarkdown: step.title,
      maxHeight: 160,
      ...stepIcon(step),
    },
    {
      id: stepDetailId(index),
      component: "Text",
      text: step.detail,
      icon: { name: STEP_ICON[step.kind] },
      colorToken: "common_level2_base_color",
      sizeToken: "common_action_text_style__font_size",
    },
  ];
}

function panel(state: DingTalkCardState, initial: boolean): unknown {
  return {
    id: "executionPanel",
    component: "CollapsiblePanel",
    title: panelTitle(state),
    ...(state.phase === "running" ? { textEffect: "shimmer" } : {}),
    children: ["executionTimeline"],
    colorToken: "common_level2_base_color",
    variant: "reasoning",
    fallbackMarkdown: "任务进度",
    // Only the first frame expands; later updates keep the user's own toggle.
    ...(initial ? { defaultExpanded: true } : {}),
  };
}

function timeline(state: DingTalkCardState): unknown {
  return {
    id: "executionTimeline",
    component: "Column",
    gap: 6,
    children: state.steps.map((_, index) => stepId(index)),
  };
}

function root(state: DingTalkCardState): unknown {
  return {
    id: "root",
    component: "Column",
    align: "stretch",
    gap: 6,
    children: [
      ...(state.mentions ? ["mentions"] : []),
      "executionPanel",
      // The answer sits outside the panel and is visible without a click.
      ...(state.phase === "running" ? [] : ["answer"]),
    ],
  };
}

function mentionsComponent(state: DingTalkCardState): unknown[] {
  return state.mentions ? [{ id: "mentions", component: "Markdown", content: state.mentions }] : [];
}

function answerComponent(): unknown {
  return {
    id: "answer",
    component: "Markdown",
    content: { path: "/answer/displayText" },
  };
}

/** One fixed Markdown line for the sender and @all, following the official style. */
export function dingtalkMentionLine(
  mentions: readonly string[],
  atAll: boolean,
  names: Readonly<Record<string, string>> = {},
): string | null {
  const label = (id: string) => names[id]?.replace(/[<>&"]/gu, "").trim() || "成员";
  const tags = [
    ...mentions.map((id) => `<a atId="${id.replace(/["<>&]/gu, "")}">${label(id)}</a>`),
    ...(atAll ? ['<a atId="all">所有人</a>'] : []),
  ];
  return tags.length ? tags.join(" ") : null;
}

export function dingtalkA2uiCreate(state: DingTalkCardState): string {
  return encode([
    {
      version: "v1.0",
      createSurface: {
        surfaceId: SURFACE,
        catalogId: CATALOG,
        dataModel: { answer: { displayText: "" } },
      },
    },
    {
      version: "v1.0",
      updateComponents: {
        surfaceId: SURFACE,
        components: [
          root(state),
          ...mentionsComponent(state),
          panel(state, true),
          timeline(state),
          ...state.steps.flatMap(stepComponents),
        ],
      },
    },
  ]);
}

/** One update batch: layout changes, plus the bound answer once the Turn ends. */
export function dingtalkA2uiUpdate(state: DingTalkCardState): string {
  const terminal = state.phase !== "running";
  return encode([
    {
      version: "v1.0",
      updateComponents: {
        surfaceId: SURFACE,
        components: [
          panel(state, false),
          timeline(state),
          ...state.steps.flatMap(stepComponents),
          root(state),
          ...(terminal ? [answerComponent()] : []),
        ],
      },
    },
    ...(terminal
      ? [
          {
            version: "v1.0",
            updateDataModel: {
              surfaceId: SURFACE,
              path: "/answer/displayText",
              value: state.answer,
            },
          },
        ]
      : []),
  ]);
}

export const DINGTALK_A2UI_ARTIFACT = JSON.stringify([
  { surfaceId: SURFACE, componentId: "answer", type: "artifact" },
]);
