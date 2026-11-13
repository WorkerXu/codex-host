import type { RendererSettingsLocale } from "./localization.js";

/** Page copy kept apart from DOM construction. */
export interface DingTalkPageText {
  connecting: string;
  connected: string;
  brand: string;
  hostLabel: string;
  hostAuto: string;
  hostLocal: string;
  hostEffective: string;
  hostChangeFailed: string;
  unavailable: string;
  refresh: string;
  searchPlaceholder: string;
  searching: string;
  searchResults: string;
  clearSearch: string;
  noSearchResults: string;
  searchFallback: string;
  recentReplied: string;
  unread: string;
  recentRepliedNotice: string;
  noConversations: string;
  listFailed: string;
  selectConversation: string;
  emptyMessages: string;
  loading: string;
  messagesFailed: string;
  notLoaded: string;
  direct: string;
  group: string;
  muted: string;
  unnamed: string;
  selectMessage: string;
  mobileOnly: string;
  embedConversation: string;
  embedSelected: string;
  embedFailed: string;
  send: string;
  sending: string;
  sendFailed: string;
  sendPlaceholder: string;
}

const ZH: DingTalkPageText = {
  connecting: "连接中…",
  connected: "已连接 · {host}",
  brand: "钉钉",
  hostLabel: "钉钉登录",
  hostAuto: "自动（优先 tencent）",
  hostLocal: "本机",
  hostEffective: "当前使用 {name} 的钉钉登录",
  hostChangeFailed: "切换钉钉 Host 失败",
  unavailable: "不可用",
  refresh: "刷新",
  searchPlaceholder: "搜索会话或聊天记录",
  searching: "搜索中…",
  searchResults: "搜索结果",
  clearSearch: "清除搜索",
  noSearchResults: "没有匹配的会话或消息",
  searchFallback: "搜索分类不可用，已按关键词搜索",
  recentReplied: "最近回复",
  unread: "未读会话",
  recentRepliedNotice: "当前没有未读会话，显示你最近回复的会话。",
  noConversations: "暂无会话",
  listFailed: "会话列表读取失败",
  selectConversation: "选择一个会话",
  emptyMessages: "选择左侧会话查看消息",
  loading: "加载中…",
  messagesFailed: "消息读取失败",
  notLoaded: "该消息还未加载，请继续向上滚动",
  direct: "单聊",
  group: "群聊",
  muted: "免打扰",
  unnamed: "未命名会话",
  selectMessage: "选择消息",
  mobileOnly: "非文本消息，请在手机上查看",
  embedConversation: "嵌入整个会话",
  embedSelected: "嵌入所选消息",
  embedFailed: "无法嵌入：请重新打开该对话的输入框",
  send: "发送",
  sending: "发送中…",
  sendFailed: "发送失败",
  sendPlaceholder: "以我的身份发送钉钉消息（Enter 发送，Shift+Enter 换行）",
};

const EN: DingTalkPageText = {
  connecting: "Connecting…",
  connected: "Connected · {host}",
  brand: "DingTalk",
  hostLabel: "DingTalk login",
  hostAuto: "Auto (prefer tencent)",
  hostLocal: "This machine",
  hostEffective: "Using the DingTalk login on {name}",
  hostChangeFailed: "Could not switch the DingTalk Host",
  unavailable: "Unavailable",
  refresh: "Refresh",
  searchPlaceholder: "Search conversations or messages",
  searching: "Searching…",
  searchResults: "Search results",
  clearSearch: "Clear search",
  noSearchResults: "No matching conversations or messages",
  searchFallback: "Classification is unavailable; searched by keyword",
  recentReplied: "Recently replied",
  unread: "Unread",
  recentRepliedNotice: "No unread conversations; showing conversations you recently replied to.",
  noConversations: "No conversations",
  listFailed: "Could not read conversations",
  selectConversation: "Select a conversation",
  emptyMessages: "Select a conversation on the left",
  loading: "Loading…",
  messagesFailed: "Could not read messages",
  notLoaded: "This message is not loaded yet; scroll up",
  direct: "Direct",
  group: "Group",
  muted: "Muted",
  unnamed: "Untitled conversation",
  selectMessage: "Select message",
  mobileOnly: "Non-text message; view it on your phone",
  embedConversation: "Embed conversation",
  embedSelected: "Embed selected",
  embedFailed: "Could not embed: reopen the Composer that opened this page",
  send: "Send",
  sending: "Sending…",
  sendFailed: "Send failed",
  sendPlaceholder: "Send as me (Enter to send, Shift+Enter for a new line)",
};

export function dingtalkPageStrings(locale: RendererSettingsLocale): DingTalkPageText {
  return locale === "zh-CN" ? ZH : EN;
}
