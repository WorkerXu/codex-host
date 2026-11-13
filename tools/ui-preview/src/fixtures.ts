import type {
  CodexAgentCatalogResult,
  CodexAgentRecord,
  CodexAgentSummary,
  DingTalkConversation,
  DingTalkDispatchSettings,
  DingTalkMessage,
  DingTalkSettings,
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
): DingTalkConversation {
  return {
    conversationId: id,
    title,
    singleChat,
    unreadCount,
    lastMessageAt: now - age,
    muted,
    preview,
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
  ),
  conversation("cid-finance", "财务打款群", false, 12, 22 * minute, "李端：预算表我改完第二版了。"),
  conversation("cid-wujing", "吴菁", true, 1, 47 * minute, "明天上午的评审还需要你确认一下。"),
  conversation(
    "cid-design",
    "设计评审",
    false,
    28,
    2 * hour,
    "陈默：[图片] 新版工作台视觉稿",
    true,
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

export const dingTalkSettings: DingTalkSettings = {
  defaultHost: null,
  effectiveHost: "本机",
  effectiveHostId: null,
  hosts: [
    { name: "本机", hostId: null, local: true },
    { name: "tencent", hostId: "host-tencent", local: false },
  ],
};

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
  enabled: true,
  eventTypes: ["mention_me", "mention_all"],
  matchThreshold: 0.85,
  replyScope: "group",
  participatingAgents: ["reviewer", "writer"],
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
