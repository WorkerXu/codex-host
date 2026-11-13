# DingTalk 工作台

Codex Desktop 的「钉钉」入口复用官方 DingTalk Workspace CLI `dws`，把一个 Host 上的钉钉登录变成所有机器可用的只读工作台。它和 Jarvis `@` 引用共用同一套做法：Renderer 追加原生菜单行，Host 在提交时展开引用，CLI 与网络访问只发生在 Host。

## 入口与页面

- Composer 的原生 `@` 菜单在查询为空或匹配「钉」（`钉钉` / `dingtalk` 前缀）时追加一行「钉钉」。原生菜单行为不变；没有原生结果时同一行停靠在 Composer 上方的浮动面板。
- 选择该行打开工作台（设置页外壳中的 `dingtalk` 页面），并记住打开它的 Composer。页面关闭后，嵌入操作仍回到这个 Composer。
- 页面左侧只显示有未读的会话；没有未读时显示最近回复过的 10 个会话（按自己发出的消息倒序去重）。右侧显示所选会话的消息、支持多选，底部以当前用户身份发送消息。
- 消息卡片等非文本内容只显示一行摘要和「请在手机上查看」，不把媒体二进制带进页面。
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
- 设置页（仅本地 Host）保存 `~/.config/codexhost/dingtalk-settings.json` 的 `defaultHost`，可选本地或任一 `peers.json` 中的 peer；未设置时优先 `tencent` peer，没有该 peer 则用本机。
- 读取请求通过 `peer-exec` 的 `/v1/dingtalk/dws` 路由转发同一组参数数组；对端 Host 执行本机 `dws` 并原样返回 stdout、stderr 与退出码。目标机器上设置自动解析为本机，因此同一份默认值在 Mac 和 tencent 上都指向 tencent 的登录。
- CLI 透传 `codexhost dingtalk dws [--host <peer|Host ID>] [--yes] -- <dws args>`：只读命令白名单直接执行；其余命令（包括未知的新命令）视为写操作，缺少 `--yes` 时在启动任何进程前拒绝。

## 性能与缓存

- 会话列表第一次请求等待一次未读查询；之后立即返回内存缓存（stale-while-revalidate），过期时后台刷新。请求路径从不调用约 13 秒的 `+recent-conversations`。
- 最近消息按会话缓存 60 秒；滚动加载更早消息走同一 `chat message list` 游标，不阻塞首屏。
- 长消息列表用 `content-visibility: auto` 跳过视口外的行，并限制同时渲染的消息数量；会话列表最多 50 行。
- 只有 DingTalk Host 本机、且 `dws` 已登录时才启动一条长连接事件流（`event consume` 的两个全量 IM EventKey，即 `+listen-im` 的底层订阅生命周期）。事件用于增加未读数、更新最近消息和向 Renderer 推送 `codexhost/dingtalk/changed`，不轮询。事件流按 5 秒到 60 秒退避重启；5 分钟无请求后停止，下次请求再启动。退出用 SIGTERM，让 CLI 自行退订。
- `dws` 以参数数组启动，无 shell；单次输出和总时长都有上限。

## 本机已读状态

`dws` 没有「标记已读」命令。codexhost 在 `~/.codexhost/dingtalk-viewed.json` 记录每个会话最后查看的消息时间，未读列表隐藏这些会话，直到出现更新的消息。该文件只在本机 Host 写入，不参与跨机同步。

## 搜索

搜索框先用本地 Host 的 Gemini Decision 分类：

- `conversations`：按标题、单聊/群聊、最近消息摘要对当前候选会话打分，返回最多 8 个匹配。
- `messages`：翻译成 `chat +search-msg` 的过滤条件（关键词、`--senders`、`--at-me`、`--days`），最多返回 30 条消息。

Gemini key 只保存在本地 Host 的 `~/.config/codexhost/gemini-api-key`（0600），与 Jarvis 共用。key 缺失或请求失败时返回 `available: false` 并按关键词搜索，UI 显示降级提示。

## 边界

- `shared-contracts` 只放 carrier、数据类型和 RPC schema，保持浏览器安全。
- `renderer-extension` 只做 DOM、缓存展示、搜索编排和 chip 插入；不读取 key、不直接调用 CLI 或 SSH。
- `host-runtime` 负责 CLI 发现、参数校验、缓存、事件流、Gemini、peer 路由和提交时展开。
- 发送消息是唯一由页面直接触发的写操作，必须由用户点击发送或按 Enter 明确触发；测试和开发环境不应对真实账号执行任何写命令。
