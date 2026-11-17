# DingTalk 工作台

Codex Desktop 的「钉钉」入口复用官方 DingTalk Workspace CLI `dws`，把一个 Host 上的钉钉登录变成所有机器可用的工作台和本机智能体监听入口。它和 Jarvis `@` 引用共用同一套做法：Renderer 追加原生菜单行，Host 在提交时展开引用，CLI 与网络访问只发生在 Host。

## 入口与页面

- Composer 的原生 `@` 菜单在查询为空或匹配「钉」（`钉钉` / `dingtalk` 前缀）时，把「钉钉」行追加到与 Jarvis 共用的「工作台」分组：分组位于原生 `[data-mention-list-scroll-area]` 滚动容器内，使用原生 section 结构、header 类名和 `[data-list-navigation-item]` 按钮行，上下键与回车跟随原生 `aria-current` 高亮。原生菜单在 `input` 之后挂载，Renderer 等待约 300 ms 并继续观察 DOM；列表不出现时不绘制任何浮层。
- 选择该行打开工作台（设置页外壳中的 `dingtalk` 页面），并记住打开它的 Composer。页面关闭后，嵌入操作仍回到这个 Composer。
- 页面左侧只有一个未读列表：来自 `chat message list-unread-conversations`，只显示最近 48 小时内仍有未读、且最后一条消息晚于本机已读时间的会话。右侧显示所选会话的消息，并以当前用户身份发送消息。
- 打开会话时，列表行立即去掉未读角标和 @ 提醒，但在页面离开该会话前仍保留在未读列表中；切走后该行按已读状态移除。Host 记录已读时间，页面用 `active` 区分「仍打开」和「已离开」。
- 群聊输入框支持原生 `@` 选择器：`@` 触发，按姓名/职位过滤，方向键移动，回车/点击选择；已选成员显示为 chip，可逐个移除，`@所有人` 作为首项。发送时 chip 生成 `<@openDingTalkId>` / `<@all>` 占位符，并通过 `chat message send --at-open-dingtalk-ids` / `--at-all` 传给 dws。
- 消息中的图片使用缩略图；点击后在覆盖全页的顶层模态遮罩中打开，关闭按钮位于右上角，页面自身的关闭按钮被遮挡且不可交互；支持左右方向键切换同会话图片、Esc 或点击遮罩关闭，关闭时释放 object URL，不保留全尺寸缓存。
- 钉钉页占用工作台内容区全宽；打开时隐藏设置导航，顶部关闭按钮仍可返回。
- 消息按 dws 字段渲染：`quotedMessage` 引用块、`reactions` / `emotionReplyList` 表情计数、`resourceRefs` 图片和文件、`sendType: bot` 机器人标签、Markdown 卡片标题与正文。`<imageContent>`、`mediaId=`、`fileId:` 等原始标记一律不显示。
- 图片由 DingTalk Host 用 `chat +messages-resource-download` 下载，以 data URL 经 RPC 返回；Renderer 只在图片进入可视区时下载并转成 object URL 缩略图（最大 240 px），行离开 DOM、切换会话或关闭页面时立即 revoke。
- Agent 回复中的 `dingtalk://conversation/<cid>` 和 `dingtalk://message/<cid>/<id>` 链接会打开页面并滚动到、短暂高亮对应消息。

## 引用与提交时展开

`shared-contracts` 定义两个 carrier：

- `dingtalk://conversation/<cid>`
- `dingtalk://message/<cid>/<messageId>[,<messageId>...]`

cid 可能包含 `/`、`+`、`=`，因此路径按段 percent-encode；解析时也接受未编码的 cid，并以最后一个 `/` 作为消息分隔符。嵌入时优先插入 Desktop 原生 mention chip，控制器不可用时退化为 Markdown carrier。

`turn/start`、`turn/steer` 和外部 steering 都会经过 Host 的 `dingtalk-mention-rewrite.ts`。会话引用取最近 30 条消息；所选消息取这些消息及其前后各 3 条同会话上下文。输出一段 `[codexhost DingTalk]` 上下文块，包含会话标题、类型、cid、发送人、时间和正文；失败只写一行说明，不阻断 Turn。解析同时接受 Desktop 在标签与 URL 之间换行、或把二者拆成相邻 text item 的形态；`conversationInfo` 与消息列表并行，单聊不额外查询职位。

上下文块同时告诉 Agent：更多记录用 `codexhost dingtalk dws -- <dws 参数>` 读取；发送、撤回、建群等写操作必须先征得用户同意，并在命令中加 `--yes`。审批状态只能由你本人在钉钉里处理，CLI 一律拒绝审批写操作；派发对话中的智能体只能读取，回复由派发器负责。

## 默认 Host 与跨机路由

- 每台 Host 都可以运行 DingTalk 服务，但真正的 `dws` 只在登录了钉钉的那台机器上执行。
- DingTalk Host 固定使用 `peers.json` 里的 `mac` 登录（dws 与钉钉登录在用户的 Mac 上）；没有该 peer 时退回本机，所以 Mac 自身解析为本机。Mac 关机或休眠时钉钉读取、事件和派发都不可用。界面不提供登录机器选择，`~/.config/codexhost/dingtalk-settings.json` 的 `defaultHost` 仍会被读取，供以后手工修改或迁移使用。
- Renderer 每次打开页面先向本机 Host 读取 `status()`，用返回的 `defaultHostId` 找到 Desktop 已有的远端 Host 连接；找到后，`conversations / preview / messages / resource / send / search / resolve / viewed` 都直接发给那台 Host，并只订阅它的 `codexhost/dingtalk/changed`。没有该连接时才退回本机 Host 的 peer-exec 转发。`status` 和设置始终留在本机 Host。
- 工作台不提供「钉钉登录 / 默认机器」下拉。⋯ 菜单只显示一行连接状态：已连接时显示 `已连接 · <userName>（<corpName>）`，未登录显示「钉钉未登录」，DingTalk Host 不可达显示「无法连接钉钉服务」；后两种状态附「重试」。
- 读取请求通过 `peer-exec` 的 `/v1/dingtalk/dws` 路由转发同一组参数数组；对端 Host 执行本机 `dws` 并原样返回 stdout、stderr 与退出码。目标机器上设置自动解析为本机，因此同一份默认值在 Mac 和各服务器上都指向 Mac 的登录。
- 图片下载通过同级的 `/v1/dingtalk/media` 路由在登录机器上执行，只接受会话、消息和资源 id；返回 base64、MIME 和大小。缓存目录按运行时隔离，不读取 `~/.codexhost/runtime/`。
- CLI 透传 `codexhost dingtalk dws [--host <peer|Host ID>] [--yes] -- <dws args>`：只读命令白名单直接执行；其余命令（包括未知的新命令）视为写操作。OA 仅放行明确列出的审批查询，所有其他 OA 命令（含同意、拒绝、撤销、转交、加签、评论及未知命令）始终拒绝，无论调用者或是否提供 `--yes`，错误提示「审批状态只能由你本人在钉钉里处理」。派发环境中所有写命令都拒绝。其余场景的非 OA 写命令仍需 `--yes`。限制均在解析 Host、启动进程或跨机请求前执行；无法识别的命令前置选项也拒绝，防止选项值混淆命令路径。

## 性能与缓存

- 消息快照、增量追加和历史翻页都按 `messageId` 合并；同一 ID 的重复投递更新已有行，正文相同但 ID 不同的消息仍分别保留。Host 在向工作台和派发广播前按会话与消息 ID 去重最近 4000 个事件，重放不会重复增加未读数。工作台和派发订阅同一个 `DingTalkService`，监听保活只延长同一条事件流。
- 本人消息按登录 `userId` 与 `contact user get-self` 中同一用户的 `openDingTalkId` 识别，不按姓名判断。发送返回的稳定消息 ID 会保留到 Renderer；缺少 ID 时，仅把同会话、发送时间附近、正文一致的本地发送占位与本人的服务端消息一对一合并。事件先回流或发送先确认都只留下右侧一条气泡。

- 工作台不缓存消息、摘要或会话列表：每次打开、刷新、收到 `codexhost/dingtalk/changed` 和定时轮询都重新读取 dws。Host 只对完全相同的并发请求做 in-flight 去重，并保留 `chat group list-all` 的群类型/人数元数据用于标签。
- 通知之外还有保底轮询：页面可见时每 10 秒刷新当前会话，每 30 秒刷新未读列表；页面隐藏时停止，恢复可见时立即补一次。轮询不写入缓存，也不与慢请求重叠。事件通知在 Host 侧合并 250 ms 内的事件，并广播给共享同一 DingTalk 服务的所有 Desktop 会话。
- 首屏只等待 `list-unread-conversations`，认证与消息、列表读取并行且不阻塞它们。认证状态和本人身份只在 Host 生命周期内记住；仅命令返回认证错误或用户点击「重试」时重查。本人开放 ID 只对同一身份补全一次，消息不等待补全。群目录、最近两天的 `chat +at-me` 在消息读取结束并空闲 5 秒后并行补全，数据变化时才发一次通知；这些补充查询不占用首屏消息的等待路径。
- 当前会话消息和未读列表在事件到达后并行刷新；消息 RPC 使用 interactive 优先级，列表摘要使用 background。消息读取复用已有会话标题，未知会话也只并行查询基本信息。
- 提交时展开会话引用只读取最近 100 条消息并跳过单聊职位补全，`conversationInfo` 与消息列表并行执行，避免一条引用串行等待多次 dws。
- 会话列表只为可见行懒加载最近一条消息摘要，最多 3 个并发；拿不到摘要时第二行留空。
- 最近消息每次按会话实时读取；滚动加载更早消息走同一 `chat message list` 游标，不阻塞首屏。Renderer 只保留当前会话最近 200 条消息和对应 DOM，首屏 30 条。
- 只有 `dws` 已登录时才在 DingTalk Host 启动长连接事件流；本机工作台直接消费，桌面派发可通过 SSH 消费。订阅使用 `event consume` 的两个全量 IM EventKey，即 `+listen-im` 的底层订阅生命周期。事件用于增加未读数、更新最近消息和向 Renderer 推送 `codexhost/dingtalk/changed`，不轮询。事件流按 5 秒到 60 秒退避重启；5 分钟无请求后停止，下次请求或轮询再启动。退出用 SIGTERM，让 CLI 自行退订。
- `dws` 以参数数组启动，无 shell；单次输出和总时长都有上限。

## 已读状态

`[有人@我]` 只在钉钉当前 `unreadCount > 0` 的会话中显示：对命中 @ 的会话读取最近未读数量范围的消息（最多 100 条），以第一条可确认未读消息的时间为下界。@ 必须位于该下界与会话最新消息之间；读取失败或无法确认时不亮标。打开会话立即清除标签。

`dws` 没有「标记已读」命令。codexhost 在 DingTalk Host 的 `~/.codexhost/dingtalk-viewed.json` 记录每个会话最后查看的消息时间，未读列表隐藏这些会话，直到出现更新的消息。该文件只由 DingTalk Host 写入，不参与跨机同步。

页面改为在 DingTalk Host 上记录已读后，Mac 本机以前写入的 `dingtalk-viewed.json` 不再参与过滤：首次升级后，之前只在 Mac 上查看过的未读会话会重新出现一次，再点开即恢复隐藏。

单聊标题只显示姓名，搜索结果与成员选择不显示或检索职位。所有读取和引用路径均不执行职位补全查询。

## 搜索

搜索是纯关键词，不经过 Gemini：

1. 先命中本地未读列表里的标题和摘要。
2. 并发执行 `chat search --query`（群）、`contact user search --query`（人，解析成单聊）和 `chat +search-msg --query`（最近 30 天消息）。
3. 联系人按开放用户 ID 通过 `chat +conversation-info --open-dingtalk-id` 取得单聊会话 ID；按会话 ID 去重，联系人优先占用 20 条会话结果额度，群结果不会把联系人挤掉。

搜索结果按「联系人」「群聊」「聊天记录」分组，联系人在前。群结果带 `groupType` 和 `memberCount`，人员结果只显示姓名；点击联系人打开其单聊，不发送消息。

## 边界

- `shared-contracts` 只放 carrier、数据类型和 RPC schema，保持浏览器安全。
- `renderer-extension` 只做 DOM、缓存展示、搜索编排和 chip 插入；不读取 key、不直接调用 CLI 或 SSH。
- `host-runtime` 负责 CLI 发现、参数校验、缓存、事件流、搜索合并、媒体缓存、peer 路由和提交时展开。
- 工作台页面发送消息由用户点击或 Enter 触发；启用智能体监听后，派发运行时按固定目标自动回复进度和结果。测试和开发环境不对真实账号发送消息或执行审批写操作。

## 智能体监听与派发

派发由桌面本机 Host 管理，和工作台页面的开关无关。只要至少一个智能体启用了监听，Host 就保持 DingTalk Host 上的 dws IM 事件流（默认即 Mac 本机，直接启动本机 dws；若改为远端 peer 则通过 SSH 接收扁平 NDJSON）。全部单聊和群聊使用 `user_im_message_receive_o2o_all` / `user_im_message_receive_group_all`；SSH 只启动远端 `~/.local/bin/dws event consume … --flatten -f ndjson`，不转发 Mac 的 Runtime token。关闭全部监听后恢复工作台原有的五分钟空闲释放策略，连接失败按 5–60 秒退避重连。

每个智能体独立选择 `@我`、`@所有人`、`待我审批`、`私聊消息` 和回复位置。新智能体默认选择全部四类，既有配置保留原有选择。扁平事件有消息/会话 ID、事件类型、发送人展示名和 `sender_open_dingtalk_id`、正文和时间；不提供组织内 userId 或结构化 @ 列表时不编造这些字段。`@我` 按已登录用户展示名的完整提及识别（包括 dws 的 `@姓名(姓名)` 形式），`@所有人` 支持文本和 `<@all>` 标记；单聊无需 @。发送人和机器人身份还会用原会话消息元数据核对。

Host 忽略本人、机器人、早于本次启用监听起点的消息以及已处理消息。同一事件命中多个类型时，每个智能体最多成为一次候选。`~/.codexhost/dingtalk-dispatch-state.json` 持久化最近 4000 个消息/审批任务 ID 和最多 64 个智能体的最后结果；不保存原文或模型 Key。Host 重启或重新启用监听会刷新时间起点，已处理 ID 仍保留。

每条候选事件只发起一次 Gemini Decisions 请求（`https://generativelanguage.googleapis.com/v1beta/decisions`，模型 `gemini-decision-1`），按各智能体名称和描述评分；所有分数达到全局阈值的智能体并行执行，默认阈值为 0.85。`dingtalk-dispatch-matcher.ts` 复用原 Decisions 客户端、请求、分数处理和超时行为，只通过 `ModelServiceSettingsStore.readKey("gemini")` 读取通用页「模型服务」保存的 Gemini API Key；密钥仅在本地 Host 内使用。智能体页面按原因显示中文：402/429 为「Gemini 额度不足，未派发」，401/403 为「Gemini Key 无效，未派发」，超时为「Gemini 匹配超时，未派发」。Desktop 项目确认失败显示「需要在 Desktop 确认「钉钉智能体」文件夹，未派发」；未知原始错误不直接展示。不读取通用页「解析模型」选择，也不调用 OpenAI、Jarvis 查询解析或其他模型作兜底。没有 Gemini Key 时不创建对话、不回复占位卡，记录「未配置 Gemini Key，未派发」，智能体卡片与编辑器的派发状态行显示该原因；服务失败或低于阈值也记录跳过原因。

每次执行创建一个原生 Codex Thread，目录为 `~/Documents/ChatGPT/钉钉智能体`，标题为 `<智能体名> · <群名或对方> · <原文摘要>`。Renderer 使用项目镜像同源的 `appServices.workspaceFiles.createDirectory` 和 `appServices.projects.createLocal` 创建缺失项目，不激活项目、不修改当前 Composer；原生侧栏按目录归属列出 Thread。Desktop 项目 API 不可用时本次派发失败，不用私有存储写入模拟项目。普通消息的 Turn 使用只读文件系统沙箱并允许网络查询，供智能体读取知识库；审批汇总关闭网络。Thread 继承智能体的 developer instructions、Model 和推理强度；输入包含原文、发送人、会话、回复位置以及最近 20 条消息。Turn 失败会写回中文原因。运行期间每 10 分钟更新「仍在处理，已用时 N 分钟」，不因耗时请求中断 Turn。60 分钟后结束卡片跟踪，以「处理时间过长，已停止」完结卡片；Desktop 对话仍保留，用户可手工继续。

所有派发 Thread（普通消息和审批汇总）通过原生 Thread 配置 `shell_environment_policy.set.CODEXHOST_DINGTALK_DISPATCH = "1"` 为 shell 设置环境标记，后续 Turn 继承该设置。`codexhost dingtalk dws` 在此环境中拒绝所有写命令，即使提供 `--yes`；智能体只能查询，派发器在自己的 Host 环境中发送进度和结果。该限制作用于 codexhost CLI 包装层，环境标记不是操作系统级网络或凭据隔离。

回复目标完全由 Host 决定：群消息选择「私聊」时，回复给事件的发送人开放 ID；选择「群内」时在原群 @ 发送人。单聊始终回到与该发送人的私聊，忽略「回复位置」选择。在启动模型前，用 `chat message send-a2ui-card` 创建「思考中…」A2UI 占位卡，并保存服务端真实 `bizId`。布局使用钉钉公开 Catalog、独立的群 @ 通知组件和绑定 `/answer/displayText` 的正文。只采集智能体公开 commentary 和计划步骤，至少间隔 5 秒串行提交累计正文的 `INPUTTING` 更新；不展示内部推理或工具输入输出。成功和失败都通过同一卡片非空 `FINISH` 完结，最终正文组件附 `artifact` 注解，同时移除生成标记与 shimmer。失败正文说明原因；完整答案保留在卡片中，不截断。创建失败、缺少真实 `bizId` 或更新结果未知时停止写入，不重建卡片、不补发文本，派发状态提示用户检查钉钉。群 @ 仅在创建时声明，更新不重新通知。自动回复是启用监听授权的行为，固定目标写命令带 `--yes`，无需逐次确认。智能体卡片和编辑面板每 10 秒更新最近派发时间及已回复、失败或跳过原因。

审批每分钟通过 `oa approval list-pending` 只读查询，以 taskId 去重，也通过同一 Gemini Decisions 模型和阈值筛选。审批内容只用于汇总，进度和结果私聊给本人（按本人稳定 userId 精确解析开放 ID）；无法确定本人目标时不派发。审批 Thread 使用只读沙箱，并关闭 shell、执行、补丁、子智能体、App、插件、Hook、浏览器及全部配置的 MCP 服务器，不依赖提示词防止写入。派发运行时只构造 OA 的查询命令，绝不构造同意、拒绝、撤销或评论命令；无法读取配置以限制工具时直接失败。

开发验证仅使用假事件、假 dws 和假原生 Thread。真实 dws 只读核对 `event schema … --flatten`、`event +listen-im --help`、卡片帮助、`chat +at-me` 和 `oa approval list-pending` 的字段；不启动真实订阅或发送测试消息。Desktop 验收需另一个账号在测试群 @ 已登录用户，以及向用户发送私聊消息，核对项目、对话、卡片生命周期与目标；本人发送的消息应被忽略。

### A2UI 参数核对

在 DingTalk Host 上分别读取 `dws schema --cli-path "chat message send-a2ui-card" --compact -f json` 和 `update-a2ui-card` 的同名 schema。创建目标使用群 `--conversation-id` 或个人 `--open-dingtalk-id`，群通知另带 `--at-open-dingtalk-ids`；`--content` 为 JSON 字符串数组。校验使用从只读结果取得的真实目标 ID，并在每条写命令中加入 `--dry-run`，核对 `dry_run: true`、`executed: false`。覆盖群创建、单聊创建、`INPUTTING` 和携带 `--a2ui-annotations` 的 `FINISH`。dry-run 只能确认命令参数与请求结构；桌面和手机的真实展示、通知及摘要需要用户自行验收。
