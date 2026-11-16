# DingTalk 工作台

Codex Desktop 的「钉钉」入口复用官方 DingTalk Workspace CLI `dws`，把一个 Host 上的钉钉登录变成所有机器可用的只读工作台。它和 Jarvis `@` 引用共用同一套做法：Renderer 追加原生菜单行，Host 在提交时展开引用，CLI 与网络访问只发生在 Host。

## 入口与页面

- Composer 的原生 `@` 菜单在查询为空或匹配「钉」（`钉钉` / `dingtalk` 前缀）时，把「工作台 / 钉钉」分组追加到原生列表底部；分组与原生行共用同一个滚动容器、分组标题和行结构，上下键与回车跟随原生选择。只有原生菜单不存在时才停靠浮动面板。
- 选择该行打开工作台（设置页外壳中的 `dingtalk` 页面），并记住打开它的 Composer。页面关闭后，嵌入操作仍回到这个 Composer。
- 页面左侧只有一个未读列表：来自 `chat message list-unread-conversations`，只显示最近 48 小时内仍有未读、且最后一条消息晚于本机已读时间的会话。右侧显示所选会话的消息，并以当前用户身份发送消息。
- 钉钉页占用工作台内容区全宽；打开时隐藏设置导航，顶部关闭按钮仍可返回。
- 消息按 dws 字段渲染：`quotedMessage` 引用块、`reactions` / `emotionReplyList` 表情计数、`resourceRefs` 图片和文件、`sendType: bot` 机器人标签、Markdown 卡片标题与正文。`<imageContent>`、`mediaId=`、`fileId:` 等原始标记一律不显示。
- 图片由 DingTalk Host 用 `chat +messages-resource-download` 下载，以 data URL 经 RPC 返回；Renderer 只在图片进入可视区时下载并转成 object URL 缩略图（最大 240 px），行离开 DOM、切换会话或关闭页面时立即 revoke。
- Agent 回复中的 `dingtalk://conversation/<cid>` 和 `dingtalk://message/<cid>/<id>` 链接会打开页面并滚动到、短暂高亮对应消息。

## 引用与提交时展开

`shared-contracts` 定义两个 carrier：

- `dingtalk://conversation/<cid>`
- `dingtalk://message/<cid>/<messageId>[,<messageId>...]`

cid 可能包含 `/`、`+`、`=`，因此路径按段 percent-encode；解析时也接受未编码的 cid，并以最后一个 `/` 作为消息分隔符。嵌入时优先插入 Desktop 原生 mention chip，控制器不可用时退化为 Markdown carrier。

`turn/start`、`turn/steer` 和外部 steering 都会经过 Host 的 `dingtalk-mention-rewrite.ts`。会话引用取最近 30 条消息；所选消息取这些消息及其前后各 3 条同会话上下文。输出一段 `[codexhost DingTalk]` 上下文块，包含会话标题、类型、cid、发送人、时间和正文；失败只写一行说明，不阻断 Turn。

上下文块同时告诉 Agent：更多记录用 `codexhost dingtalk dws -- <dws 参数>` 读取；发送、撤回、审批等写操作必须先征得用户同意，并在命令中加 `--yes`。

## 默认 Host 与跨机路由

- 每台 Host 都可以运行 DingTalk 服务，但真正的 `dws` 只在登录了钉钉的那台机器上执行。
- DingTalk Host 固定使用 `peers.json` 里的 `tencent` 登录；没有该 peer 时才退回本机。界面不提供登录机器选择，`~/.config/codexhost/dingtalk-settings.json` 的 `defaultHost` 仍会被读取，供以后手工修改或迁移使用。
- Renderer 每次打开页面先向本机 Host 读取 `status()`，用返回的 `defaultHostId` 找到 Desktop 已有的远端 Host 连接；找到后，`conversations / preview / messages / resource / send / search / resolve / viewed` 都直接发给那台 Host，并只订阅它的 `codexhost/dingtalk/changed`。没有该连接时才退回本机 Host 的 peer-exec 转发。`status` 和设置始终留在本机 Host。
- 工作台不提供「钉钉登录 / 默认机器」下拉。⋯ 菜单只显示一行连接状态：已连接时显示 `已连接 · <userName>（<corpName>）`，未登录显示「钉钉未登录」，tencent 不可达显示「无法连接钉钉服务」；后两种状态附「重试」。
- 读取请求通过 `peer-exec` 的 `/v1/dingtalk/dws` 路由转发同一组参数数组；对端 Host 执行本机 `dws` 并原样返回 stdout、stderr 与退出码。目标机器上设置自动解析为本机，因此同一份默认值在 Mac 和 tencent 上都指向 tencent 的登录。
- 图片下载通过同级的 `/v1/dingtalk/media` 路由在登录机器上执行，只接受会话、消息和资源 id；返回 base64、MIME 和大小。缓存目录按运行时隔离，不读取 `~/.codexhost/runtime/`。
- CLI 透传 `codexhost dingtalk dws [--host <peer|Host ID>] [--yes] -- <dws args>`：只读命令白名单直接执行；其余命令（包括未知的新命令）视为写操作，缺少 `--yes` 时在启动任何进程前拒绝。

## 性能与缓存

- 工作台不缓存消息、摘要或会话列表：每次打开、刷新和收到 `codexhost/dingtalk/changed` 都重新读取 dws。Host 只对完全相同的并发请求做 in-flight 去重，并保留 `chat group list-all` 的群类型/人数元数据用于标签。
- 打开未读视图时，`auth status`、`list-unread-conversations` 和 `chat +at-me` 并发执行；`group list-all` 不阻塞首屏，结果到达后补上「内部群」和人数标签并发一次变更通知。
- 会话列表只为可见行懒加载最近一条消息摘要，最多 3 个并发；拿不到摘要时第二行留空。
- 最近消息每次按会话实时读取；滚动加载更早消息走同一 `chat message list` 游标，不阻塞首屏。Renderer 只保留当前会话最近 200 条消息和对应 DOM，首屏 30 条。
- 只有 DingTalk Host 本机、且 `dws` 已登录时才启动一条长连接事件流（`event consume` 的两个全量 IM EventKey，即 `+listen-im` 的底层订阅生命周期）。事件用于增加未读数、更新最近消息和向 Renderer 推送 `codexhost/dingtalk/changed`，不轮询。事件流按 5 秒到 60 秒退避重启；5 分钟无请求后停止，下次请求再启动。退出用 SIGTERM，让 CLI 自行退订。
- `dws` 以参数数组启动，无 shell；单次输出和总时长都有上限。

## 已读状态

`dws` 没有「标记已读」命令。codexhost 在 DingTalk Host 的 `~/.codexhost/dingtalk-viewed.json` 记录每个会话最后查看的消息时间，未读列表隐藏这些会话，直到出现更新的消息。该文件只由 DingTalk Host 写入，不参与跨机同步。

页面改为在 DingTalk Host 上记录已读后，Mac 本机以前写入的 `dingtalk-viewed.json` 不再参与过滤：首次升级后，之前只在 Mac 上查看过的未读会话会重新出现一次，再点开即恢复隐藏。

## 搜索

搜索是纯关键词，不经过 Gemini：

1. 先命中本地未读列表里的标题和摘要。
2. 并发执行 `chat search --query`（群）、`contact user search --query`（人，解析成单聊）和 `chat +search-msg --query`（最近 30 天消息）。
3. 按会话 id 去重：本地结果在前，其次是群、单聊、消息命中的会话。

搜索结果仍分「会话」「聊天记录」两组；群结果带 `groupType` 和 `memberCount`，人员结果显示职位。

## 边界

- `shared-contracts` 只放 carrier、数据类型和 RPC schema，保持浏览器安全。
- `renderer-extension` 只做 DOM、缓存展示、搜索编排和 chip 插入；不读取 key、不直接调用 CLI 或 SSH。
- `host-runtime` 负责 CLI 发现、参数校验、缓存、事件流、搜索合并、媒体缓存、peer 路由和提交时展开。
- 发送消息是唯一由页面直接触发的写操作，必须由用户点击发送或按 Enter 明确触发；测试和开发环境不应对真实账号执行任何写命令。
