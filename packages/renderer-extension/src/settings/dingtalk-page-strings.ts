import type { RendererSettingsLocale } from "./localization.js";

/** Page copy kept apart from DOM construction. */
export interface DingTalkPageText {
  brand: string;
  moreActions: string;
  menuConnected: string;
  menuNotLoggedIn: string;
  menuServiceUnavailable: string;
  refreshConversations: string;
  searchPlaceholder: string;
  clearSearch: string;
  searchConversations: string;
  searchMessages: string;
  searchMore: string;
  searchKeyboardHint: string;
  noSearchResults: string;
  searchFailed: string;
  recentReplied: string;
  unread: string;
  noConversations: string;
  noUnreadConversations: string;
  listFailedReason: string;
  retry: string;
  selectConversation: string;
  emptyMessages: string;
  messagesFailed: string;
  notLoaded: string;
  unnamed: string;
  selectMessage: string;
  embedConversation: string;
  embedFailed: string;
  refreshMessages: string;
  selectedCount: string;
  embedToConversation: string;
  cancelSelection: string;
  send: string;
  sendFailed: string;
  retrySend: string;
  sendPlaceholder: string;
  newMessages: string;
  loadMoreFailed: string;
}

const ZH: DingTalkPageText = {
  brand: "钉钉",
  moreActions: "更多操作",
  menuConnected: "已连接",
  menuNotLoggedIn: "钉钉未登录",
  menuServiceUnavailable: "无法连接钉钉服务",
  refreshConversations: "刷新会话",
  searchPlaceholder: "搜索",
  clearSearch: "清除搜索",
  searchConversations: "会话",
  searchMessages: "聊天记录",
  searchMore: "查看更多（{count}）",
  searchKeyboardHint: "↑↓ 移动 · ↵ 打开 · Esc 退出",
  noSearchResults: "没有找到相关会话或消息",
  searchFailed: "搜索失败，请稍后重试",
  recentReplied: "最近回复",
  unread: "未读",
  noConversations: "暂无会话",
  noUnreadConversations: "暂无未读会话",
  listFailedReason: "钉钉连接不可用，请稍后重试",
  retry: "重试",
  selectConversation: "选择一个会话",
  emptyMessages: "从左侧选择会话开始查看消息",
  messagesFailed: "消息加载失败，请稍后重试",
  notLoaded: "这条消息还没有加载，请继续向上滚动",
  unnamed: "未命名会话",
  selectMessage: "选择消息",
  embedConversation: "嵌入会话到对话",
  embedFailed: "无法嵌入：请重新打开该对话的输入框",
  refreshMessages: "刷新消息",
  selectedCount: "已选 {count} 条",
  embedToConversation: "嵌入到对话",
  cancelSelection: "取消",
  send: "发送",
  sendFailed: "发送失败，点击重试",
  retrySend: "重试发送",
  sendPlaceholder: "发送给 {name}",
  newMessages: "{count} 条新消息",
  loadMoreFailed: "更早的消息加载失败，请重试",
};

const EN: DingTalkPageText = {
  brand: "DingTalk",
  moreActions: "More actions",
  menuConnected: "Connected",
  menuNotLoggedIn: "DingTalk is not signed in",
  menuServiceUnavailable: "Cannot reach the DingTalk service",
  refreshConversations: "Refresh conversations",
  searchPlaceholder: "Search",
  clearSearch: "Clear search",
  searchConversations: "Conversations",
  searchMessages: "Messages",
  searchMore: "Show more ({count})",
  searchKeyboardHint: "↑↓ Move · ↵ Open · Esc Exit",
  noSearchResults: "No matching conversations or messages",
  searchFailed: "Search failed. Try again.",
  recentReplied: "Recently replied",
  unread: "Unread",
  noConversations: "No conversations",
  noUnreadConversations: "No unread conversations",
  listFailedReason: "DingTalk is unavailable. Try again.",
  retry: "Retry",
  selectConversation: "Select a conversation",
  emptyMessages: "Choose a conversation on the left",
  messagesFailed: "Could not load messages. Try again.",
  notLoaded: "This message is not loaded yet; scroll up",
  unnamed: "Untitled conversation",
  selectMessage: "Select message",
  embedConversation: "Embed conversation in chat",
  embedFailed: "Could not embed: reopen the Composer that opened this page",
  refreshMessages: "Refresh messages",
  selectedCount: "{count} selected",
  embedToConversation: "Embed in conversation",
  cancelSelection: "Cancel",
  send: "Send",
  sendFailed: "Send failed. Click to retry.",
  retrySend: "Retry sending",
  sendPlaceholder: "Send to {name}",
  newMessages: "{count} new messages",
  loadMoreFailed: "Could not load older messages. Try again.",
};

export function dingtalkPageStrings(locale: RendererSettingsLocale): DingTalkPageText {
  return locale === "zh-CN" ? ZH : EN;
}
