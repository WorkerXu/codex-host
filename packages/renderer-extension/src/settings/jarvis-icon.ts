/** Jarvis mark used by the `@` row; same construction as the DingTalk mark. */
export function createJarvisMark(document: Document, size: number): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("jarvis-mark");
  const background = document.createElementNS(namespace, "rect");
  background.setAttribute("x", "1");
  background.setAttribute("y", "1");
  background.setAttribute("width", "22");
  background.setAttribute("height", "22");
  background.setAttribute("rx", "6");
  background.setAttribute("fill", "#6b5bff");
  const spark = document.createElementNS(namespace, "path");
  spark.setAttribute(
    "d",
    "M12 4.6l1.7 5.1 5.1 1.7-5.1 1.7L12 18.2l-1.7-5.1-5.1-1.7 5.1-1.7L12 4.6Z",
  );
  spark.setAttribute("fill", "#fff");
  svg.append(background, spark);
  return svg;
}
