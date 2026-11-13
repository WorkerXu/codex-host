import { describe, expect, it } from "vitest";

import {
  extractLoginUrl,
  loginCallbackPort,
  rewriteLoginCallbackPort,
} from "../src/jarvis-login.js";

const output =
  "请在本机浏览器完成登录，未自动打开时请访问：\n" +
  "https://auth.eshetang.com/login/auth?app_id=17&callback_url=http%3A%2F%2F127.0.0.1%3A42983%2Foauth%2Fcallback%2Fstate&redirect_url=http%3A%2F%2F127.0.0.1%3A42983%2Fcomplete&state=state";

describe("Jarvis login URL", () => {
  it("extracts the auth URL and its callback port", () => {
    const url = extractLoginUrl(output);
    expect(url?.hostname).toBe("auth.eshetang.com");
    expect(url && loginCallbackPort(url)).toBe(42983);
    expect(extractLoginUrl("no url here")).toBeNull();
  });

  it("rewrites both callback and completion ports for the local forward", () => {
    const url = extractLoginUrl(output);
    if (!url) throw new Error("fixture URL was not parsed");
    const rewritten = new URL(rewriteLoginCallbackPort(url.toString(), 51000));
    for (const key of ["callback_url", "redirect_url"]) {
      const value = rewritten.searchParams.get(key);
      expect(value).not.toBeNull();
      expect(new URL(value ?? "").port).toBe("51000");
    }
    expect(rewritten.searchParams.get("state")).toBe("state");
  });
});
