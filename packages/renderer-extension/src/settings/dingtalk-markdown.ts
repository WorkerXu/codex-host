/**
 * Small Markdown subset for DingTalk card and robot bodies. It only builds
 * text nodes and anchors; no raw HTML from a message ever reaches the DOM.
 */
const INLINE_PATTERN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/gu;
const RULE_PATTERN = /^\s*(?:---|___)\s*$/u;
// `s`: a heading may contain U+2028/U+2029, which `.` does not match otherwise.
const HEADING_PATTERN = /^\s*(#{1,6})\s+(.*)$/su;
const QUOTE_PATTERN = /^\s*>\s?/u;
const BULLET_PATTERN = /^\s*[-*]\s+/u;
const ORDERED_PATTERN = /^\s*\d+\.\s+/u;

/** Exactly the lines the block branches below consume; anything else is paragraph text. */
function startsBlock(line: string): boolean {
  return (
    RULE_PATTERN.test(line) ||
    HEADING_PATTERN.test(line) ||
    QUOTE_PATTERN.test(line) ||
    BULLET_PATTERN.test(line) ||
    ORDERED_PATTERN.test(line)
  );
}

function createNode<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendInline(document: Document, parent: Node, text: string): void {
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, index)));
    const token = match[0];
    if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else if (token.startsWith("`")) {
      parent.appendChild(createNode(document, "code", "dingtalk-md-code", token.slice(1, -1)));
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token);
      const label = linkMatch?.[1] ?? token;
      const href = linkMatch?.[2] ?? "";
      if (/^(?:https?:|dingtalk:|mailto:)/iu.test(href)) {
        const anchor = document.createElement("a");
        anchor.className = "dingtalk-md-link";
        anchor.href = href;
        anchor.target = "_blank";
        anchor.rel = "noreferrer noopener";
        anchor.textContent = label;
        parent.appendChild(anchor);
      } else {
        parent.appendChild(document.createTextNode(label));
      }
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
}

function appendLines(document: Document, container: Node, lines: readonly string[]): void {
  lines.forEach((line, index) => {
    if (index > 0) container.appendChild(document.createElement("br"));
    appendInline(document, container, line);
  });
}

export function appendDingTalkMarkdown(
  document: Document,
  container: HTMLElement,
  markdown: string,
): void {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (RULE_PATTERN.test(line)) {
      container.append(createNode(document, "hr", "dingtalk-md-rule"));
      index += 1;
      continue;
    }
    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      const node = createNode(
        document,
        "div",
        `dingtalk-md-heading dingtalk-md-heading--${heading[1]?.length ?? 6}`,
      );
      appendInline(document, node, heading[2] ?? "");
      container.append(node);
      index += 1;
      continue;
    }
    if (QUOTE_PATTERN.test(line)) {
      const quote = createNode(document, "blockquote", "dingtalk-md-quote");
      const quoteLines: string[] = [];
      while (index < lines.length && QUOTE_PATTERN.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(QUOTE_PATTERN, ""));
        index += 1;
      }
      appendLines(document, quote, quoteLines);
      container.append(quote);
      continue;
    }
    if (BULLET_PATTERN.test(line)) {
      const list = document.createElement("ul");
      list.className = "dingtalk-md-list";
      while (index < lines.length && BULLET_PATTERN.test(lines[index] ?? "")) {
        const item = document.createElement("li");
        appendInline(document, item, (lines[index] ?? "").replace(BULLET_PATTERN, ""));
        list.append(item);
        index += 1;
      }
      container.append(list);
      continue;
    }
    if (ORDERED_PATTERN.test(line)) {
      const list = document.createElement("ol");
      list.className = "dingtalk-md-list";
      while (index < lines.length && ORDERED_PATTERN.test(lines[index] ?? "")) {
        const item = document.createElement("li");
        appendInline(document, item, (lines[index] ?? "").replace(ORDERED_PATTERN, ""));
        list.append(item);
        index += 1;
      }
      container.append(list);
      continue;
    }
    const paragraph = createNode(document, "div", "dingtalk-md-paragraph");
    // The current line is not a block start, so the paragraph always consumes
    // it; every iteration of the outer loop therefore advances.
    const paragraphLines: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (!next.trim() || startsBlock(next)) break;
      paragraphLines.push(next);
      index += 1;
    }
    appendLines(document, paragraph, paragraphLines);
    container.append(paragraph);
  }
}
