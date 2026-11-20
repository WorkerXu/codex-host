# Hub 管理页

Mac Desktop 的工作台设置提供「MCP 服务器」与「记忆」两个独立页面。列表、筛选和概览留在页面内，编辑、详情与危险操作使用原生 `dialog`。页面使用现有设置页的字体、颜色与控件样式。

## 连接与所有权

页面通过本机 Desktop 连接请求 `codexhost/hub-admin/request`。Mac Host 管理到 India 上两个服务的转发。

Mac Host 首次被需要时建立一条常驻 SSH 转发，之后在整个 Host 生命周期内复用：`ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ControlMaster=auto -o ControlPath=<0700 私有目录>/control -o ControlPersist=no -L 127.0.0.1:<空闲>:127.0.0.1:8765 -L 127.0.0.1:<空闲>:127.0.0.1:3000 <别名>`，使用用户 ssh config 中的别名（默认 `india`）及其 HY2 路由。`ControlPersist=no` 让主连接随转发进程存亡，即 Host 生命周期；Host 退出时先 `ssh -o ControlPath=... -O exit <别名>` 再清理私有目录。读令牌和读路由字段都加 `-o ControlMaster=no -o ControlPath=...` 复用主连接，不再新建 SSH 握手。断线后按 1/2/4/8/16/30 秒退避重连；页面显示「正在连接 India…」或「连接失败，重试中」。

配置位于 `~/.config/codexhost/hub-remote.json`，文件未配置的字段可用环境变量指定：`CODEXHOST_HUB_SSH_ALIAS`、`CODEXHOST_HUB_MEMHUB_PORT`、`CODEXHOST_HUB_MCPHUB_PORT`、`CODEXHOST_HUB_TOKEN_PATH`。默认值见 `DEFAULT_HUB_REMOTE_SETTINGS`；逻辑中不写死机器名。

Host Runtime 的 `HubAdminService` 校验共享契约中的操作枚举和严格参数，再请求转发出来的 loopback 端口。请求不能携带目标地址、HTTP 方法、任意路径或任意配置字段；转发只暴露两个固定端口。HTTP 禁止重定向，单次请求超时 8 秒。上游异常文本和校验错误不进入 RPC 或诊断日志；错误码在页面映射为「连接超时」「连接失败」「无权限」「服务未运行」「正在连接 India…」「连接失败，重试中」等中文提示。

MCP 页面用一次 `mcpOverview` 取连接状态、服务器和密钥；记忆页面用 `overview` 先展示概览和最近 4 条，再加载最近更新的完整分页。两个页面先用上次结果立即渲染，显示「更新于 X 前」，再在后台刷新；整页只在用户操作时显示加载态。

## MCPHub

MCPHub 服务位于 India 的 `127.0.0.1:3000`，经 Mac Host 的转发访问，使用 MCPHub 官方管理 REST API：

| 操作 | REST 路径 |
| --- | --- |
| 服务器列表 | `GET /api/servers` |
| 编辑所需原配置、只读工具列表 | `GET /api/servers/:name` |
| 添加、编辑、删除、启停 | `POST /api/servers`、`PUT/DELETE /api/servers/:name`、`POST /api/servers/:name/toggle` |
| 密钥列表、创建、编辑、删除、重新生成 | `GET/POST /api/auth/keys`、`PUT/DELETE /api/auth/keys/:id`、`POST /api/auth/keys/:id/reset` |
| 认证状态、认证头 | `GET /api/settings`、仅携带两项认证字段的 `PUT /api/system-config` |

用户在 MCPHub 网页后台创建专用管理员密钥，要求 `enabled=true`、`kind=system`、`accessType=all`（旧记录缺失 kind 时按原生系统级语义）。1.1.15 的管理 API 中间件拒绝用户级和受限范围密钥，验证通过时赋予管理员权限。Host 读取 `/etc/mcphub.env` 中的 `MCPHUB_SETTING_PATH`（默认 `/opt/mcphub/data/mcp_settings.json`），仅解析 routing 中的请求头名和认证策略；请求头默认 `Authorization`，值为 `Bearer <密钥>`。要求 Bearer 开启且 skipAuth 关闭，避免免认证请求误判密钥有效。Host 用户需要这些配置的只读权限。

Mac Host 从 `~/.config/codexhost/mcphub-admin-key` 读取管理员密钥，重启后继续使用该文件。首次连接或更换密钥时，Host 通过只读 `GET /api/auth/keys` 验证权限。验证通过后，Host 以 `0600` 写入同目录的临时文件，再原子替换密钥文件。验证失败时保留旧值；用户确认断开时删除文件。连接 RPC 只回报 `configured` 和 `last4`，提交后清空输入框。

认证凭据只用于 Host 到 localhost 的请求。Renderer 收不到管理员密码、哈希、JWT、原密钥或原服务器连接配置。列表密钥统一显示掩码；创建和重新生成的密钥按官方 API 返回值仅在一次性对话框展示并允许复制，关闭时清空控件。编辑服务器时连接字段留空保留原值，填写则替换该项；参数和环境变量使用 JSON 数组/对象，请求头使用键值行编辑器，保存前检查名称、重复项和换行，并在字段下方显示中文错误。Host 合并原生未知配置，协议切换清理不适用的连接字段。

支持流式 HTTP、SSE、stdio 的新建与编辑。保留其他协议的列表显示，操作菜单不提供编辑。密钥范围支持全部、排除所选服务器、仅所选服务器；原生用户级密钥或含组范围的密钥可以查看、删除、重新生成，但禁止用简化编辑器改写其范围。

服务器状态映射为在线、离线、未激活、禁用，并显示工具、提示词和资源数量。列表 API 不提供调用总量时，页面隐藏该字段。状态、协议和版本用中点分隔；禁用卡片内容淡化，开关仍可操作。点击卡片打开工具详情；启停使用开关，编辑、删除收在卡片操作菜单。Bearer 认证采用设置行与开关，请求头在单独对话框编辑；密钥行的操作收在菜单中。删除服务器、禁用服务器、删除密钥、重新生成密钥、关闭 Bearer 认证均须确认；相应 RPC 校验确认标记。

## MemHub

MemHub 服务位于 India 的 `127.0.0.1:8765`，经同一条转发访问。Host 首次需要时通过主连接执行 `cat -- <tokenPath>`（参数经 shell 转义）读取运行时令牌，令牌只保存在内存中，磁盘、日志和 RPC 都不出现；401 时丢弃并重读一次。不读取 codexhost runtime 目录，不经过 18765 runtime API。

- 概览：`GET /api/v2/home-summary`、`GET /api/v1/memory-processing`、最近 4 条的 `GET /api/v2/memory-library`、`GET /api/v1/sources`。
- 列表与搜索：`GET /api/v2/memory-library`，固定 `scene=all`，每页 10 条，支持 query/source/offset。搜索保留上游 `window_id`，修改关键词或来源清空窗口；上游重置窗口时遵循返回的 offset。
- 详情：`GET /api/v2/memories/:id`，保留每条记忆的 kind/variant 命名空间，展示全文、来源与时间，不显示原始 session 引用。

搜索与最近更新共用一个分页列表，空查询显示最近更新，有查询或来源筛选时标题显示「搜索结果 · N 条」；三项概览值使用一致字号字重；来源筛选位于搜索框内。时间使用「今天 03:30」「昨天 21:10」或「11-15 09:00」，省略秒。概览优先显示记忆的更新时间，回退到记忆时间或创建时间。整理状态来自处理队列的暂停/阻塞、运行和等待状态。正文以纯文本展示，不执行 HTML 或 Markdown。没有记忆写入、删除、图谱、应用或设置操作。

## 验证与 Desktop 复核

聚焦测试验证桌面 RPC、认证、确认流程、密钥持久化与清除、脱敏、MemHub 搜索窗口和 SSH 转发生命周期。预览命令使用导出的真实 Desktop 主题和隔离假数据。

```sh
node tools/ui-preview/capture-hubs.mjs /path/to/codex-desktop.css /tmp/codexhost-hubs-preview
```

Desktop 实机验证包括首屏连接提示、断开后的恢复、长列表、明暗外观、Tab 与 Escape 焦点恢复。MCPHub 管理写操作使用具备认证的测试实例验证。
