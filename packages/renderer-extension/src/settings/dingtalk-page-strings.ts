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
  searchContacts: string;
  searchGroups: string;
  searchMessages: string;
  searchMore: string;
  noSearchResults: string;
  searchFailed: string;
  noUnreadConversations: string;
  listFailedReason: string;
  retry: string;
  selectConversation: string;
  emptyMessages: string;
  messagesFailed: string;
  notLoaded: string;
  unnamed: string;
  embedConversation: string;
  embedFailed: string;
  refreshMessages: string;
  send: string;
  sendFailed: string;
  retrySend: string;
  sendPlaceholder: string;
  newMessages: string;
  loadMoreFailed: string;
  closeImage: string;
  previousImage: string;
  nextImage: string;
  imageLoading: string;
  imageFailed: string;
  mentionMembers: string;
  mentionAll: string;
  mentionSearchPlaceholder: string;
  noMatchingMembers: string;
  membersFailed: string;
  membersLoading: string;
  removeMention: string;
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
  searchContacts: "联系人",
  searchGroups: "群聊",
  searchMessages: "聊天记录",
  searchMore: "查看更多（{count}）",
  noSearchResults: "没有找到相关会话或消息",
  searchFailed: "搜索失败，请稍后重试",
  noUnreadConversations: "最近 48 小时没有未读消息",
  listFailedReason: "钉钉连接不可用，请稍后重试",
  retry: "重试",
  selectConversation: "选择一个会话",
  emptyMessages: "选择一个会话开始查看",
  messagesFailed: "消息加载失败，请稍后重试",
  notLoaded: "这条消息还没有加载，请继续向上滚动",
  unnamed: "未命名会话",
  embedConversation: "嵌入会话到对话",
  embedFailed: "无法嵌入：请重新打开该对话的输入框",
  refreshMessages: "刷新消息",
  send: "发送",
  sendFailed: "发送失败，点击重试",
  retrySend: "重试发送",
  sendPlaceholder: "发送给 {name}",
  newMessages: "{count} 条新消息",
  loadMoreFailed: "更早的消息加载失败，请重试",
  closeImage: "关闭图片",
  previousImage: "上一张",
  nextImage: "下一张",
  imageLoading: "正在加载图片",
  imageFailed: "图片加载失败",
  mentionMembers: "选择要提醒的成员",
  mentionAll: "所有人",
  mentionSearchPlaceholder: "搜索成员",
  noMatchingMembers: "没有匹配的成员",
  membersFailed: "成员加载失败",
  membersLoading: "正在加载成员",
  removeMention: "移除",
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
  searchContacts: "Contacts",
  searchGroups: "Groups",
  searchMessages: "Messages",
  searchMore: "Show more ({count})",
  noSearchResults: "No matching conversations or messages",
  searchFailed: "Search failed. Try again.",
  noUnreadConversations: "No unread messages in the last 48 hours",
  listFailedReason: "DingTalk is unavailable. Try again.",
  retry: "Retry",
  selectConversation: "Select a conversation",
  emptyMessages: "Choose a conversation on the left",
  messagesFailed: "Could not load messages. Try again.",
  notLoaded: "This message is not loaded yet; scroll up",
  unnamed: "Untitled conversation",
  embedConversation: "Embed conversation in chat",
  embedFailed: "Could not embed: reopen the Composer that opened this page",
  refreshMessages: "Refresh messages",
  send: "Send",
  sendFailed: "Send failed. Click to retry.",
  retrySend: "Retry sending",
  sendPlaceholder: "Send to {name}",
  newMessages: "{count} new messages",
  loadMoreFailed: "Could not load older messages. Try again.",
  closeImage: "Close image",
  previousImage: "Previous image",
  nextImage: "Next image",
  imageLoading: "Loading image",
  imageFailed: "Could not load the image",
  mentionMembers: "Mention a group member",
  mentionAll: "Everyone",
  mentionSearchPlaceholder: "Search members",
  noMatchingMembers: "No matching members",
  membersFailed: "Could not load members",
  membersLoading: "Loading members",
  removeMention: "Remove",
};

export function dingtalkPageStrings(locale: RendererSettingsLocale): DingTalkPageText {
  return locale === "zh-CN" ? ZH : EN;
}
