# Codex 智能体与钉钉分发设置

工作台「智能体」页管理本机 Codex 的自定义 Agent 文件，并保存钉钉监听与分发所需的选择。两者都只作用于 Desktop 所在机器的本地 Host（`hostId: "local"`）。

## Codex 智能体文件

Codex 从 `$CODEX_HOME/agents/<file>.toml` 读取个人自定义智能体；`CODEX_HOME` 未设置时使用 `~/.codex`。每个文件定义一个智能体，`name` 是 Codex 识别智能体的依据，文件名只用于存放。

按官方文档，必填字段：

- `name`：Codex 生成或引用智能体时使用的标识。
- `description`：面向人的使用说明。
- `developer_instructions`：智能体的核心指令。

本页同时编辑 `model` 和 `model_reasoning_effort`。文件中的其他设置（例如 `model_reasoning_summary`、`model_verbosity`、`features.*`、`skills.*`）不是本页的表单字段，保存时原样保留。保存会重新序列化整个 TOML，因此手工注释和键顺序不会保留；需要保留注释时请直接编辑文件。

`name` 只要求去掉首尾空格后非空、且不包含换行；中文、空格和任意字符都允许，不限长度，也不要求与其他智能体重名。文件名与名称无关：新建时自动生成 `agent-<12 位小写十六进制>.toml`，已存在时重试；编辑已有智能体保持原文件名；复制同样生成新的随机文件名。

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

1. 校验名称非空且为单行，描述/指令必填并有长度上限；名称不需要唯一。新建时生成未被占用的文件名，名称不参与路径。
2. `save` 读取现有 TOML（`smol-toml`），比较调用方携带的 revision（`mtimeMs` + 文件大小）。不一致返回 `revision_conflict`，不覆盖并发修改。
3. 只改写 `name`、`description`、`developer_instructions`、`model`、`model_reasoning_effort`；后两者为空时删除对应键。其余键和嵌套表原样序列化。
4. 同目录临时文件写入后 `rename` 原子替换；新文件权限 0600，已有文件保留原权限。目录按 0700 准备。

文件名必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.toml$`、不得包含 `..`；解析后的路径必须直接位于智能体目录内，且目标必须是常规文件。任何越界或符号链接路径返回 `invalid_file_name`。

## 模型与推理强度

`catalog` 复用 Host 已有的官方 `model/list` 请求，把每个模型的 `supportedReasoningEfforts` 投影成表单选项。官方连接不可用时返回 `available: false`，页面允许直接输入模型 ID 和推理强度，不阻塞编辑。选择已知模型时，推理强度只提供该模型支持的值；空值表示跟随父会话。

## 工作台页面

`packages/renderer-extension/src/settings/codex-agents-page.ts` 注册 `codex-agents` 页，位于 Jarvis 与「通用」之间：

- 智能体以自适应卡片网格展示：最小列宽 240px、间距 16px、圆角 12、`main-surface-primary` 背景和 `border-default` 描边；悬停轻微抬升，编辑中的卡片使用强调色描边。
- 每张卡片自上而下是 48px 程序化 SVG 头像、名称（`text-md` 600，单行省略、悬停显示全名）、最多两行的描述（`text-sm` secondary）和底部小标签。页头只有标题「智能体」，没有副标题。标签包括「模型 · 中文推理强度」、参与钉钉派发时的「参与钉钉」，以及存在数据时的「最近派发 · 相对时间」。每张卡片和编辑抽屉另显示最近钉钉派发的时间、结果和跳过/失败原因，每 10 秒刷新。
- 头像由同一套几何底形（圆角方 / 圆 / 胶囊）、5–6 个柔和底色、一个稳定小配件（天线 / 帽子 / 耳朵 / 眉毛）和一双眼睛组成，不使用文字缩写或 emoji。底形、颜色、配件都按智能体名称稳定选择。
- 状态放进头像，不额外画状态圆点：当前参与钉钉派发且监听已开启的智能体显示「醒着」，其余显示闭眼休息。头像按参与设置显示醒着或休息，不投影正在执行的 Turn；动作只在卡片悬停时显示，执行结果由最近派发状态行展示。
- 卡片整体点击打开右侧编辑抽屉；右上角悬停显示 ⋯ 按钮，点击后在按钮下方弹出原生样式菜单（编辑 / 复制 / 删除，行高 32、删除用危险色）。菜单可用方向键、Home/End 导航，点击外部、按 Esc、滚动页面或调整窗口大小时关闭；菜单打开期间卡片的悬停操作区保持可见。
- 删除使用页面内 `<dialog>` 确认，不用 `window.confirm`：确认后按 revision 删除文件，刷新卡片与钉钉参与状态；`revision_conflict` / `not_found` 会刷新列表并保留错误提示。删除一个智能体同时移除它的钉钉监听设置。
- 网格最后一格是虚线描边的「＋ 新建智能体」卡片；页头不再放新建按钮。没有智能体时只显示这张新建卡片和一句「还没有智能体，新建一个让它帮你处理任务」。
- 卡片网格下方只保留「钉钉监听」全局分组：匹配阈值（0.85）与审批说明。开关、处理类型、回复位置和参与名单都在智能体编辑抽屉的「钉钉」分组里，每个智能体单独设置。
- 表单包含名称、描述、模型、推理强度和开发者指令，最后是「钉钉」分组：启用钉钉监听（默认关）、处理类型（@我 / @所有人 / 待我审批 / 私聊消息，默认全选）和回复位置（群内 / 私聊，默认群内）。保存智能体后一并写入该 `fileName` 的钉钉设置。描述提示说明它也会用于钉钉消息匹配。名称、描述、模型、推理强度和指令的错误分别显示在对应字段下方，只有无法归属字段的失败才显示在表单底部。
- 用户文案只描述能做什么，不出现 Host、CLI、Thread、SSH、RPC、回调、置信度等实现词；每个区块最多一行辅助说明。
- revision 冲突提示刷新后重试；文件不存在、名称无效等错误显示为中文文案。
- 外部修改导致 404 或冲突时，页面刷新列表但仍保留当前编辑内容。

头像生成与神态在 `settings/codex-agent-avatar.ts`；表单的纯逻辑（名称校验、复制、模型可用强度、保存参数）在 `settings/codex-agents-form.ts`，不依赖 DOM，便于单测。

## 钉钉分发设置

契约位于 `packages/shared-contracts/src/dingtalk-dispatch.ts`，Host 持久化在 `~/.codexhost/dingtalk-dispatch.json`（0600，原子写入）。页面通过 `codexhost/dingtalk-dispatch/get|set` 读写设置，`status` 读取最近派发结果。监听、Gemini 匹配、原生对话和卡片回复见 [钉钉工作台](dingtalk.md#智能体监听与派发)。

设置字段：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `threshold` | `0.85` | 0–1；达到阈值的每个启用智能体都会收到任务（多路分发） |
| `agents` | `{}` | 以智能体 `fileName` 为键；缺省表示不监听 |

每个 `agents[fileName]` 保存：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 该智能体是否处理钉钉消息 |
| `eventTypes` | 四种全部 | `mention_me`、`mention_all`、`approval_pending`、`direct_message`；旧配置保留原选择 |
| `replyScope` | `group` | `group` 群内回复，`direct` 私聊回复 |

键使用 `fileName` 而不是名称，重命名智能体时设置自动跟随。Host 在读取时按当前智能体列表裁剪不存在的文件，避免删除后新建同名文件继承旧设置；智能体列表读取失败时保留全部条目。

旧的全局文件（`enabled` / `eventTypes` / `matchThreshold` / `replyScope` / `participatingAgents`）只迁移一次：旧开关为开时，旧参与名单里的智能体（名单为空则所有填写了描述的智能体）各得到 `enabled: true` 和旧的类型、回复位置；随后写回新结构。旧开关为关时所有智能体保持关闭，只保留阈值。

派发运行时读取设置时必须按事件类型过滤 `agents`（`dingtalkDispatchTargets`），并对每个目标使用它自己的 `replyScope`，不能再读取全局开关、全局类型或全局回复位置。

审批规则：钉钉的「待我审批」事件可以派发给智能体，智能体按该智能体配置里的 `developer_instructions` 处理审批相关的工作（核对、准备材料、给出结论等），但**绝不直接改变审批状态**：不调用 approve、reject、revoke 或任何等价命令。同意或拒绝始终由用户本人操作。页面固定说明为：

> 审批由你决定：智能体可以整理材料，但不会替你同意、拒绝或撤销审批

审批汇总运行在禁用执行和连接器工具的原生只读对话中，运行时只能构造 OA 查询命令。

## 边界

- `shared-contracts` 只定义方法名、schema 和默认值，保持浏览器安全。
- `host-runtime` 拥有文件系统读写、权限、revision 校验和官方 `model/list` 投影。
- `renderer-extension` 只做 DOM、表单与错误文案，不读取文件系统。
- 远程 Host 不提供这两组 RPC：它们只在本机 Desktop Host 注册。
- Host Runtime 负责监听、消息匹配和派发；页面只读取设置和派发状态。

## 验证

- `packages/host-runtime/test/codex-agents.test.ts`：TOML 往返保留未知键、原子写入、0600、revision 冲突、路径穿越/符号链接、坏文件报告。
- `packages/host-runtime/test/app-server-host.codex-agents.test.ts`：RPC 创建、读取、删除、钉钉设置读写和错误码；删除智能体后它的钉钉条目随读取被裁剪。
- `packages/host-runtime/test/dingtalk-dispatch-settings.test.ts`：新结构读写、旧全局设置迁移、列表为空时迁移所有有描述的智能体、旧开关关闭、裁剪已删除智能体、列表不可读时保留条目。
- `packages/shared-contracts/test/dingtalk-dispatch.test.ts`：默认值、schema 边界和按事件类型过滤的每智能体派发目标。
- `packages/renderer-extension/test/settings/codex-agents-form.test.ts`：表单校验、复制命名、强度选项、每智能体钉钉草稿合并和审批固定文案。
- `packages/renderer-extension/test/settings/agent-card-menu.test.ts`、`agent-delete.test.ts`：菜单定位/键盘导航、删除调用 revision 与刷新行为。
