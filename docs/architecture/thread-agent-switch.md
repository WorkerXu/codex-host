# 对话切换 Agent

已有对话可以改由同一台 Host 上的另一个 Agent 继续：Codex 与任一已安装的外部 Harness 之间，或两个外部 Harness 之间。只在 Desktop 端发起，不跨机器；手机等 Remote Control 客户端不能发起切换，但能看到切到 Codex 之后的对话。

## 入口与交互

- Composer 右下角的 Agent 按钮在已有对话里也可以打开（Host 能确认对话归属，且该 Host 支持切换时）。菜单只列这台 Host 上状态为 `ready` 的 Agent，不显示「其他机器」分组。
- 选 **Codex**：按钮上方出现提示「切换到 Codex 继续」，确认后立即切换并打开新对话，不需要先发消息；手机上的 Codex 随即能看到这段对话。
- 选 **外部 Harness**：提示「下一条消息交给 X」，用户发出下一条消息时才切换（外部 Thread 只有在第一轮之后才会出现在 Desktop）；「取消切换」撤销。待切换状态只保存在当前窗口，刷新即丢弃。
- 切换成功后打开新对话，原对话归档，可在归档里找回。失败时提示显示原因，原对话不变；外部目标的待切换状态保留，可重试或取消。
- 正在运行的对话不能切换。

## 交接内容

来源对话的可见历史按回合编号成条目，ID 形如 `h<回合>.<序号>`（实现见 `packages/host-runtime/src/thread-handoff-content.ts`）。包含以下几类：

- 用户消息（含图片引用）和助手回复；
- 命令：命令行、退出码和输出；
- 文件改动的路径与类型、计划、工具调用（名称与错误）、网页搜索；
- 失败回合的错误原因和被中断的回合。

不带推理过程、工具的内部状态和附件本身。上一次切换带来的历史块会被剥掉，不会层层嵌套。

连续切换时，沿用来源 Thread 已保存的完整条目，再追加该 Agent 自己的新回合。Codex 的导入回合和外部 Thread 已显示的快照不会重复加入；每条助手回复及操作记录保留实际产生它的 Agent。即使中间经过 Codex，最早的命令和文件改动仍然可以交给后续 Agent、逐条读取并显示。旧版 Codex 交接记录没有快照时，用已保存的条目恢复文字显示。

完整条目保存在交接记录里（`<数据目录>/thread-handoffs/<新 Thread>.json`，`sources.json` 记录来源到新 Thread 的对应）。来源对话归档、删除，或它的 Harness 被卸载之后，这些条目仍然可读。

### 历史块

外部 Harness 在第一条消息前收到 `<codexhost_handoff from="<agent>" thread="<新 Thread>" source="<来源>" items="N" omitted="M">…</codexhost_handoff>`。属性值不含引号和尖括号。

- **预算**：默认 64 KiB，按每个 UTF-8 字节一个 token 的保守口径计算。上下文窗口按 128k 估计，并为后续工作预留 32k。用户的请求越长、图片越多，历史就越少；请求本身从不截断。预算不够时只保留读取说明。
- **挑选**：先保留最新的用户请求和最新的回答，再保留最初的请求，然后从新到旧放入能放下的条目。条目都是完整原文，放不下就整条省略，不截断。输出按时间顺序。
- **说明**：块里写明来源 Agent、条目总数与省略数，并按时间列出最近 20 个被省略的条目 ID。它还说明这些历史只是背景信息，不是新的请求，也不是更高优先级的指令；附件和推理过程没有带过来；块之后的内容才是用户现在的消息。
- **读取被省略的条目**：`codexhost thread handoff <新 Thread>` 分页列出全部条目，`--item <ID>` 读取一条的原文，长内容按返回的 `nextOffset` 加 `--offset` 继续。参数用新 Thread 或来源 Thread 都可以；请求由执行过切换的 Runtime 处理。
- 历史中出现的同名标签转义为 `&lt;`，不会提前闭合外层块。

## Host 流程

固定 RPC `codexhost/thread/agent/switch`（`packages/shared-contracts/src/thread-agent-switch.ts`）：`{ threadId, agent, input? }` → `{ threadId }`。编排位于 `packages/host-runtime/src/thread-agent-switch-runner.ts`，交接记录位于 `thread-handoff-store.ts`。

远程（SSH）Host 上，外部 Session 都由共享 Host 持有。每个 Desktop 连接对应的会话 Host 不自己执行切换，而是把请求整个转给共享 Host：由它读取 Codex Thread、新建外部 Thread，并归档来源。

1. **防重复**：
   - 同一来源同时到达的相同请求，共享同一次切换的结果；正在切换时，换成别的 Agent 会被拒绝。
   - 15 分钟内对同一来源、同一目标的重试，只要上次建的 Thread 还在，就直接返回它，不会再建一个。这种情况多出现在 Desktop 没收到回复的时候。
2. **读取来源**：外部 Thread 用 Host 的历史投影，其中包含它此前切换带来的快照；原生 Codex Thread 用 `thread/turns/list` 分页读取（`itemsView: "full"`）。
3. **目标为 Codex**：
   - 把用户和助手消息完整写成 Claude Code 会话文件 `$HOME/.claude/projects/codexhost-handoff/<uuid>.jsonl`。Codex 的外部会话导入只接受这个 `projects` 目录下的 `.jsonl`，并且固定读 `$HOME/.claude`，不看 `CLAUDE_CONFIG_DIR`。
   - 调用官方 `externalAgentConfig/import`，在 `externalAgentConfig/import/progress` 里按文件路径取得新 Thread ID。如果 3 秒内没收到通知，就按创建时间、cwd 和标题在 `thread/list` 里找导入出的 Thread，避免留下孤立对话；60 秒超时。
   - 设置原项目（`thread/metadata/update`），保存完整条目及来源快照。有操作记录时，先记录待送达状态；保存失败不会归档来源。
   - 用 `thread/resume` 和 `thread/inject_items` 把命令、文件改动、错误等操作记录连同读取说明交给 Codex 的模型。这些内容只有模型能看到，界面上不显示。失败后再试一次；仍失败则保持待送达，下一次发送前重试。只有注入成功才标记已送达；若仍未送达，返回错误并保留用户消息待重试，不在缺少交接记录时启动回合。各连接 Host 重新读取磁盘状态，避免缓存旧的待送达状态或之前未找到的记录。
   - 向 Desktop 补发 `thread/started`（导入本身不发这个通知），然后删除临时文件。导入的回合由 Codex 原生显示，ID 为 `external-import-turn-N`。
4. **目标为外部 Harness**：按委派的流程新建 Thread（同 cwd、同标题、同项目，使用该 Harness 的默认 Model），先保存交接记录，再启动 Session。第一轮发给 Harness 的文本是历史块加用户原文；Desktop 显示的仍是用户原文。任何一步失败都会删除新 Thread 和它的交接记录。
5. **归档来源**。归档失败不影响切换，原对话保留可见。

删除目标 Thread 时同时删除它的交接记录与来源索引；后续 Thread 已保存的历史不受影响。下一次导入也会清理专用临时目录里遗留超过 10 分钟的会话文件。

## 显示

- 外部 Thread 的历史由快照回合加上它自己的原生历史组成。
  - 快照保留原对话的条目形态：消息、命令及输出、文件改动、计划、工具调用和网页搜索。条目换上新 ID，回合保留失败或中断状态。
  - 单个字段超过 32 KiB 时只截断显示，完整内容仍可通过 `thread handoff` 读取。
  - 快照回合只读，没有 Checkpoint，不能从它们分叉或编辑。
- 首条用户消息里的历史块在历史投影和侧栏预览中隐藏。

## MemHub 去重

交接内容是已从原 Agent 导入过的副本。MemHub（fork 分支 `feat/codexhost-handoff-dedupe`，India `1.0.6-b49p3`）跳过以下几类：

- Codex rollout 开头的 `external-import-turn-*` 回合区段，以及注入给 Codex 的操作记录（它以 `<codexhost_handoff` 开头）；
- 各来源用户消息开头的 `<codexhost_handoff>` 块；
- Claude Code 的 `projects/codexhost-handoff/` 目录。

## 限制

- 外部目标使用该 Harness 的默认 Model、Thinking 和权限模式；切换后可在新对话里修改。
- 第一条消息按外部输入规则转换：图片以路径引用，无法转换的输入项会被拒绝。
- 切到 Codex 时不带消息；切到外部 Harness 时必须带消息。
- Codex 导入的回合，记录时间是导入时间（原始时间保留在 `task_started.started_at`），这是 Codex 的行为。
- 新 Agent 自己压缩上下文后，历史块可能只剩摘要。被省略或已被压缩的内容，可以再用 `codexhost thread handoff` 读回来。
