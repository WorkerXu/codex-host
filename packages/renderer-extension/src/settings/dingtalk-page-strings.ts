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
  dispatchAgent: string;
  copyMessage: string;
  copyDone: string;
  replyMessage: string;
  messageMenu: string;
  panelTitle: string;
  panelSubtitle: string;
  panelLoading: string;
  panelScoring: string;
  panelFailed: string;
  panelEmpty: string;
  panelNeedsTarget: string;
  panelReady: string;
  panelDispatch: string;
  panelDispatching: string;
  panelCancel: string;
  panelClose: string;
  panelScore: string;
  panelAlready: string;
  panelStillDispatch: string;
  dispatchedTo: string;
  openAgentThread: string;
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
  dispatchAgent: "交给智能体",
  copyMessage: "复制",
  copyDone: "已复制",
  replyMessage: "回复",
  messageMenu: "消息操作",
  panelTitle: "交给智能体",
  panelSubtitle: "选择处理这条消息的智能体",
  panelLoading: "正在判断哪几个智能体能处理…",
  panelScoring: "正在判断…",
  panelFailed: "判断失败，可直接选择",
  panelEmpty: "还没有启用钉钉的智能体，请先在「智能体」页面启用",
  panelNeedsTarget: "需要设置分区和工作项目",
  panelReady: "可派发",
  panelDispatch: "派发（{count}）",
  panelDispatching: "正在派发…",
  panelCancel: "取消",
  panelClose: "关闭",
  panelScore: "{percent}%",
  panelAlready: "已派发过，仍要派发？",
  panelStillDispatch: "仍要派发",
  dispatchedTo: "已派发：",
  openAgentThread: "打开「{name}」的对话",
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
  dispatchAgent: "Send to agent",
  copyMessage: "Copy",
  copyDone: "Copied",
  replyMessage: "Reply",
  messageMenu: "Message actions",
  panelTitle: "Send to agent",
  panelSubtitle: "Choose the agents that handle this message",
  panelLoading: "Deciding which agents can handle this…",
  panelScoring: "Scoring…",
  panelFailed: "Scoring failed; choose any agent",
  panelEmpty: "No agent has DingTalk enabled. Enable one on the Agents page.",
  panelNeedsTarget: "Needs a section and project",
  panelReady: "Ready",
  panelDispatch: "Send ({count})",
  panelDispatching: "Sending…",
  panelCancel: "Cancel",
  panelClose: "Close",
  panelScore: "{percent}%",
  panelAlready: "Already sent to this agent. Send again?",
  panelStillDispatch: "Send again",
  dispatchedTo: "Sent to:",
  openAgentThread: "Open {name}'s thread",
};

export function dingtalkPageStrings(locale: RendererSettingsLocale): DingTalkPageText {
  return locale === "zh-CN" ? ZH : EN;
}
