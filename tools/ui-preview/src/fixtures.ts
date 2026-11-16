import type {
  CodexAgentCatalogResult,
  CodexAgentRecord,
  CodexAgentSummary,
  DingTalkConversation,
  DingTalkDispatchSettings,
  DingTalkMessage,
} from "@codexhost/shared-contracts";

import type {
  ProjectGroupAddMachineTarget,
  ProjectGroupView,
} from "../../../packages/renderer-extension/src/renderer-project-groups-model.js";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const now = Date.now();

function conversation(
  id: string,
  title: string,
  singleChat: boolean,
  unreadCount: number,
  age: number,
  preview: string,
  muted = false,
  extra: Partial<DingTalkConversation> = {},
): DingTalkConversation {
  return {
    conversationId: id,
    title,
    singleChat,
    unreadCount,
    lastMessageAt: now - age,
    muted,
    preview,
    ...extra,
  };
}

export const conversations: DingTalkConversation[] = [
  conversation(
    "cid-launch",
    "产品发布群",
    false,
    3,
    5 * minute,
    "吴菁：发布窗口定在周五 20:00，今晚先冻结分支。",
    false,
    { groupType: "INTERNAL_GROUP", memberCount: 18, atMe: true },
  ),
  conversation("cid-finance", "财务打款群", false, 12, 22 * minute, "", false, {
    groupType: "INTERNAL_GROUP",
    memberCount: 9,
  }),
  conversation(
    "cid-wujing",
    "吴菁",
    true,
    1,
    47 * minute,
    "明天上午的评审还需要你确认一下。",
    false,
    {
      subtitle: "产品经理",
      memberCount: 2,
    },
  ),
  conversation(
    "cid-design",
    "设计评审",
    false,
    28,
    2 * hour,
    "陈默：[图片] 新版工作台视觉稿",
    true,
    { groupType: "INTERNAL_GROUP", memberCount: 7 },
  ),
  conversation("cid-chenmo", "陈默", true, 99, 3 * hour, "收到，我晚点把数据补上。"),
  conversation(
    "cid-customer",
    "客户成功 · 腾讯云",
    false,
    128,
    4 * hour,
    "客户反馈：登录后偶发白屏，先收集日志。",
  ),
  conversation("cid-duty", "研发值班", false, 0, 5 * hour, "值班机器人：夜间巡检完成，无异常。"),
  conversation(
    "cid-partner",
    "2026 Q4 华东区渠道生态合作伙伴联合增长计划讨论群（勿拉外部人员）",
    false,
    7,
    6 * hour,
    "下周的联合发布会需要确定场地和直播链路。",
  ),
  conversation("cid-liuqi", "刘琪", true, 0, 8 * hour, "文档已经发你了，麻烦看一下第三章。"),
  conversation("cid-release", "版本发布协调", false, 2, 10 * hour, "v0.17.4 的签名包已上传。"),
  conversation("cid-hr", "入职与转正", false, 0, 13 * hour, "下周一有两位新同事入职。"),
  conversation("cid-zhangyu", "张宇", true, 0, 18 * hour, "这个问题我复现了，稍后贴日志。"),
  conversation("cid-budget", "2027 年预算评审", false, 6, 21 * hour, "材料请在月底前提交财务。"),
  conversation("cid-security", "安全与合规", false, 0, 26 * hour, "本季度渗透测试报告已归档。"),
  conversation("cid-wangfan", "王帆", true, 4, 30 * hour, "今晚有空对一下接口吗？"),
  conversation("cid-ops", "线上问题跟进", false, 15, 34 * hour, "网关超时告警已恢复，继续观察。"),
  conversation("cid-recruit", "招聘协作", false, 1, 2 * day, "候选人二面安排在下周三下午。"),
  conversation("cid-sunlei", "孙磊", true, 0, 2 * day + 3 * hour, "好的，就按这个方案推进。"),
  conversation(
    "cid-weekly",
    "部门周会",
    false,
    0,
    2 * day + 8 * hour,
    "周报模板更新了，记得用新版。",
  ),
  conversation("cid-support", "客户支持值班群", false, 36, 3 * day, "工单 #4821 已升级为 P1。"),
  conversation("cid-legal", "合同与法务", false, 0, 3 * day + 4 * hour, "补充协议已盖章寄出。"),
  conversation("cid-xujing", "徐静", true, 2, 3 * day + 9 * hour, "截图我看到了，是缓存没刷新。"),
  conversation("cid-docs", "文档共建", false, 0, 4 * day, "工作台 UI 规范已经合并。"),
  conversation(
    "cid-data",
    "数据看板需求",
    false,
    9,
    4 * day + 6 * hour,
    "留存口径还需要产品再确认。",
  ),
  conversation("cid-lucy", "Lucy", true, 0, 5 * day, "The deck looks good to me."),
  conversation("cid-qa", "测试验收", false, 0, 5 * day + 2 * hour, "回归用例全部通过。"),
  conversation("cid-market", "市场活动", false, 18, 6 * day, "展位物料周五前要定稿。"),
  conversation("cid-zhaomin", "赵敏", true, 0, 7 * day, "下周我在深圳，线上聊。"),
  conversation("cid-arch", "架构评审", false, 0, 8 * day, "异步任务拆分方案已通过。"),
  conversation("cid-random", "老同事群", false, 0, 9 * day, "周末有人一起爬山吗？", true),
];

export { now as fixtureNow };

const senderNames = ["吴菁", "李端", "陈默", "周舟", "我"];

function textFor(index: number): string {
  const samples = [
    "今晚的发布窗口是 20:00，分支已经冻结，请大家不要直接推 main。",
    "预算表第二版改完了，主要是把差旅和外包拆开，方便后面按季度看。",
    "我刚看了新版工作台，消息列表的密度比之前舒服很多。",
    "客户那边希望明天上午能看到演示环境，我们今晚先把数据准备好。",
    "这个接口的返回体里多了一个 errorCode，前端记得做兜底。",
    "收到，我先把日志收上来，半小时后同步结论。",
    "下周的评审我约了会议室，周三下午两点到三点半。",
    "设计稿更新到第三版了，空状态和加载状态都补上了。",
    "这版先按最简方案上线，后续再把跨机能力补齐。",
    "麻烦确认一下这个字段的口径，是自然周还是滚动七天？",
  ];
  return samples[index % samples.length] ?? samples[0]!;
}

function longText(index: number): string {
  return [
    `第 ${index} 条预算说明：`,
    "第一阶段只做工作台内的展示和搜索，不改变现有的会话路由；",
    "第二阶段再接跨机器和权限；第三阶段才考虑把消息写回钉钉。",
    "这样每一段都能单独验收，也不会把风险堆到最后。",
  ].join("");
}

function searchHit(conversation: string, index: number): string {
  const variants = [
    `${conversation}：预算表第 ${index} 版已发你，差旅和外包拆开列了。`,
    `${conversation}：我刚核对完预算，渠道费用还差 3 万，晚点补在备注里。`,
    `${conversation}：预算审批单编号 ${4800 + index}，麻烦今天走完流程。`,
    `${conversation}：Q4 预算里市场活动占大头，建议先砍掉重复投放。`,
    `${conversation}：财务说预算口径按自然季度，不要用滚动十二个月。`,
    `${conversation}：这份预算给客户看之前，先把毛利那列隐藏。`,
    `${conversation}：预算超支的部分我先记在风险清单，周五会上过。`,
  ];
  return variants[index % variants.length] ?? variants[0]!;
}

function buildLongConversation(): DingTalkMessage[] {
  const messages: DingTalkMessage[] = [];
  for (let index = 0; index < 200; index += 1) {
    const mine = index % 4 === 0;
    const unsupported = index === 47 || index === 133;
    // Keep a visible day boundary and a same-sender cluster inside the newest page.
    const recent = index >= 190;
    const createdAt = recent
      ? now - (199 - index) * 2 * minute
      : now - (199 - index) * 50 * minute - 30 * hour;
    const senderIndex = index >= 190 && index <= 194 ? 0 : index % 3;
    messages.push({
      messageId: `msg-launch-${String(index).padStart(3, "0")}`,
      conversationId: "cid-launch",
      senderName: mine ? "我" : (senderNames[senderIndex] ?? "吴菁"),
      senderId: mine ? "me" : `user-${senderIndex}`,
      createdAt,
      text: unsupported
        ? index === 47
          ? "季度预算审批单"
          : "发布检查清单"
        : index % 23 === 0
          ? longText(index)
          : textFor(index),
      unsupported,
      mine,
    });
  }
  const missingImage = messages[193];
  if (missingImage) {
    missingImage.text = "";
    missingImage.resources = [
      {
        kind: "image",
        resourceId: "media-preview-missing",
        resourceIdType: "mediaId",
      },
    ];
  }
  const richQuote = messages[195];
  if (richQuote) {
    richQuote.quotedMessage = {
      senderName: "李端",
      text: "预算表第二版已经发到群里，差旅和外包分开列了。",
      messageId: "msg-launch-quote",
      createdAt: richQuote.createdAt - 4 * minute,
    };
    richQuote.reactions = [
      { emoji: "OK", count: 3 },
      { emoji: "收到", count: 1 },
    ];
  }
  const card = messages[196];
  if (card) {
    card.bot = true;
    card.cardTitle = "【云监控】发布检查";
    card.format = "markdown";
    card.text =
      ">- 服务: saas\n>- 环境: production\n>- 结论: 检查通过，可以继续发布\n\n[查看详情](https://example.com/detail)";
    card.resources = [
      {
        kind: "image",
        resourceId: "media-preview-card",
        resourceIdType: "mediaId",
      },
    ];
  }
  const image = messages[197];
  if (image) {
    image.text = "";
    image.resources = [
      {
        kind: "image",
        resourceId: "media-preview-image",
        resourceIdType: "mediaId",
      },
    ];
  }
  const file = messages[198];
  if (file) {
    file.text = "";
    file.resources = [
      {
        kind: "file",
        name: "发布检查清单.xlsx",
        sizeBytes: 24_576,
        resourceId: "file-preview-checklist",
        resourceIdType: "fileId",
      },
    ];
  }
  const bot = messages[199];
  if (bot) {
    bot.bot = true;
    bot.senderName = "发布机器人";
    bot.format = "markdown";
    bot.text =
      "**发布窗口提醒**\n\n今晚 20:00 冻结分支，请各端在 19:30 前完成自测。\n\n- 后端：确认灰度开关\n- 前端：确认静态资源版本";
  }
  return messages;
}

function buildConversationMessages(conversation: DingTalkConversation, count: number) {
  const messages: DingTalkMessage[] = [];
  const base = conversation.lastMessageAt ?? now;
  for (let index = 0; index < count; index += 1) {
    const mine = index % 5 === 0;
    const createdAt = base - (count - 1 - index) * 18 * minute;
    messages.push({
      messageId: `${conversation.conversationId}-msg-${index}`,
      conversationId: conversation.conversationId,
      senderName: mine ? "我" : (senderNames[index % 4] ?? "吴菁"),
      senderId: mine ? "me" : `user-${index % 4}`,
      createdAt,
      text:
        index === count - 1
          ? (conversation.preview ?? textFor(index))
          : index % 7 === 0
            ? searchHit(conversation.title, index)
            : index % 11 === 0
              ? longText(index)
              : textFor(index + conversation.title.length),
      unsupported: index === Math.floor(count / 2) && !conversation.singleChat,
      mine,
    });
  }
  return messages;
}

const messageCache = new Map<string, DingTalkMessage[]>();

export function messagesFor(conversationId: string): DingTalkMessage[] {
  const cached = messageCache.get(conversationId);
  if (cached) return cached;
  const found = conversations.find((row) => row.conversationId === conversationId);
  const messages =
    conversationId === "cid-launch"
      ? buildLongConversation()
      : buildConversationMessages(found ?? conversations[0]!, 40);
  const sorted = [...messages].sort((left, right) => left.createdAt - right.createdAt);
  messageCache.set(conversationId, sorted);
  return sorted;
}

export const agents: CodexAgentRecord[] = [
  {
    fileName: "reviewer.toml",
    name: "reviewer",
    description: "审查代码改动，关注并发、边界条件和回归风险。",
    model: "gpt-5.1-codex",
    reasoningEffort: "high",
    revision: "1760000000000-512",
    developerInstructions:
      "You review code changes for correctness and regressions.\nReport findings with file paths and evidence.",
  },
  {
    fileName: "writer.toml",
    name: "writer",
    description: "把讨论整理成结构清晰的中文文档和周报。",
    model: "gpt-5.1",
    reasoningEffort: "medium",
    revision: "1760000001000-380",
    lastDispatchedAt: now - 2 * 60 * 60 * 1000,
    developerInstructions: "Write concise Chinese documents with clear headings.",
  },
  {
    fileName: "researcher.toml",
    name: "researcher",
    description: "调研外部资料，给出带来源的结论和取舍建议。",
    model: null,
    reasoningEffort: null,
    revision: "1760000002000-421",
    developerInstructions: "Research the question and cite the sources you actually read.",
  },
  {
    fileName: "ops-runner.toml",
    name: "发布与线上问题处理助手（华东区，夜间值守）",
    description:
      "接手发布检查、日志核对和线上问题复现；会先收集证据、标明影响范围，再给出可回滚的处理建议，避免在没有确认的情况下执行破坏性操作。",
    model: null,
    reasoningEffort: null,
    revision: "1760000003000-640",
    developerInstructions:
      "Operate release checks and incident triage. Gather evidence before proposing any destructive action.",
  },
];

export const agentSummaries: CodexAgentSummary[] = agents.map(
  ({ developerInstructions: _instructions, ...summary }) => summary,
);

export const agentCatalog: CodexAgentCatalogResult = {
  available: true,
  defaultModel: "gpt-5.1-codex",
  models: [
    {
      model: "gpt-5.1-codex",
      displayName: "GPT-5.1 Codex",
      isDefault: true,
      efforts: [
        { id: "low", description: "更快，适合小改动" },
        { id: "medium", description: "默认强度" },
        { id: "high", description: "更深入，适合复杂改动" },
      ],
    },
    {
      model: "gpt-5.1",
      displayName: "GPT-5.1",
      isDefault: false,
      efforts: [
        { id: "low", description: "更快" },
        { id: "medium", description: "默认强度" },
        { id: "high", description: "更深入" },
      ],
    },
    {
      model: "gpt-5.1-mini",
      displayName: "GPT-5.1 mini",
      isDefault: false,
      efforts: [{ id: "medium", description: "默认强度" }],
    },
  ],
};

export const dispatchSettings: DingTalkDispatchSettings = {
  threshold: 0.85,
  agents: {
    "reviewer.toml": {
      enabled: true,
      eventTypes: ["mention_me", "mention_all"],
      replyScope: "group",
    },
    "writer.toml": {
      enabled: true,
      eventTypes: ["mention_me", "approval_pending"],
      replyScope: "direct",
    },
  },
};

export const projectGroupView: ProjectGroupView = {
  group: {
    id: "6f3a8e0a-5cf7-4f0e-9a3f-0f4d3a9c1b22",
    name: "codex-host",
    order: 0,
    collapsed: false,
    members: [
      {
        projectKind: "local",
        projectId: "project-local",
        rootPaths: ["/home/ubuntu/Documents/ChatGPT/codex-host"],
        label: "codex-host",
      },
      {
        projectKind: "remote",
        projectId: "project-tencent",
        hostId: "host-tencent",
        remotePath: "/home/tencent/Documents/ChatGPT/codex-host",
        label: "codex-host",
      },
    ],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
  },
  projects: [],
  machines: [
    {
      key: "local",
      label: "本机",
      state: "connected",
      projects: [
        {
          project: {
            member: {
              projectKind: "local",
              projectId: "project-local",
              rootPaths: ["/home/ubuntu/Documents/ChatGPT/codex-host"],
              label: "codex-host",
            },
            entry: {
              projectId: "project-local",
              kind: "local",
              label: "codex-host",
              hostId: null,
              hostLabel: null,
              rootPaths: ["/home/ubuntu/Documents/ChatGPT/codex-host"],
              remotePath: null,
              native: null,
            },
            missing: null,
          },
          mounted: true,
          newChatAvailable: true,
        },
        {
          project: {
            member: {
              projectKind: "local",
              projectId: "project-local-gate",
              rootPaths: ["/home/ubuntu/Documents/ChatGPT/gate-a"],
              label: "gate-a",
            },
            entry: {
              projectId: "project-local-gate",
              kind: "local",
              label: "gate-a",
              hostId: null,
              hostLabel: null,
              rootPaths: ["/home/ubuntu/Documents/ChatGPT/gate-a"],
              remotePath: null,
              native: null,
            },
            missing: null,
          },
          mounted: true,
          newChatAvailable: true,
        },
      ],
    },
    {
      key: "host-tencent",
      label: "tencent",
      state: "connected",
      projects: [
        {
          project: {
            member: {
              projectKind: "remote",
              projectId: "project-tencent",
              hostId: "host-tencent",
              remotePath: "/home/tencent/Documents/ChatGPT/codex-host",
              label: "codex-host",
            },
            entry: {
              projectId: "project-tencent",
              kind: "remote",
              label: "codex-host",
              hostId: "host-tencent",
              hostLabel: null,
              rootPaths: [],
              remotePath: "/home/tencent/Documents/ChatGPT/codex-host",
              native: null,
            },
            missing: null,
          },
          mounted: true,
          newChatAvailable: true,
        },
      ],
    },
  ],
  unresolved: [],
};

export const addMachineTargets: ProjectGroupAddMachineTarget[] = [
  {
    hostId: "host-build",
    machineLabel: "build-01",
    state: "ready",
    harnessId: "codex",
    harnessLabel: "Codex",
  },
  {
    hostId: "host-mac",
    machineLabel: "Mac mini",
    state: "offline",
    harnessId: "claude",
    harnessLabel: "Claude Code",
  },
];

/** A group outside the unread list, returned only by `chat search`. */
export const remoteSearchGroups: DingTalkConversation[] = [
  {
    conversationId: "cid-guansprint",
    title: "【示例Sprint】 进度",
    singleChat: false,
    unreadCount: 0,
    lastMessageAt: now - 2 * day,
    muted: false,
    groupType: "INTERNAL_GROUP",
    memberCount: 15,
  },
  {
    conversationId: "cid-guansprint-2",
    title: "【示例Sprint】示例买",
    singleChat: false,
    unreadCount: 0,
    lastMessageAt: now - 3 * day,
    muted: false,
    groupType: "INTERNAL_GROUP",
    memberCount: 18,
  },
  {
    conversationId: "cid-guansprint-3",
    title: "示例Sprint 联调群",
    singleChat: false,
    unreadCount: 0,
    lastMessageAt: now - 4 * day,
    muted: false,
    groupType: "INTERNAL_GROUP",
    memberCount: 12,
  },
  {
    conversationId: "cid-guansprint-4",
    title: "示例Sprint 数据核对",
    singleChat: false,
    unreadCount: 0,
    lastMessageAt: now - 5 * day,
    muted: false,
    groupType: "INTERNAL_GROUP",
    memberCount: 8,
  },
];

export const remoteSearchPeople = [
  {
    name: "吴菁",
    title: "产品经理",
    userId: "user-wujing",
    openDingTalkId: "open-wujing",
    conversationId: "cid-wujing",
  },
];

/** 320×200 synthetic gradient used as the fake image download result. */
export const previewImageDataUrl =
  "data:image/png;base64,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";
