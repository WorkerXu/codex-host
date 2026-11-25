# fork 与上游 v0.26.0-rc.1 的差异

当前迁移底座直接基于上游 `v0.26.0-rc.1`，保留关闭自更新与启动器进程树修复，并新增一项通用的 Web 扩展提及接口。除这些差异外，不迁移旧 fork 的插件、业务入口或特定 `@` 提及实现。

## codexhost 自身更新

fork 由维护者同步上游版本。唯一构建开关位于 [`fork-self-update.json`](../../packages/shared-contracts/src/fork-self-update.json) 的 `enabled`，当前为 `false`。TypeScript 的 `FORK_SELF_UPDATE_ENABLED`、Rust 平台常量、npm 启动脚本和 Android 的构建常量均读取这份配置。

Desktop 和 Web 的更新页只提供本版公告。Console 隐藏更新入口，保留公告。托盘和 Android 隐藏检查更新，并停止自动检查。远程连接卡片展示连接及已安装版本，保留检测和修复。会从 npm 下载官方包的远程「安装并连接」与升级入口关闭。使用已由维护者安装的 fork 运行 `codexhost remote install` 仍可配置远程服务。

`codexhost update`、Host 更新 RPC、Console 和 Web 的更新 API、Rust updater 的本机及远程安装请求均返回禁用结果。后台跳过最新版本检查、更新包准备和已排队的更新交接。Windows 安装包的手动安装准备助手、Harness CLI 的版本检查及更新、插件更新和当前版本的公告照常使用。

rc.1 新增的 Linux `.tar.gz` 更新同样经过 Host／Console 的更新协调器和 Rust updater，因此受同一开关约束。Web 的 Peer Hub 只转发 Thread 和 workspace 操作，不暴露 codexhost 更新 RPC。

## Web 扩展提及

Host 扩展清单可声明 `mentions` 来源，后端提供 `mentions/search`、`mentions/cancel` 和 `mentions/expand`。Web 的 `@` 菜单按来源分组展示候选，插入带扩展、来源、条目和显示名的 Markdown 提及记号；原生 Codex 与外部 Harness 的发送都由 Host 在提交前调用对应后端，将记号整体替换为文字。

该能力只注册在 Web 输入框，Desktop 渲染层保持上游原样。扩展停用、卸载、后端不可用、展开失败或超过大小上限时整轮发送失败并保留草稿，不会发送原始记号或部分内容。Peer Hub 远程 Thread 不使用此能力。契约、token 格式和限制见 [`desktop-ui-extensions.md`](../architecture/desktop-ui-extensions.md#web-扩展提及mentions)。
