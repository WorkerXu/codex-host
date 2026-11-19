# Hub 管理页

工作台在钉钉、智能体和 Jarvis 之后提供「MCP 服务器」与「记忆」两个独立页面。列表、筛选和概览留在页面内，编辑、详情与危险操作使用原生 `dialog`。页面使用现有设置页的字体、颜色与控件样式。

## 连接与所有权

Renderer 每次请求按选定的 Host ID 调用 `__codexhostHostRoutingV1.forHost(hostId).manager.sendRequest`，方法为 `codexhost/hub-admin/request`。连接不可用时直接报错，不回退到本机或当前 Composer 的主机。两个页面默认匹配显示名或 ID 为 `oracle-main` 的连接；显示名不同或服务在别的主机时需手动选择。

Host Runtime 的 `HubAdminService` 校验共享契约中的操作枚举和严格参数，再调用固定的 localhost 地址。请求不能携带目标地址、HTTP 方法、任意路径或任意配置字段；不新增端口、隧道或公共端点。HTTP 禁止重定向，单次请求超时 8 秒。上游异常文本和校验错误不进入 RPC 或诊断日志；错误码在页面映射为「连接超时」「连接失败」「无权限」「服务未运行」等中文提示。

## MCPHub

服务位于 Host 的 `127.0.0.1:3000`，使用 MCPHub 官方管理 REST API：

| 操作 | REST 路径 |
| --- | --- |
| 服务器列表 | `GET /api/servers` |
| 编辑所需原配置、只读工具列表 | `GET /api/servers/:name` |
| 添加、编辑、删除、启停 | `POST /api/servers`、`PUT/DELETE /api/servers/:name`、`POST /api/servers/:name/toggle` |
| 密钥列表、创建、编辑、删除、重新生成 | `GET/POST /api/auth/keys`、`PUT/DELETE /api/auth/keys/:id`、`POST /api/auth/keys/:id/reset` |
| 认证状态、认证头 | `GET /api/settings`、仅携带两项认证字段的 `PUT /api/system-config` |

用户在 MCPHub 网页后台创建专用管理员密钥，要求 `enabled=true`、`kind=system`、`accessType=all`（旧记录缺失 kind 时按原生系统级语义）。1.1.15 的管理 API 中间件拒绝用户级和受限范围密钥，验证通过时赋予管理员权限。Host 读取 `/etc/mcphub.env` 中的 `MCPHUB_SETTING_PATH`（默认 `/opt/mcphub/data/mcp_settings.json`），仅解析 routing 中的请求头名和认证策略；请求头默认 `Authorization`，值为 `Bearer <密钥>`。要求 Bearer 开启且 skipAuth 关闭，避免免认证请求误判密钥有效。Host 用户需要这些配置的只读权限。

未配置时页面显示「连接 MCPHub」，通过掩码输入框提交 `mcpConnect`；Host 用候选密钥只读请求 `GET /api/auth/keys`，成功后原子写入自己的 `~/.config/codexhost/mcphub-admin-key`，目录 0700、文件 0600。失败保留旧密钥。`mcpConnection` 和保存结果只返回 `configured`、`last4`；密钥不回传 Renderer、不进入日志。输入值提交或关闭时清空。主机选择旁菜单支持「更换密钥」「断开」，断开须确认且只删除该 Host 的本地密钥文件，不更改 MCPHub。权限失败显示「密钥无效或权限不足」并提供更换入口。

认证凭据只用于 Host 到 localhost 的请求。Renderer 收不到管理员密码、哈希、JWT、原密钥或原服务器连接配置。列表密钥统一显示掩码；创建和重新生成的密钥按官方 API 返回值仅在一次性对话框展示并允许复制，关闭时清空控件。编辑服务器时连接字段留空保留原值，填写则替换该项；参数和环境变量使用 JSON 数组/对象，请求头使用键值行编辑器，保存前检查名称、重复项和换行，并在字段下方显示中文错误。Host 合并原生未知配置，协议切换清理不适用的连接字段。

支持流式 HTTP、SSE、stdio 的新建与编辑。保留其他协议的列表显示，操作菜单不提供编辑。密钥范围支持全部、排除所选服务器、仅所选服务器；原生用户级密钥或含组范围的密钥可以查看、删除、重新生成，但禁止用简化编辑器改写其范围。

服务器状态映射为在线、离线、未激活、禁用，并显示工具、提示词和资源数量。列表 API 不提供调用总量时，页面隐藏该字段。状态、协议和版本用中点分隔；禁用卡片内容淡化，开关仍可操作。点击卡片打开工具详情；启停使用开关，编辑、删除收在卡片操作菜单。Bearer 认证采用设置行与开关，请求头在单独对话框编辑；密钥行的操作收在菜单中。删除服务器、禁用服务器、删除密钥、重新生成密钥、关闭 Bearer 认证均须确认；相应 RPC 校验确认标记。

## MemHub

服务位于 oracle-main。Host 读取当前用户的 `~/.one-memory/runtime-token`，仅通过 `127.0.0.1:8765` 调用 Core API；不读取 codexhost runtime 目录，不经过 18765 runtime API，也不向 Renderer 回传 token。

- 概览：`GET /api/v2/home-summary`、`GET /api/v1/memory-processing`、最近 4 条的 `GET /api/v2/memory-library`、`GET /api/v1/sources`。
- 列表与搜索：`GET /api/v2/memory-library`，固定 `scene=all`，每页 10 条，支持 query/source/offset。搜索保留上游 `window_id`，修改关键词或来源清空窗口；上游重置窗口时遵循返回的 offset。
- 详情：`GET /api/v2/memories/:id`，保留每条记忆的 kind/variant 命名空间，展示全文、来源与时间，不显示原始 session 引用。

搜索与最近更新共用一个分页列表，空查询显示最近更新，有查询或来源筛选时标题显示「搜索结果 · N 条」；三项概览值使用一致字号字重；来源筛选位于搜索框内。时间使用「今天 03:30」「昨天 21:10」或「11-15 09:00」，省略秒。概览优先显示记忆的更新时间，回退到记忆时间或创建时间。整理状态来自处理队列的暂停/阻塞、运行和等待状态。正文以纯文本展示，不执行 HTML 或 Markdown。没有记忆写入、删除、图谱、应用或设置操作。

## 验证与 Desktop 复核

聚焦测试覆盖 RPC 截获、严格白名单、确认标记、Host 密钥隔离、0600 原子替换、只读验证后保存、验证失败保留旧值、投影脱敏、配置保留、错误映射、搜索窗口和命名空间。`tools/ui-preview` 的 `hub-*` 场景使用隔离假数据；capture runner 通过真实鼠标和键盘执行筛选、输入、打开对话框及确认，分别输出 light/dark 截图。设置 `CODEX_PREVIEW_NATIVE_THEME=1` 与 `CODEX_DESKTOP_CSS` 后，预览直接加载导出的 Desktop CSS，并禁用静态浅色 token 与近似深色覆盖；报告标记为真实主题变量。下拉菜单、悬停、键盘焦点、表单错误与只读详情均有场景，最终仍需在真实 Desktop 窗口复核。

真实 Desktop 需核对：连接列表里的 oracle-main 是否选中正确 Host、断连时是否留在正确页面、长列表滚动、明暗外观、Tab/Escape 的焦点恢复，以及原生连接上自定义 RPC 的往返。MCPHub 管理写操作需在具备认证的测试实例验证；生产排查只读，不能用截图假数据的成功替代生产验证。
