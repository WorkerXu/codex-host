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
- Renderer 每次打开页面并行发起本机 Host 的 `status()` 和未读读取。路由尚未确定时使用本机 peer-exec 转发，随后用身份响应中的 `defaultHostId` 找到 Desktop 已有的远端 Host 连接；找到后，`conversations / preview / messages / resource / send / search / resolve / viewed` 都直接发给那台 Host，并只订阅它的 `codexhost/dingtalk/changed`。没有该连接时才退回本机 Host 的 peer-exec 转发。`status` 和设置始终留在本机 Host。
- 工作台不提供「钉钉登录 / 默认机器」下拉。⋯ 菜单只显示一行连接状态：已连接时显示 `已连接 · <userName>（<corpName>）`，未登录显示「钉钉未登录」，DingTalk Host 不可达显示「无法连接钉钉服务」；后两种状态附「重试」。
- 读取请求通过 `peer-exec` 的 `/v1/dingtalk/dws` 路由转发同一组参数数组；对端 Host 执行本机 `dws` 并原样返回 stdout、stderr 与退出码。目标机器上设置自动解析为本机，因此同一份默认值在 Mac 和各服务器上都指向 Mac 的登录。
- 图片下载通过同级的 `/v1/dingtalk/media` 路由在登录机器上执行，只接受会话、消息和资源 id；返回 base64、MIME 和大小。每次读取使用独立临时下载文件，读完或失败即删除，不复用或保留媒体文件，不读取 `~/.codexhost/runtime/`。
- CLI 透传 `codexhost dingtalk dws [--host <peer|Host ID>] [--yes] -- <dws args>`：只读命令白名单直接执行；其余命令（包括未知的新命令）视为写操作。OA 仅放行明确列出的审批查询，所有其他 OA 命令（含同意、拒绝、撤销、转交、加签、评论及未知命令）始终拒绝，无论调用者或是否提供 `--yes`，错误提示「审批状态只能由你本人在钉钉里处理」。派发环境中所有写命令都拒绝。其余场景的非 OA 写命令仍需 `--yes`。限制均在解析 Host、启动进程或跨机请求前执行；无法识别的命令前置选项也拒绝，防止选项值混淆命令路径。

## 实时读取与性能

- 消息快照、增量追加和历史翻页都按 `messageId` 合并；同一 ID 的重复投递更新已有行，正文相同但 ID 不同的消息仍分别保留。Host 在向工作台和派发广播前按会话与消息 ID 去重最近 4000 个事件，重放不会重复增加未读数。工作台和派发订阅同一个 `DingTalkService`，监听保活只延长同一条事件流。
- 本人消息按登录 `userId` 与 `contact user get-self` 中同一用户的 `openDingTalkId` 识别，不按姓名判断。发送返回的稳定消息 ID 会保留到 Renderer；缺少 ID 时，仅把同会话、发送时间附近、正文一致的本地发送占位与本人的服务端消息一对一合并。事件先回流或发送先确认都只留下右侧一条气泡。

- 工作台在 Host 内存中维护一份实时状态：未读列表行（标题、未读数、最新摘要与时间、标记、头像参数）、最近打开或活跃的 20 个会话各 50 条最新消息，以及这些群的成员。状态只含文本和资源引用，不含图片或文件字节；按序列化长度计量，总量硬上限 5 MB，超出时按最近查看顺序淘汰消息和成员，最后才淘汰列表行。它不写磁盘，Host 重启或钉钉退出登录即清空。`messages` 快照按 `messageId` 合并，实时页不再返回的窗口内消息视为撤回并移除；窗口外更早的消息和晚于读取开始的事件保留。
- 打开列表或会话直接返回内存状态（`refreshing: true`、`cachedAt` 为该状态最后一次与 dws 对齐的时间），同时按会话去重地发起一次后台实时读取，补齐其他设备发送的消息、撤回和已读状态；只有数据确实变化时才推送 `codexhost/dingtalk/changed`，因此渲染端原地更新即可，不闪烁、不跳滚动位置，草稿不受影响。没有任何内存状态时（Host 刚启动、尚未读列表或首次打开该会话）仍按原路径等待 dws。
- dws IM 事件流（`user_im_message_receive_o2o_all` / `user_im_message_receive_group_all`）同步写入这份状态：追加消息、增加未读数、更新摘要和最后时间并把该行置顶，然后通知页面；事件不评分或派发。
- 列表渲染后对**所有可见行**（含折叠区域外的滚动可见行）按 background 优先级预取最新消息，Host 侧以跨 RPC 共享的队列限制并发 2 条 dws 读取；指针进入某行 150 ms 后也会预取该行，即使它曾经预热过（可能已被内存上限淘汰）；移开指针取消未开始的预读。预取同样受 5 MB 上限约束，超出时按最近查看顺序淘汰。成员仍按需加载：`@` 选择器打开时读取，或会话消息渲染完成后在后台预热，均不阻塞首屏。
- 状态命中/未命中和后台读取耗时记入有上限的环形记录，可通过 `codexhost/dingtalk/diagnostics` 只读查询；记录只含会话 ID、耗时和状态大小，不含消息内容。Renderer 另把点击 → 首帧（`paintMs`）、消息列表与 Markdown/提及构建耗时（`renderMs`）和点击 → 首屏实际请求图片完成（`imagesMs`）写入同一环形记录。首帧跨过一次绘制机会后计量；离屏图片不计入首屏，无图片、图片超过 20 秒未完成或离开会话时尚未完成均记 `null`，不把超时当作加载完成。图片仍按可视区懒加载，绝不阻塞文字渲染。
- 通知之外还有保底轮询：页面可见时每 10 秒刷新当前会话，每 30 秒刷新未读列表；页面隐藏时停止，恢复可见时立即补一次。轮询同样先显示内存状态并在后台对齐 dws，不与慢请求重叠。事件通知在 Host 侧合并 250 ms 内的事件，并广播给共享同一 DingTalk 服务的所有 Desktop 会话。
- 首屏只等待 `list-unread-conversations`（同一 Host 生命周期内后续打开直接命中内存状态），认证与消息、列表读取并行且不阻塞它们。认证状态和本人身份只在 Host 生命周期内记住；仅命令返回认证错误或用户点击「重试」时重查。本人开放 ID 只对同一身份补全一次，消息不等待补全；补全后通知当前页面重新读取，修正冷启动时本人的开放 ID 消息方向。页面收到实时未读列表后，另发 `details` 请求并行读取群目录和最近两天的 `chat +at-me`；补充结果写入内存状态并用于该次列表。首屏、会话消息和摘要均不等待补充查询，补充响应不会触发循环刷新。
- 当前会话消息和未读列表在事件到达后并行刷新；消息 RPC 使用 interactive 优先级，列表摘要使用 background。工作台使用当前页面的会话标题，消息请求显式设置 `includeConversation: false`，只执行一次消息读取；派发与引用展开按需并行读取实时基本信息。
- 会话引用先读最近 30 条消息；所选旧消息不在其中时，才读取有上限的历史页，`conversationInfo` 与消息列表并行执行，避免一条引用串行等待多次 dws。
- 会话列表为可见行懒加载最近一条消息摘要（事件、预取或此前读取已写入内存状态时直接显示），最多 3 个并发；拿不到摘要时第二行留空。
- 最近消息优先来自内存状态；首次打开、加载更早消息和后台对齐仍走同一 `chat message list` 游标，不阻塞首屏。Renderer 只保留当前会话最近 200 条消息和对应 DOM，首屏 30 条。
- 只有 `dws` 已登录时才在 DingTalk Host 启动长连接事件流；本机工作台直接消费，桌面派发可通过 SSH 消费。订阅使用 `event consume` 的两个全量 IM EventKey，即 `+listen-im` 的底层订阅生命周期。事件只更新内存状态，并向 Renderer 推送 `codexhost/dingtalk/changed`；工作台收到通知后读取钉钉实时状态。事件流按 5 秒到 60 秒退避重启；5 分钟无请求后停止，下次请求或轮询再启动。退出用 SIGTERM，让 CLI 自行退订。
- `dws` 以参数数组启动，无 shell；单次输出和总时长都有上限。

已读时间与当前打开的会话 ID 是用户操作状态，会写入 `~/.codexhost/`；手动派发结果和消息上的派发标记只保存在内存中，旧自动派发状态文件不再读取或写入；除上面描述的 Host 内存实时状态外，不存储消息正文、联系人目录或列表副本，且内存状态从不落盘。

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
- `renderer-extension` 只做 DOM、当前页面展示、搜索编排和 chip 插入；不读取 key、不直接调用 CLI 或 SSH。
- `host-runtime` 负责 CLI 发现、参数校验、事件流、搜索合并、临时媒体下载、peer 路由和提交时展开。
- 工作台页面发送消息由用户点击或 Enter 触发；派发只由用户在单条消息上手动发起，运行中的进度卡和最终回复由 Host 按智能体设置发送。测试和开发环境不对真实账号发送消息或执行审批写操作。

## 智能体手动派发

派发由桌面本机 Host 管理，**只由用户在一条钉钉消息上手动触发，事件流不会自动派发**。只要至少一个智能体启用，Host 就在 DingTalk Host 上保持 dws IM 事件流（默认即 Mac 本机；远端 peer 通过 SSH 接收扁平 NDJSON），事件只用于更新工作台的内存实时状态（列表、未读数、最新摘要和消息），不评分、不派发、不轮询审批。关闭全部智能体后恢复工作台原有的五分钟空闲释放策略，连接失败按 5–60 秒退避重连。

每个智能体保留两项选择：是否启用，以及回复位置（群内 @发送人 / 私聊发送人）。派发前还必须选择「分区」和「工作项目」：分区来自 Desktop 原生侧栏分区（`codex-native-sections.ts` 的 `QV` 与 AppScope），工作项目只列出该分区中包含的 Mac 本机项目（`local-projects` / 侧栏项目目录）。分区里只有一个本机项目时自动选中；有多个时由用户选择；没有时提示在该分区添加 Mac 本机项目或换一个分区。codexhost 从不移动项目或对话，分区只通过其中包含的项目使用。

旧版设置文件里的 `eventTypes` 与全局 `threshold` 在读取时忽略，`enabled` 和 `replyScope` 原样保留，因此不会丢失已启用的智能体；写回时这两个字段不再出现。缺少分区或工作项目的智能体在智能体卡片上显示「需要设置分区和工作项目」，在派发面板中变灰、不可勾选，也不能被派发。

### 消息操作与判断面板

消息气泡右侧的悬停工具条沿用原生钉钉的间距和尺寸，不改变布局：

- 「交给智能体」打开判断面板；
- 「回复」在输入框预填「@发送人 」并聚焦，不发送；
- 「···」打开圆角菜单。

右键消息打开同一菜单，菜单只有「交给智能体」「复制」和「回复」。不提供转发、DING、收藏、稍后处理、钉住、翻译（没有受支持的 API）和多选；所有操作只针对这一条消息。

卡片、群接龙等互动消息不显示原始 JSON 或长链接：气泡、会话列表预览和判断面板引用都显示为「[类型] 标题 · 一句话说明」（例如「[群接龙] 嗑瓜子大赛报名接龙 · 已有15人参加」）。

面板只列出已启用的智能体，并为这条消息立即发起**一次** Gemini Decisions 请求：输入只有消息正文（不含上下文），每个智能体一道既有的「不能处理 / 能处理」二选一题。结果按分数从高到低排序，每行显示头像、名称、一行职责、百分比分数和细进度条。默认勾选分数最高的智能体，除非判断失败或最高分低于 0.3；用户可以改选一个或多个。

Gemini 8 秒超时或失败时，面板仍按名称列出已启用智能体（不显示分数），并提示「判断失败，可直接选择」，绝不阻塞派发。「派发（N）」对每个勾选的智能体各运行一次既有派发流程：

- 在所选工作项目下创建原生 Codex Thread：`thread/start` 带原生 app-server 项目 ID，cwd 和 `runtimeWorkspaceRoots` 取项目当前的全部根目录；
- 发卡前强制重新读取 Desktop 本地项目目录；项目缺失、根目录为空、任何目录不存在或无法访问均返回中文错误，不向钉钉发任何东西。保存的 `projectPath` / `projectRoots` 只用于设置展示，不作为执行依据；
- Desktop 界面项目 ID 与 app-server ID 可能不同。目录读取器使用 `app-server-project-id-by-legacy-project-id-by-host` 中当前 `local:<CODEX_HOME>` 的明确迁移映射，随后用只读 `project/read` 确认原生身份及根目录一致；未同步时停止派发，不按路径猜测项目归属。`thread/start` 返回的 `thread.projectId` 也必须匹配，才能启动 Turn；
- 以上一条消息为锚点读取最多 30 条更早的同会话消息，并附只读 dws 工具提示；
- 创建 A2UI 进度卡，按智能体的回复位置回到原会话；
- 沿用 60 分钟上限和只读约束。

派发结果返回后，消息下方显示已派发到的智能体标记（随 Host 内存消息状态保留，重新打开页面仍可见；受相同的消息淘汰、5 MB 上限及退出登录清理规则约束），点击标记打开对应的 Codex 对话。再次把同一条消息派发给同一智能体时先询问「已派发过，仍要派发？」。智能体卡片的「最近派发」只记录本次 Host 生命周期内手动派发的时间、会话和成功或失败，不包含阈值文字，也不读取旧自动派发历史。已存在的旧对话保持在原来的「钉钉智能体」项目里，不会被移动。

### 原生项目协议验证

Mac 安装的 `codex-cli 0.169.1` 的实验协议 schema 明确声明 `ThreadStartParams.projectId`，持久 Thread 会保存归属，`runtimeWorkspaceRoots` 指定运行目录。只读探测确认 `QV` / AppScope 中的分区项目使用界面 ID；直接 `project/read` 这些 ID 会失败，而通过 Desktop 的迁移映射读取原生 ID 均成功且根目录一致。Desktop 的原生侧栏按 Thread 的项目归属分组，分区包含项目；Host 不移动项目、Thread 或分区。协议与分组核对不创建真实 Thread、不执行派发。

### A2UI 参数核对

在 DingTalk Host 上分别读取 `dws schema --cli-path "chat message send-a2ui-card" --compact -f json` 和 `update-a2ui-card` 的同名 schema。创建目标使用群 `--conversation-id` 或个人 `--open-dingtalk-id`，群通知另带 `--at-open-dingtalk-ids`；`--content` 为 JSON 字符串数组。校验使用从只读结果取得的真实目标 ID，并在每条写命令中加入 `--dry-run`，核对 `dry_run: true`、`executed: false`。覆盖群创建、单聊创建、`INPUTTING` 和携带 `--a2ui-annotations` 的 `FINISH`。dry-run 只能确认命令参数与请求结构；桌面和手机的真实展示、通知及摘要需要用户自行验收。
