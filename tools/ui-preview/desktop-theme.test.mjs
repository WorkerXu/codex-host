import { describe, expect, it } from "vitest";
import { desktopThemeCss } from "./desktop-theme.mjs";

describe("exported Desktop theme", () => {
  it("keeps real light/dark variables and media conditions without injecting native component styles", () => {
    const css = desktopThemeCss(`@layer theme {
      :root {--surface:light-dark(white,black); color:red;}
      [data-theme="dark"] {--ink:white; color-scheme:dark;}
      @media(prefers-color-scheme:dark) { :root:not([data-theme]) {--ink:white;} }
      .native-button {--private:1; border:1px solid red;}
    }`);
    expect(css).toContain("light-dark(white,black)");
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain("color-scheme:dark");
    expect(css).toContain("prefers-color-scheme:dark");
    expect(css).not.toContain("native-button");
    expect(css).not.toContain("color:red");
  });
});
