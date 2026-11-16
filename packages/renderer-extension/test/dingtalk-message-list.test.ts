import { describe, expect, it } from "vitest";

import type { DingTalkMessage, DingTalkResourceResult } from "@codexhost/shared-contracts";

import {
  createDingTalkMessageList,
  DingTalkObjectUrls,
} from "../src/settings/dingtalk-message-list.js";
import { dingtalkPageStrings } from "../src/settings/dingtalk-page-strings.js";
import { createMessageRow } from "../src/settings/dingtalk-page-view.js";

class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(public textContent: string) {}
}

class FakeFragment {
  readonly children: (FakeElement | FakeText)[] = [];
  append(...nodes: (FakeElement | FakeText)[]): void {
    for (const node of nodes) this.children.push(node);
  }
}

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly children: (FakeElement | FakeText)[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  parentNode: FakeElement | null = null;
  dataset: Record<string, string> = {};
  className = "";
  title = "";
  hidden = false;
  disabled = false;
  checked = false;
  type = "";
  src = "";
  alt = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 320;
  naturalHeight = 200;
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  #text = "";
  readonly style = {
    width: "",
    height: "",
    overflowY: "",
    setProperty: () => undefined,
    removeProperty: () => undefined,
  };
  readonly classList = {
    add: (...names: string[]) => {
      const set = new Set(this.className.split(/\s+/u).filter(Boolean));
      for (const name of names) set.add(name);
      this.className = [...set].join(" ");
    },
    remove: (...names: string[]) => {
      const remove = new Set(names);
      this.className = this.className
        .split(/\s+/u)
        .filter((name) => name && !remove.has(name))
        .join(" ");
    },
    toggle: (name: string, force?: boolean) => {
      const has = this.className.split(/\s+/u).includes(name);
      const next = force ?? !has;
      if (next && !has) this.classList.add(name);
      if (!next && has) this.classList.remove(name);
      return next;
    },
    contains: (name: string) => this.className.split(/\s+/u).includes(name),
  };

  constructor(
    tagName: string,
    private readonly document: FakeDocument,
  ) {
    this.tagName = tagName.toLowerCase();
  }

  get textContent(): string {
    if (this.children.length === 0) return this.#text;
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.#text = value;
    this.children.length = 0;
  }

  get isConnected(): boolean {
    let node: FakeElement | null = this.parentNode;
    while (node?.parentNode) node = node.parentNode;
    return node === this.document.body;
  }

  get nextSibling(): FakeElement | FakeText | null {
    const parent = this.parentNode;
    if (!parent) return null;
    const index = parent.children.indexOf(this);
    return parent.children[index + 1] ?? null;
  }

  append(...nodes: (FakeElement | FakeText | string)[]): void {
    for (const node of nodes) {
      if (typeof node === "string") this.appendChild(new FakeText(node));
      else this.appendChild(node);
    }
  }

  appendChild(node: FakeElement | FakeText | FakeFragment): void {
    if (node instanceof FakeFragment) {
      for (const child of [...node.children]) this.appendChild(child);
      return;
    }
    if (node instanceof FakeElement) node.parentNode = this;
    this.children.push(node);
  }

  replaceChildren(...nodes: (FakeElement | FakeText)[]): void {
    this.children.length = 0;
    for (const node of nodes) this.appendChild(node);
  }

  insertBefore(node: FakeElement | FakeFragment, reference: FakeElement | FakeText | null): void {
    if (node instanceof FakeFragment) {
      for (const child of [...node.children]) this.insertBefore(child, reference);
      return;
    }
    node.parentNode = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }

  remove(): void {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  addEventListener(name: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }
}

class FakeDocument {
  readonly body = new FakeElement("body", this);
  failTag: string | null = null;

  createElement(tag: string): FakeElement {
    if (tag === this.failTag) throw new Error(`cannot create ${tag}`);
    return new FakeElement(tag, this);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  createDocumentFragment(): FakeFragment {
    return new FakeFragment();
  }
}

function message(
  id: string,
  createdAt: number,
  overrides: Partial<DingTalkMessage> = {},
): DingTalkMessage {
  return {
    messageId: id,
    conversationId: "cid",
    senderName: "林晓",
    senderId: "user-a",
    createdAt,
    text: `消息 ${id}`,
    unsupported: false,
    mine: false,
    ...overrides,
  };
}

function resourceResult(dataUrl = "data:image/png;base64,AAAA"): DingTalkResourceResult {
  return {
    available: true,
    dataUrl,
    mimeType: "image/png",
    sizeBytes: 4,
    errorCode: null,
  };
}

function createList(document: FakeDocument, created: string[], revoked: string[]) {
  const container = document.createElement("div");
  document.body.append(container);
  return {
    container,
    list: createDingTalkMessageList({
      document: document as unknown as Document,
      container: container as unknown as HTMLElement,
      text: dingtalkPageStrings("zh-CN"),
      loadResource: async () => resourceResult(),
      decodeImage: async () => new Blob(["x"]),
      createObjectUrl: () => {
        const url = `blob:fake-${created.length + 1}`;
        created.push(url);
        return url;
      },
      revokeObjectUrl: (url) => revoked.push(url),
    }),
  };
}

function renderedIds(container: FakeElement): string[] {
  return container.children
    .filter((child): child is FakeElement => child instanceof FakeElement)
    .flatMap((child) => (child.dataset.messageId ? [child.dataset.messageId] : []));
}

function hasClass(node: FakeElement, className: string): boolean {
  if (node.className.split(/\s+/u).includes(className)) return true;
  return node.children
    .filter((child): child is FakeElement => child instanceof FakeElement)
    .some((child) => hasClass(child, className));
}

describe("DingTalk message window rendering", () => {
  it("appends new messages and prepends older pages without rebuilding rows", () => {
    const document = new FakeDocument();
    const created: string[] = [];
    const revoked: string[] = [];
    const { container, list } = createList(document, created, revoked);
    const initial = [message("m1", 1_000), message("m2", 2_000)];
    list.reset(initial);
    const firstRow = list.nodeFor("m1");
    expect(renderedIds(container)).toEqual(["m1", "m2"]);

    list.append([message("m3", 3_000)]);
    expect(renderedIds(container)).toEqual(["m1", "m2", "m3"]);
    expect(list.nodeFor("m1")).toBe(firstRow);

    list.prepend([message("m0", 500)]);
    expect(renderedIds(container)).toEqual(["m0", "m1", "m2", "m3"]);
    expect(list.nodeFor("m1")).not.toBe(firstRow);
    list.dispose();
    expect(revoked).toEqual([]);
  });

  it("caps the rendered window on both edges", () => {
    const document = new FakeDocument();
    const created: string[] = [];
    const revoked: string[] = [];
    const { container, list } = createList(document, created, revoked);
    list.reset(Array.from({ length: 5 }, (_unused, index) => message(`m${index}`, index)));
    list.removeOldest(2);
    expect(renderedIds(container)).toEqual(["m2", "m3", "m4"]);
    list.removeNewest(1);
    expect(renderedIds(container)).toEqual(["m2", "m3"]);
    list.dispose();
  });

  it("revokes object URLs when a row leaves the DOM", async () => {
    const document = new FakeDocument();
    const created: string[] = [];
    const revoked: string[] = [];
    const { list } = createList(document, created, revoked);
    list.reset([
      message("img", 1_000, {
        text: "",
        resources: [{ kind: "image", resourceId: "media-1", resourceIdType: "mediaId" }],
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(created).toHaveLength(1);
    expect(revoked).toEqual([]);

    list.removeOldest(1);
    expect(revoked).toEqual(created);
    list.dispose();
  });
});

describe("DingTalk object URL pool", () => {
  it("releases the same URL only once", () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const pool = new DingTalkObjectUrls(
      () => {
        const url = `blob:${created.length + 1}`;
        created.push(url);
        return url;
      },
      (url) => revoked.push(url),
    );
    const url = pool.add(new Blob(["x"]));
    pool.release(url);
    pool.release(url);
    expect(revoked).toEqual([url]);
    expect(pool.size).toBe(0);
  });
});

describe("DingTalk message render guard", () => {
  it("falls back to plain text when markdown rendering throws", () => {
    const document = new FakeDocument();
    document.failTag = "blockquote";
    const row = createMessageRow(
      document as unknown as Document,
      message("m1", 1_000, { format: "markdown", text: "> 引用\n正文" }),
      dingtalkPageStrings("zh-CN"),
      { continuation: false },
    );
    expect(row.className).toContain("dingtalk-message--plain");
    expect(row.textContent).toContain("引用");
  });

  it("renders long bodies as plain text with an expand action", () => {
    const document = new FakeDocument();
    const row = createMessageRow(
      document as unknown as Document,
      message("m1", 1_000, { text: `----- 报警 -----\n${"长".repeat(8_100)}` }),
      dingtalkPageStrings("zh-CN"),
      { continuation: false },
    );
    expect(row.textContent).toContain("----- 报警 -----");
    expect(row.textContent).toContain("展开");
    expect(row.textContent).not.toContain("长".repeat(8_000));
  });

  it("renders image-only messages without a bubble surface", () => {
    const document = new FakeDocument();
    const row = createMessageRow(
      document as unknown as Document,
      message("m1", 1_000, {
        text: "",
        resources: [{ kind: "image", resourceId: "media-1", resourceIdType: "mediaId" }],
      }),
      dingtalkPageStrings("zh-CN"),
      { continuation: false },
    );
    expect(hasClass(row, "dingtalk-message-bubble--image")).toBe(true);
  });

  it("no longer renders a per-message checkbox", () => {
    const document = new FakeDocument();
    const row = createMessageRow(
      document as unknown as Document,
      message("m1", 1_000),
      dingtalkPageStrings("zh-CN"),
      { continuation: false },
    );
    const walk = (node: FakeElement): string[] => [
      ...(node.className.includes("dingtalk-message-check") ? [node.className] : []),
      ...node.children
        .filter((child): child is FakeElement => child instanceof FakeElement)
        .flatMap(walk),
    ];
    expect(walk(row)).toEqual([]);
    expect(
      row.children.some((child) => child instanceof FakeElement && child.tagName === "input"),
    ).toBe(false);
  });
});
