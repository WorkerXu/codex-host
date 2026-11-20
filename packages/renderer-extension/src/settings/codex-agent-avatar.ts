export type CodexAgentAvatarState = "idle" | "working" | "waiting" | "done";

const SVG_NS = "http://www.w3.org/2000/svg";

const PALETTE = ["#F2C6B4", "#C9D8F4", "#CBE7D5", "#E7D2F2", "#F5E2A8", "#D8D1F3"] as const;

const INK = "#2E2A2E";
const HIGHLIGHT = "#FFFFFF";

function hash(value: string): number {
  let result = 0;
  for (const character of value) {
    result = ((character.codePointAt(0) ?? 0) + (result << 6) + (result << 16) - result) >>> 0;
  }
  return result;
}

function svgNode<K extends keyof SVGElementTagNameMap>(
  document: Document,
  tag: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  return node;
}

function drawBase(document: Document, shape: number, color: string): SVGElement {
  if (shape === 1) {
    return svgNode(document, "circle", { cx: 24, cy: 24, r: 21, fill: color });
  }
  if (shape === 2) {
    return svgNode(document, "rect", {
      x: 3,
      y: 8,
      width: 42,
      height: 32,
      rx: 16,
      fill: color,
    });
  }
  return svgNode(document, "rect", {
    x: 3,
    y: 3,
    width: 42,
    height: 42,
    rx: 13,
    fill: color,
  });
}

function drawAccessory(document: Document, accessory: number, color: string): SVGElement | null {
  if (accessory === 0) {
    const group = svgNode(document, "g", { stroke: INK, "stroke-width": 1.8 });
    group.append(
      svgNode(document, "line", { x1: 24, y1: 8, x2: 24, y2: 3 }),
      svgNode(document, "circle", { cx: 24, cy: 2.6, r: 2.4, fill: color }),
    );
    return group;
  }
  if (accessory === 1) {
    const group = svgNode(document, "g", { fill: color, stroke: INK, "stroke-width": 1.4 });
    group.append(
      svgNode(document, "path", { d: "M16 7 20 1h8l4 6Z" }),
      svgNode(document, "rect", { x: 13, y: 6, width: 22, height: 3, rx: 1.5 }),
    );
    return group;
  }
  if (accessory === 2) {
    const group = svgNode(document, "g", { fill: color, stroke: INK, "stroke-width": 1.5 });
    group.append(
      svgNode(document, "circle", { cx: 7, cy: 16, r: 4 }),
      svgNode(document, "circle", { cx: 41, cy: 16, r: 4 }),
    );
    return group;
  }
  const group = svgNode(document, "g", {
    stroke: INK,
    "stroke-width": 1.8,
    "stroke-linecap": "round",
  });
  group.append(
    svgNode(document, "line", { x1: 12, y1: 17, x2: 21, y2: 15 }),
    svgNode(document, "line", { x1: 27, y1: 15, x2: 36, y2: 17 }),
  );
  return group;
}

function openEyes(document: Document, y: number): SVGElement[] {
  const nodes: SVGElement[] = [];
  for (const x of [17, 31]) {
    nodes.push(
      svgNode(document, "circle", {
        cx: x,
        cy: y,
        r: 4.2,
        fill: INK,
        class: "agent-avatar-eye",
      }),
      svgNode(document, "circle", {
        cx: x - 1.3,
        cy: y - 1.4,
        r: 1.2,
        fill: HIGHLIGHT,
        class: "agent-avatar-eye-highlight",
      }),
    );
  }
  return nodes;
}

function focusedEyes(document: Document): SVGElement[] {
  return [17, 31].flatMap((x) => [
    svgNode(document, "ellipse", {
      cx: x,
      cy: 25,
      rx: 3.5,
      ry: 2.6,
      fill: INK,
      class: "agent-avatar-eye agent-avatar-eye--working",
    }),
    svgNode(document, "line", {
      x1: x - 4.5,
      y1: 22.5,
      x2: x + 4.5,
      y2: 22.5,
      stroke: INK,
      "stroke-width": 1.5,
      "stroke-linecap": "round",
    }),
  ]);
}

function winkEyes(document: Document): SVGElement[] {
  return [
    svgNode(document, "circle", {
      cx: 17,
      cy: 25,
      r: 4.2,
      fill: INK,
      class: "agent-avatar-eye",
    }),
    svgNode(document, "circle", { cx: 15.7, cy: 23.6, r: 1.2, fill: HIGHLIGHT }),
    svgNode(document, "path", {
      d: "M27 25q4 3 8 0",
      fill: "none",
      stroke: INK,
      "stroke-width": 1.8,
      "stroke-linecap": "round",
    }),
    svgNode(document, "line", {
      x1: 27,
      y1: 18,
      x2: 35,
      y2: 16,
      stroke: INK,
      "stroke-width": 1.8,
      "stroke-linecap": "round",
    }),
  ];
}

function happyEyes(document: Document): SVGElement[] {
  return [17, 31].map((x) =>
    svgNode(document, "path", {
      d: `M${x - 4} 26q4-5 8 0`,
      fill: "none",
      stroke: INK,
      "stroke-width": 2,
      "stroke-linecap": "round",
      class: "agent-avatar-eye agent-avatar-eye--done",
    }),
  );
}

function restingEyes(document: Document): SVGElement[] {
  return [17, 31].map((x) =>
    svgNode(document, "path", {
      d: `M${x - 4} 24q4 4 8 0`,
      fill: "none",
      stroke: INK,
      "stroke-width": 2,
      "stroke-linecap": "round",
      class: "agent-avatar-eye agent-avatar-eye--resting",
    }),
  );
}

/**
 * GrokBot-style bot identity: one of three geometric bases, one of six soft
 * colors, one of four accessories and a pair of eyes that carry the state.
 */
export function createAgentAvatar(
  document: Document,
  name: string,
  state: CodexAgentAvatarState = "idle",
  resting = false,
): SVGSVGElement {
  const seed = hash(name);
  const color = PALETTE[seed % PALETTE.length] as (typeof PALETTE)[number];
  const svg = svgNode(document, "svg", {
    viewBox: "0 0 48 48",
    width: 48,
    height: 48,
    class: "agent-avatar-svg",
    "aria-hidden": "true",
    focusable: "false",
  });
  svg.dataset.state = resting ? "resting" : state;
  svg.append(drawBase(document, Math.floor(seed / 4) % 3, color));
  const accessory = drawAccessory(document, seed % 4, color);
  if (accessory) svg.append(accessory);
  let eyes: SVGElement[];
  if (resting) eyes = restingEyes(document);
  else if (state === "working") eyes = focusedEyes(document);
  else if (state === "waiting") eyes = winkEyes(document);
  else if (state === "done") eyes = happyEyes(document);
  else eyes = openEyes(document, 25);
  svg.append(...eyes);
  return svg;
}
