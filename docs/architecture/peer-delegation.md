# SSH peer 委派

每台机器通过 `~/.codexhost/peers.json` 配置自己的 peer。文件沿用 fork 的
`formatVersion: 1`、`peers` 和 `self.hostIds`。peer 使用 SSH 配置中的别名，可指定对端
`codexhost` 的绝对路径以及 Desktop Host ID。用 `codexhost peer list|add|remove|test|self`
查看、管理和验证配置。

`delegate start`、`harness list|inspect` 和 `thread read|send|cancel|wait|watch|answer`
接受 `--host`。已配置的 peer 经 SSH 调用对端 Launcher 的 `peer-exec`，self Host ID 使用本机
Runtime。`thread read` 遇到只在 Desktop 中登记的 Host ID 时，使用现有的 Desktop 远程连接。已发送到
peer 的命令返回该路径的结果或错误。Thread 链接中的 `hostId` 供后续命令自动选路。

`peer-exec` 从 stdin 接收有大小限制的 JSON，并只接收登记的 Runtime 路由。SSH 只携带调用内容，
对端进程使用对端用户的本机控制端点。远程 worktree 由目标 Host 创建，要求目标机器上的绝对
`--cwd`。跨机器任务的来源与本机 Thread ID 分开，避免目标机器把调用方 ID 当成自己的父 Thread。

远程 watch 在调用方 Host 注册并读对端的 Thread，向本地 Thread 或外部客户端发送一条带 Host ID 的
通知。用 `thread watch <thread> --host <peer> --cancel` 取消指定通知目标的 watch。
远程 watch 使用进程内状态，本地 watch 沿用上游的持久化和恢复机制。

`harness list --availability true` 报告安装后的可用性，并可加 `--refresh true` 重新探测。
`~/.codexhost/cache/harness-availability.json` 保留已就绪和未安装状态 24 小时，临时失败 10 分钟。
插件指纹变化或启动失败会使旧探测结果失效。Desktop 的插件目录请求可以选择读取新鲜状态，交互式
Model 和权限模式配置由实时 Harness 检查确认。

## Desktop 的跨机器派发

在 Desktop Composer 输入 `#`，可以按机器选择已安装且就绪的 Harness。同一名字的
Harness 在不同机器上是独立目标。菜单优先采用 Desktop 的机器显示名，连接异常的
机器显示一行「连接超时」或「连接失败」。打开菜单时查询当前会话所在 Host 的 peer
目录。后台重新查询复用对端磁盘上的 Harness 可用性缓存。

选择目标后插入原生 Agent 提及。发送时由 Host 改写成带 `--host`、`--harness`、
`--watch true` 和 `--format compact` 的 `codexhost delegate start` 命令，填入任务名和
任务后即可执行。子会话通过 Desktop 的项目归属服务继承父会话的项目。用
`--project <projectId>` 指定归属或用 `--project none` 设为无项目。

## 后续功能接入

- T2 可复用 `DesktopProjectCatalogReader` 查询 Mac 本机项目和 Thread 分配。
- T2、T3、T4 各自在 Host Runtime 注册独立的 `codexhost/<feature>/` 方法，在
  `shared-contracts` 导出对应请求和结果。Desktop 入口通过 `AppServerHost.#handleDesktopRequest`
  及 `#dispatchDesktopReply` 寻址和回包。设置页在 `createDefaultRendererSettingsPages`
  注册 `RendererSettingsPageDefinition`，使用页面作用域清理请求与订阅。
- T6 保留 Thread 原生创建和发送入口，适配各 Harness 的目录参数。需要 Desktop 项目上下文时复用目录
  只读 RPC。
- T7 使用 Host 侧的 peer 配置、目录和传输，新增 Web 的受认证派发入口。现有 Desktop peer RPC 和
  标准 Web Thread 列表维持各自的调用边界。
