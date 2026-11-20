import { describe, expect, it } from "vitest";

import {
  compactDingTalkPreview,
  formatDingTalkCardSummary,
  parseDingTalkCardSummary,
} from "../src/dingtalk-summary.js";

const CHAIN_BODY = [
  "chains",
  "dingtalk://dingtalkclient/action/open_platform_link?pcLink=https%3A%2F%2Fn.example.com%2Fdetail",
  '[{"text":{"zh_Hans":"嗑瓜子大赛报名接龙"},"type":"TITLE"},{"text":{"zh_Hans":"陈忆莲发起，已有15人参加"},"type":"DESCRIPTION"}]',
  '[{"ranks":[{"id":"chains","title":" "}],"type":"RANK"}]',
  '["enroll_chains_select","enroll_chains_write"]',
  '{"color":"#FF9F00","text":{"zh_Hans":"群接龙"}}',
].join("\n");

describe("parseDingTalkCardSummary", () => {
  it("reads a group-chain card as label, title and description", () => {
    expect(parseDingTalkCardSummary(CHAIN_BODY)).toEqual({
      label: "群接龙",
      title: "嗑瓜子大赛报名接龙",
      description: "已有15人参加",
    });
    const summary = parseDingTalkCardSummary(CHAIN_BODY);
    expect(summary ? formatDingTalkCardSummary(summary) : "").toBe(
      "[群接龙] 嗑瓜子大赛报名接龙 · 已有15人参加",
    );
  });

  it("reads a generic interactive card from its JSON text", () => {
    const body =
      '{"title":{"zh_Hans":"审批提醒"},"description":{"zh_Hans":"待你处理"},"type":"CARD"}';
    expect(parseDingTalkCardSummary(body)).toEqual({
      label: "卡片",
      title: "审批提醒",
      description: "待你处理",
    });
  });

  it("leaves ordinary text and links to the compact preview", () => {
    expect(parseDingTalkCardSummary("收到，我晚点看")).toBeNull();
    expect(compactDingTalkPreview("收到，我晚点看")).toBe("收到，我晚点看");
    expect(compactDingTalkPreview("看这个\nhttps://example.com/a/very/long/link")).toBe("看这个");
    expect(compactDingTalkPreview("dingtalk://dingtalkclient/action/open_platform_link?x=1")).toBe(
      "在手机上查看",
    );
    expect(compactDingTalkPreview(CHAIN_BODY)).toBe("[群接龙] 嗑瓜子大赛报名接龙 · 已有15人参加");
  });
});
