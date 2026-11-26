# fork 与上游 v0.26.1 的差异

当前迁移底座直接基于上游 `v0.26.1`（`a416aa48e`），保留关闭自更新与启动器进程树修复，并提供通用的 Web 扩展提及、侧栏面板分组和提及会话标题处理。旧 fork 的业务入口由独立的工作台插件提供，底座不包含钉钉、Jarvis 或 Magpie 的业务实现。

## codexhost 自身更新

fork 由维护者同步上游版本。唯一构建开关位于 [`fork-self-update.json`](../../packages/shared-contracts/src/fork-self-update.json) 的 `enabled`，当前为 `false`。TypeScript 的 `FORK_SELF_UPDATE_ENABLED`、Rust 平台常量、npm 启动脚本和 Android 的构建常量均读取这份配置。

Desktop 和 Web 的更新页只提供本版公告。Console 隐藏更新入口，保留公告。托盘和 Android 隐藏检查更新，并停止自动检查。远程连接卡片展示连接及已安装版本，保留检测和修复。会从 npm 下载官方包的远程「安装并连接」与升级入口关闭。使用已由维护者安装的 fork 运行 `codexhost remote install` 仍可配置远程服务。

`codexhost update`、Host 更新 RPC、Console 和 Web 的更新 API、Rust updater 的本机及远程安装请求均返回禁用结果。后台跳过最新版本检查、更新包准备和已排队的更新交接。Windows 安装包的手动安装准备助手、Harness CLI 的版本检查及更新、插件更新和当前版本的公告照常使用。

Linux `.tar.gz` 更新同样经过 Host／Console 的更新协调器和 Rust updater，因此受同一开关约束。0.26.1 的 npm 版本可用性检查与缓存预取也读取此开关，禁用时不运行 npm；Rust updater 在 npm 安装位置预检、服务停止和安装前拒绝更新请求。Web 的 Peer Hub 只转发 Thread 和 workspace 操作，不暴露 codexhost 更新 RPC。

## Linux 启动器进程监督

Linux 上仅凭进程组成员关系不能认定进程归启动器所有。无法归属到受监督根进程或已验证后代的 PID 被排除，对当前进程实例记录一次诊断；启动器不收养、不等待，也不向其发信号。已确认属于自身的进程继续接受正常监督和清理。Host、Web 后台服务的 stderr 分别追加到数据目录的 `logs/host-service.log`、`logs/web-service.log`，以保留这类诊断。上游的孤儿 Web 服务清理逻辑独立保留。

## Web 扩展提及

Host 扩展清单可声明 `mentions` 来源；`picker: true` 由扩展的 `web` 入口注册自绘浮层，支持同面板两步选择及原子批量插入。平铺来源保持兼容，搜索没有总时限，通过 `pending.cursor` 进行短调用续查，输入变化或关闭菜单会取消后台工作。每次后端处理必须在几秒内返回，上游 10 秒强杀规则保持不变。后端提供 `mentions/search`、`mentions/cancel` 和 `mentions/expand`。Web 的 `@` 菜单按来源分组展示候选，插入带扩展、来源、条目和显示名的 Markdown 提及记号；原生 Codex 与外部 Harness 的发送都由 Host 在提交前调用对应后端，将记号整体替换为文字。

该能力只注册在 Web 输入框，Desktop 渲染层保持上游原样。扩展停用、卸载、后端不可用、展开失败或超过大小上限时整轮发送失败并保留草稿，不会发送原始记号或部分内容。Peer Hub 远程 Thread 不使用此能力。契约、token 格式和限制见 [`desktop-ui-extensions.md`](../architecture/desktop-ui-extensions.md#web-扩展提及mentions)。

上游 0.26.1 的远程 Peer 文件 `@` 补全继续使用自己的文件接口，与扩展提及来源并存。

## 带提及的会话标题

Web 首轮消息含扩展提及时，标题模型接收提及的显示名和用户正文，不接收展开后的上下文或内部记号。模型未生成标题时，原生 Codex 与外部 Harness 均回退到显示文本；已有标题和用户手动修改的标题受原有并发检查保护。侧栏使用同一标题。

## Web 扩展面板分组

Web 扩展可为自己的 `main` 面板声明侧栏分组，并实时更新子项的计数徽标。宽栏支持持久化折叠状态，窄栏以弹出菜单提供相同入口。平铺面板保持原样；Desktop 渲染层和 Host 不参与。接口见 [Web 侧栏面板分组](../architecture/desktop-ui-extensions.md#web-侧栏面板分组)。
