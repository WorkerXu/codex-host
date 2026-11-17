/** DingTalk public A2UI catalog, component IDs and cumulative answer binding. */
const SURFACE = "codexhost-dispatch";
const CATALOG = "https://dingtalk.com/card/a2ui/catalogs/public/catalog.json";
const encode = (messages: unknown[]): string =>
  JSON.stringify(messages.map((message) => JSON.stringify(message)));
const panel = (finished: boolean) => ({
  id: "executionPanel",
  component: "CollapsiblePanel",
  title: finished ? "处理结束" : "[AIGenerating]思考中…",
  ...(!finished ? { textEffect: "shimmer" } : {}),
  children: ["answer"],
  fallbackMarkdown: "任务进度与结果",
});

export function dingtalkA2uiCreate(
  content: string,
  mentions: readonly string[] = [],
  atAll = false,
): string {
  const tags = [
    ...mentions.map((id) => `<a atId="${id.replace(/["<>&]/gu, "")}">成员</a>`),
    ...(atAll ? ['<a atId="all">所有人</a>'] : []),
  ];
  return encode([
    {
      version: "v1.0",
      createSurface: {
        surfaceId: SURFACE,
        catalogId: CATALOG,
        dataModel: { answer: { displayText: content } },
      },
    },
    {
      version: "v1.0",
      updateComponents: {
        surfaceId: SURFACE,
        components: [
          {
            id: "root",
            component: "Column",
            align: "stretch",
            children: [...(tags.length ? ["mentions"] : []), "executionPanel"],
          },
          ...(tags.length
            ? [{ id: "mentions", component: "Markdown", content: tags.join(" ") }]
            : []),
          panel(false),
          { id: "answer", component: "Markdown", content: { path: "/answer/displayText" } },
        ],
      },
    },
  ]);
}

export function dingtalkA2uiUpdate(content: string, finished: boolean): string {
  return encode([
    ...(finished
      ? [{ version: "v1.0", updateComponents: { surfaceId: SURFACE, components: [panel(true)] } }]
      : []),
    {
      version: "v1.0",
      updateDataModel: { surfaceId: SURFACE, path: "/answer/displayText", value: content },
    },
  ]);
}

export const DINGTALK_A2UI_ARTIFACT = JSON.stringify([
  { surfaceId: SURFACE, componentId: "answer", type: "artifact" },
]);
