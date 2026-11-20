/** DingTalk mark used by the `@` row and the page brand. */
export function createDingTalkMark(document: Document, size: number): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("dingtalk-mark");
  const background = document.createElementNS(namespace, "rect");
  background.setAttribute("x", "1");
  background.setAttribute("y", "1");
  background.setAttribute("width", "22");
  background.setAttribute("height", "22");
  background.setAttribute("rx", "6");
  background.setAttribute("fill", "#1677ff");
  const bird = document.createElementNS(namespace, "path");
  bird.setAttribute(
    "d",
    "M5.2 13.6c2.1-3.6 5-5.9 8.6-6.9-1 .8-1.8 1.7-2.4 2.7 1.9-.3 3.5-.1 4.8.5-1.6.2-2.9.8-4 1.7 1.5.1 2.8.6 3.8 1.5-2.7 2.9-6 4.3-9.8 4.2.6-.6 1-1.2 1.3-1.9-1.1-.1-2-.7-2.3-1.8Z",
  );
  bird.setAttribute("fill", "#fff");
  svg.append(background, bird);
  return svg;
}
