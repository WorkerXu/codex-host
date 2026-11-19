# 对话切换 Agent

已有对话可以改由同一台 Host 上的另一个 Agent 继续：Codex 与任一已安装的外部 Harness 之间，或两个外部 Harness 之间。只在 Desktop 端发起，不跨机器；手机等 Remote Control 客户端不能发起切换，但能看到切到 Codex 之后的对话。

## 入口与交互

- Composer 右下角的 Agent 按钮在已有对话里也可以打开（Host 能确认对话归属，且该 Host 支持切换时）。菜单只列这台 Host 上状态为 `ready` 的 Agent，不显示「其他机器」分组。
- 选 **Codex**：按钮上方出现提示「切换到 Codex 继续」，确认后立即切换并打开新对话，不需要先发消息；手机上的 Codex 随即能看到这段对话。
- 选 **外部 Harness**：提示「下一条消息交给 X」，用户发出下一条消息时才切换（外部 Thread 只有在第一轮之后才会出现在 Desktop）；「取消切换」撤销。待切换状态只保存在当前窗口，刷新即丢弃。
- 切换成功后打开新对话，原对话归档，可在归档里找回。失败时提示显示原因，原对话不变；外部目标的待切换状态保留，可重试或取消。
- 正在运行的对话不能切换。

## Host 流程

固定 RPC `codexhost/thread/agent/switch`（`packages/shared-contracts/src/thread-agent-switch.ts`）：`{ threadId, agent, input? }` → `{ threadId }`。实现位于 `packages/host-runtime/src/thread-agent-switch-runner.ts`，交接内容的构造和存储位于 `thread-agent-switch.ts`。

1. **读取来源**：外部 Thread 用 Host 的历史投影（包含它此前切换带来的快照），原生 Codex Thread 用 `thread/turns/list` 分页读取（`itemsView: "full"`）。只取用户和 Agent 的文本，不带工具调用、推理和命令输出。
2. **目标为 Codex**：
   - 把历史写成 Claude Code 会话文件 `$HOME/.claude/projects/codexhost-handoff/<uuid>.jsonl`。Codex 的外部会话导入只接受这个 `projects` 目录下的 `.jsonl`，并且固定读 `$HOME/.claude`，不看 `CLAUDE_CONFIG_DIR`。
   - 调用官方 `externalAgentConfig/import`，在 `externalAgentConfig/import/progress` 中按文件路径取得新 Thread ID，60 秒超时。
   - 设置原项目（`thread/metadata/update`），并向 Desktop 补发 `thread/started`，因为导入本身不发这个通知。
   - 删除临时文件。导入的回合由 Codex 原生显示，ID 为 `external-import-turn-N`。
3. **目标为外部 Harness**：
   - 按委派的流程新建 Thread：同 cwd、同标题、同项目，使用该 Harness 的默认 Model。
   - 把历史快照存到 `<数据目录>/thread-handoffs/<threadId>.json`。
   - 第一轮发给 Harness 的文本是历史块加用户原文；Desktop 显示的仍是用户原文。
4. **归档来源**。归档失败不影响切换，原对话保留可见。

## 显示

- 外部 Thread 的历史由快照回合加上它自己的原生历史组成。快照回合只读，没有 Checkpoint，不能从它们分叉或编辑。
- 首条用户消息里的历史块在历史投影和侧栏预览中隐藏。

## 历史块

- 格式为 `<codexhost_handoff from="<agent>" thread="<id>" messages="N" omitted="M">…</codexhost_handoff>`，属性值不含引号和尖括号。
- 预算 64 KiB（约 16k token），保留最近的消息。单条消息超出预算时只保留结尾；用户的新请求从不截断。
- 历史中出现的同名标签转义为 `&lt;`，不会提前闭合外层块。

## MemHub 去重

交接内容是已从原 Agent 导入过的副本。MemHub（fork 分支 `feat/codexhost-handoff-dedupe`，India `1.0.6-b49p3`）跳过以下三类：

- Codex rollout 开头的 `external-import-turn-*` 回合区段；
- 各来源用户消息开头的 `<codexhost_handoff>` 块；
- Claude Code 的 `projects/codexhost-handoff/` 目录。

## 限制

- 外部目标使用该 Harness 的默认 Model、Thinking 和权限模式；切换后可在新对话里修改。
- 第一条消息按外部输入规则转换：图片以路径引用，无法转换的输入项会被拒绝。
- 切到 Codex 时不带消息；切到外部 Harness 时必须带消息。
- Codex 导入的回合，记录时间是导入时间（原始时间保留在 `task_started.started_at`），这是 Codex 的行为。
