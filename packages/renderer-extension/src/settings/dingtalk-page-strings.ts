import type { RendererSettingsLocale } from "./localization.js";

/** Page copy kept apart from DOM construction. */
export interface DingTalkPageText {
  brand: string;
  moreActions: string;
  menuConnected: string;
  menuUnavailable: string;
  menuLoginLabel: string;
  hostAuto: string;
  hostLocal: string;
  hostEffective: string;
  hostChangeFailed: string;
  refreshConversations: string;
  unavailable: string;
  searchPlaceholder: string;
  clearSearch: string;
  searching: string;
  searchConversations: string;
  searchMessages: string;
  searchMore: string;
  searchKeyboardHint: string;
  noSearchResults: string;
  searchFailed: string;
  searchFallback: string;
  recentReplied: string;
  unread: string;
  noConversations: string;
  noUnreadConversations: string;
  listFailed: string;
  listFailedReason: string;
  retry: string;
  selectConversation: string;
  emptyMessages: string;
  loadingMessages: string;
  messagesFailed: string;
  notLoaded: string;
  direct: string;
  group: string;
  unnamed: string;
  selectMessage: string;
  unsupported: string;
  embedConversation: string;
  embedFailed: string;
  refreshMessages: string;
  selectedCount: string;
  embedToConversation: string;
  cancelSelection: string;
  send: string;
  sending: string;
  sendFailed: string;
  retrySend: string;
  sendPlaceholder: string;
  newMessages: string;
  loadMoreFailed: string;
}

const ZH: DingTalkPageText = {
  brand: "钉钉",
  moreActions: "更多操作",
  menuConnected: "已连接 · {host}",
  menuUnavailable: "钉钉连接不可用",
  menuLoginLabel: "钉钉登录",
  hostAuto: "自动选择",
  hostLocal: "本机",
  hostEffective: "当前使用 {name} 的钉钉登录",
  hostChangeFailed: "切换钉钉登录失败，请稍后重试",
  refreshConversations: "刷新会话",
  unavailable: "钉钉暂不可用",
  searchPlaceholder: "搜索",
  clearSearch: "清除搜索",
  searching: "正在搜索…",
  searchConversations: "会话",
  searchMessages: "聊天记录",
  searchMore: "查看更多（{count}）",
  searchKeyboardHint: "↑↓ 移动 · ↵ 打开 · Esc 退出",
  noSearchResults: "没有找到相关会话或消息",
  searchFailed: "搜索失败，请稍后重试",
  searchFallback: "搜索分类不可用，已按关键词搜索",
  recentReplied: "最近回复",
  unread: "未读",
  noConversations: "暂无会话",
  noUnreadConversations: "暂无未读会话",
  listFailed: "会话列表读取失败",
  listFailedReason: "钉钉连接不可用，请稍后重试",
  retry: "重试",
  selectConversation: "选择一个会话",
  emptyMessages: "从左侧选择会话开始查看消息",
  loadingMessages: "正在加载消息…",
  messagesFailed: "消息加载失败，请稍后重试",
  notLoaded: "这条消息还没有加载，请继续向上滚动",
  direct: "单聊",
  group: "群聊",
  unnamed: "未命名会话",
  selectMessage: "选择消息",
  unsupported: "在手机上查看",
  embedConversation: "嵌入会话到对话",
  embedFailed: "无法嵌入：请重新打开该对话的输入框",
  refreshMessages: "刷新消息",
  selectedCount: "已选 {count} 条",
  embedToConversation: "嵌入到对话",
  cancelSelection: "取消",
  send: "发送",
  sending: "发送中…",
  sendFailed: "发送失败，点击重试",
  retrySend: "重试发送",
  sendPlaceholder: "发送给 {name}",
  newMessages: "{count} 条新消息",
  loadMoreFailed: "更早的消息加载失败，请重试",
};

const EN: DingTalkPageText = {
  brand: "DingTalk",
  moreActions: "More actions",
  menuConnected: "Connected · {host}",
  menuUnavailable: "DingTalk is unavailable",
  menuLoginLabel: "DingTalk login",
  hostAuto: "Choose automatically",
  hostLocal: "This machine",
  hostEffective: "Using the DingTalk login on {name}",
  hostChangeFailed: "Could not switch the DingTalk login. Try again.",
  refreshConversations: "Refresh conversations",
  unavailable: "DingTalk is unavailable",
  searchPlaceholder: "Search",
  clearSearch: "Clear search",
  searching: "Searching…",
  searchConversations: "Conversations",
  searchMessages: "Messages",
  searchMore: "Show more ({count})",
  searchKeyboardHint: "↑↓ Move · ↵ Open · Esc Exit",
  noSearchResults: "No matching conversations or messages",
  searchFailed: "Search failed. Try again.",
  searchFallback: "Classification is unavailable; searched by keyword",
  recentReplied: "Recently replied",
  unread: "Unread",
  noConversations: "No conversations",
  noUnreadConversations: "No unread conversations",
  listFailed: "Could not read conversations",
  listFailedReason: "DingTalk is unavailable. Try again.",
  retry: "Retry",
  selectConversation: "Select a conversation",
  emptyMessages: "Choose a conversation on the left",
  loadingMessages: "Loading messages…",
  messagesFailed: "Could not load messages. Try again.",
  notLoaded: "This message is not loaded yet; scroll up",
  direct: "Direct",
  group: "Group",
  unnamed: "Untitled conversation",
  selectMessage: "Select message",
  unsupported: "View on your phone",
  embedConversation: "Embed conversation in chat",
  embedFailed: "Could not embed: reopen the Composer that opened this page",
  refreshMessages: "Refresh messages",
  selectedCount: "{count} selected",
  embedToConversation: "Embed in conversation",
  cancelSelection: "Cancel",
  send: "Send",
  sending: "Sending…",
  sendFailed: "Send failed. Click to retry.",
  retrySend: "Retry sending",
  sendPlaceholder: "Send to {name}",
  newMessages: "{count} new messages",
  loadMoreFailed: "Could not load older messages. Try again.",
};

export function dingtalkPageStrings(locale: RendererSettingsLocale): DingTalkPageText {
  return locale === "zh-CN" ? ZH : EN;
}
