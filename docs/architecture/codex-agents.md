# Codex 智能体与钉钉分发设置

工作台「智能体」页管理本机 Codex 的自定义 Agent 文件，并保存钉钉监听与分发所需的选择。两者都只作用于 Desktop 所在机器的本地 Host（`hostId: "local"`）。

## Codex 智能体文件

Codex 从 `$CODEX_HOME/agents/<file>.toml` 读取个人自定义智能体；`CODEX_HOME` 未设置时使用 `~/.codex`。每个文件定义一个智能体，`name` 是 Codex 识别智能体的依据，文件名只用于存放。

按官方文档，必填字段：

- `name`：Codex 生成或引用智能体时使用的标识。
- `description`：面向人的使用说明。
- `developer_instructions`：智能体的核心指令。

本页同时编辑 `model` 和 `model_reasoning_effort`。文件中的其他设置（例如 `model_reasoning_summary`、`model_verbosity`、`features.*`、`skills.*`）不是本页的表单字段，保存时原样保留。保存会重新序列化整个 TOML，因此手工注释和键顺序不会保留；需要保留注释时请直接编辑文件。

Codex 只要求 `name` 非空；本页为了名称可被提示词、文件名等界面可靠引用，限制为 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`。新建文件以 `<name>.toml` 命名，编辑已有智能体时文件名保持不变，即使 `name` 被修改。

## Host RPC

契约位于 `packages/shared-contracts/src/codex-agents.ts`，保持浏览器安全：

| 方法 | 作用 |
| --- | --- |
| `codexhost/codex-agents/list` | 返回目录、智能体摘要和无法解析的文件 |
| `codexhost/codex-agents/read` | 读取一个智能体及当前 revision |
| `codexhost/codex-agents/save` | 新建或更新；新建时 `fileName` 为 `null` |
| `codexhost/codex-agents/delete` | 删除，必须带上读取时的 revision |
| `codexhost/codex-agents/catalog` | 投影官方 `model/list` 的模型与推理强度 |

`list` 不因单个坏文件失败：无法解析或缺少必填字段的文件进入 `issues`，页面以「已跳过的文件」显示。符号链接和目录不会被当作智能体文件。

保存流程在 `packages/host-runtime/src/codex-agents.ts`：

1. 校验名称、必填字段、模型与强度为单行且有长度上限。
2. `save` 读取现有 TOML（`smol-toml`），比较调用方携带的 revision（`mtimeMs` + 文件大小）。不一致返回 `revision_conflict`，不覆盖并发修改。
3. 只改写 `name`、`description`、`developer_instructions`、`model`、`model_reasoning_effort`；后两者为空时删除对应键。其余键和嵌套表原样序列化。
4. 同目录临时文件写入后 `rename` 原子替换；新文件权限 0600，已有文件保留原权限。目录按 0700 准备。

文件名必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.toml$`、不得包含 `..`；解析后的路径必须直接位于智能体目录内，且目标必须是常规文件。任何越界或符号链接路径返回 `invalid_file_name`。

## 模型与推理强度

`catalog` 复用 Host 已有的官方 `model/list` 请求，把每个模型的 `supportedReasoningEfforts` 投影成表单选项。官方连接不可用时返回 `available: false`，页面允许直接输入模型 ID 和推理强度，不阻塞编辑。选择已知模型时，推理强度只提供该模型支持的值；空值表示跟随父会话。

## 工作台页面

`packages/renderer-extension/src/settings/codex-agents-page.ts` 注册 `codex-agents` 页，位于 Jarvis 与「通用」之间：

- 列表显示名称、文件名、描述、模型和推理强度，支持刷新。
- 新建、编辑、复制、删除；删除前使用确认对话框，并校验 revision。
- 表单包含名称、描述、模型、推理强度和开发者指令。描述提示说明它也会用于钉钉任务匹配。
- revision 冲突提示刷新后重试；名称冲突、文件不存在等错误显示为中文文案。
- 外部修改导致 404 或冲突时，页面刷新列表但仍保留当前编辑内容。

表单的纯逻辑（名称校验、复制命名、模型可用强度、保存参数）在 `settings/codex-agents-form.ts`，不依赖 DOM，便于单测。

## 钉钉分发设置

契约位于 `packages/shared-contracts/src/dingtalk-dispatch.ts`，Host 持久化在 `~/.codexhost/dingtalk-dispatch.json`（0600，原子写入）。页面通过 `codexhost/dingtalk-dispatch/get|set` 读写；本分支只实现设置，不包含监听或派发运行时。

设置字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 关闭时监听服务不处理事件 |
| `eventTypes` | `mention_me`、`mention_all`、`approval_pending` | 可扩展的事件类型 |
| `matchThreshold` | `0.85` | 0–1；达到阈值的每个智能体都会收到任务（多路分发） |
| `replyScope` | `group` | `group` 群内回复，`direct` 私聊回复 |
| `participatingAgents` | 所有填写了描述的智能体 | 显式保存的参与名单 |

文件不存在或无法解析时返回默认值，并用当前智能体列表填充 `participatingAgents`。用户保存后以显式名单为准；新建但未勾选的智能体不会自动加入。

审批规则：钉钉的「待我审批」事件可以派发给智能体，智能体按该智能体配置里的 `developer_instructions` 处理审批相关的工作（核对、准备材料、给出结论等），但**绝不直接改变审批状态**：不调用 approve、reject、revoke 或任何等价命令。同意或拒绝始终由用户本人操作。页面固定说明为：

> 审批：智能体按你的配置处理，但不会直接同意、拒绝或撤销审批，审批状态由你决定

该约束同时写在 schema 注释和本节，监听/派发运行时（`feat/dingtalk`）读取同一设置文件时必须遵守。

## 边界

- `shared-contracts` 只定义方法名、schema 和默认值，保持浏览器安全。
- `host-runtime` 拥有文件系统读写、权限、revision 校验和官方 `model/list` 投影。
- `renderer-extension` 只做 DOM、表单与错误文案，不读取文件系统。
- 远程 Host 不提供这两组 RPC：它们只在本机 Desktop Host 注册。
- 钉钉监听、消息匹配和派发由单独分支实现，不在此处引入运行时依赖。

## 验证

- `packages/host-runtime/test/codex-agents.test.ts`：TOML 往返保留未知键、原子写入、0600、revision 冲突、路径穿越/符号链接、坏文件报告。
- `packages/host-runtime/test/app-server-host.codex-agents.test.ts`：RPC 创建、读取、删除、钉钉设置读写和错误码。
- `packages/host-runtime/test/dingtalk-dispatch-settings.test.ts`、`packages/shared-contracts/test/dingtalk-dispatch.test.ts`：默认值和 schema 边界。
- `packages/renderer-extension/test/settings/codex-agents-form.test.ts`：表单校验、复制命名、强度选项和审批固定文案。
