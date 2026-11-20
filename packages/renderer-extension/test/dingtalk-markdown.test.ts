import { describe, expect, it } from "vitest";

import { appendDingTalkMarkdown } from "../src/settings/dingtalk-markdown.js";

const MAX_NODES = 1_000;

class FakeNode {
  readonly children: FakeNode[] = [];
  className = "";
  textContent: string;
  href = "";
  target = "";
  rel = "";

  constructor(
    readonly tagName: string,
    text = "",
    private readonly counter: { nodes: number },
  ) {
    this.textContent = text;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node: FakeNode): FakeNode {
    this.counter.nodes += 1;
    if (this.counter.nodes > MAX_NODES) throw new Error("runaway markdown rendering");
    this.children.push(node);
    return node;
  }
}

function render(markdown: string): { root: FakeNode; nodes: number } {
  const counter = { nodes: 0 };
  const document = {
    createElement: (tag: string) => new FakeNode(tag, "", counter),
    createTextNode: (text: string) => new FakeNode("#text", text, counter),
  } as unknown as Document;
  const root = new FakeNode("div", "", counter);
  appendDingTalkMarkdown(document, root as unknown as HTMLElement, markdown);
  return { root, nodes: counter.nodes };
}

function blocks(root: FakeNode): string[] {
  return root.children.map((child) => `${child.tagName}.${child.className}`);
}

describe("appendDingTalkMarkdown", () => {
  it.each([
    ["dash separator with text", "----- 报警详情 -----\n金额异常"],
    ["underscore separator with text", "___分割___\n内容"],
    ["heading containing a line separator", "# 标题 续行\n正文"],
    ["dashes without a following space", "---告警\n---恢复"],
  ])("terminates and keeps the text for %s", (_name, markdown) => {
    const { root, nodes } = render(markdown);
    expect(nodes).toBeLessThan(MAX_NODES);
    expect(root.children.length).toBeGreaterThan(0);
  });

  it("treats a dash-prefixed line as paragraph text, not a rule", () => {
    const { root } = render("----- 报警 -----\n第二行");
    expect(blocks(root)).toEqual(["div.dingtalk-md-paragraph"]);
  });

  it("still renders real block syntax", () => {
    const { root } = render("# 标题\n---\n> 引用\n- 项\n1. 第一\n正文");
    expect(blocks(root)).toEqual([
      "div.dingtalk-md-heading dingtalk-md-heading--1",
      "hr.dingtalk-md-rule",
      "blockquote.dingtalk-md-quote",
      "ul.dingtalk-md-list",
      "ol.dingtalk-md-list",
      "div.dingtalk-md-paragraph",
    ]);
  });
});
