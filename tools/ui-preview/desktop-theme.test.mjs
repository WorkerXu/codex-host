import { describe, expect, it } from "vitest";
import { desktopTheme } from "./desktop-theme.mjs";
describe("Desktop preview theme", () => {
  it("preserves actual light/dark variables and media conditions without document styles", () => {
    const theme = desktopTheme(
      `@layer theme { :root,:host { --surface:light-dark(white,black); color:red; } [data-theme="dark"] { --text:white; } @supports (color:color-mix(in srgb,red,blue)) { :root { --focus:blue; } } } .button { background:red; --unrelated:1; }`,
    );
    expect(theme.declared).toEqual(new Set(["--surface", "--text", "--focus"]));
    expect(theme.colorSchemes).toBe(true);
    expect(theme.css).toContain('[data-theme="dark"]');
    expect(theme.css).toContain("@supports");
    expect(theme.css).not.toContain("color:red");
    expect(theme.css).not.toContain(".button");
  });
});
