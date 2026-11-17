# 对话工作文件夹

工作文件夹属于对话，独立于项目。侧栏使用 Desktop 原生项目；跨机项目镜像创建目录、原生远程项目并打开新对话。

## 选择与显示

Composer 上方的「工作文件夹」显示主要目录的末级名称和额外目录数。弹窗显示当前目录、尚未选择的项目目录和该机器最近使用的目录。菜单对勾多选，选择即时保存；「设为主要」把目录移到第一位，始终保留至少一个目录。目录按顺序保存，第一项就是 `cwd`。

「添加文件夹…」切换到目录浏览子视图，顶部提供返回箭头、绝对路径输入及原生小号主按钮「添加」。列表仅显示当前路径的子文件夹名，点击子目录进入该目录；回车或点击「添加」保存当前路径后返回主视图。Esc 先返回主视图，再次 Esc 关闭弹窗。弹层高度最多为 `min(420px, 视口高度 - 120px)`，内容在内部滚动，浏览视图的路径栏保持可见。当前没有已核验的 Desktop 原生文件夹 picker 绑定，使用路径输入方式；控件为原生 picker 保留可选回调。目录元数据和列表始终通过所选 Host 的 `fs/getMetadata`、`fs/readDirectory` 获取，浏览不创建目录。Mac 路径不会拿到远程机器上解析。列表过滤为目录，异步浏览丢弃过期结果。

鼠标、Tab、空格、Enter 和 Esc 使用真实 DOM 控件，上下方向键和 Home / End 导航菜单。Esc 关闭弹窗并把焦点交回触发按钮。Popover 随内容尺寸重新定位，保持在视口内。保存期间禁用编辑；切换对话后，旧异步回复不能更新新对话的控件。

已有对话显示最近一次「工作文件夹已改为 …」提示。提示使用居中细分隔线，显示目录名和主要标记，完整路径放在 title。提示放在当前对话最后一个原生 `[data-turn-key]` 后；无法识别 transcript 容器时放在 Composer 前。Host 保留最多 100 条变更记录，重新加载后恢复最近一条提示。

## 原生 Codex 请求

- `initialize.capabilities.experimentalApi` 开启环境与运行时工作目录接口。
- 新对话设置 `thread/start.cwd` 为主要目录、`runtimeWorkspaceRoots` 为所有目录；原请求的 `projectId`、权限和其他字段保留。
- Renderer 的草稿选择按 `hostId + client-new-thread ID` 隔离。原生创建通过单次调用的 ThreadCreation 参数和 request client 传递目录；主进程 RPC 创建改写同一个草稿的 `startConversation` 输入。选择后清理预热池，消费时拒绝不匹配目录的旧预热。
- Host 私有参数 `codexhostWorkingFolders` 在转发给 Codex 前移除。Desktop 已提供的 `cwd + runtimeWorkspaceRoots` 也保存为初始选择。
- 已有对话的下一次 `turn/start` 从 `thread/read.thread.environments` 读取当前 `environmentId`。该环境置于首位，更新 `cwd + runtimeWorkspaceRoots`，保留其他环境；不猜环境 ID。对话未加载、环境 ID 不可读时，拒绝提交并提示重新打开对话。
- 每轮都覆盖 Desktop 可能附带的旧 `cwd`。选择变化时，在下一轮 input 追加一行简短说明；输入附件和其他文本保留。
- 仅在 start/turn 的成功回复后记录 `appliedFolders`。失败重试仍带说明；持久化错误不会把已接受的原生请求变成缺失回复。

Desktop 按 Thread ID 分配项目。目录改写不迁移项目，也不直接写 `.codex-global-state.json`。

## 持久化与 Harness

每个执行 Host 在 `${CODEXHOST_DATA_DIR:-~/.codexhost}/thread-folders/` 保存自己的选择，因此 Host 文件系统加 Thread ID 构成命名空间。文件名是 Thread ID 的 SHA-256，内容包含 `folders`、`appliedFolders`、`changedAt` 和变更记录。写入通过临时文件与 rename 原子替换，最近目录来自同一 Host 的记录。旧项目组文件不读取、不迁移、不删除。

外部 Harness 在下一轮开始前重新打开同一个 Native Session。运行中的轮次或后台工作不会被目录切换打断；恢复沿用 native ref、配置与历史映射。原 Mapping Store 的 cwd 保留原生会话定位语义，加载的 Thread 使用当前执行 cwd。

Adapter 通过可选 `additionalDirectories` 能力声明原生额外目录支持。Claude Code 将额外目录传到官方 SDK 的 `additionalDirectories`（原生 `--add-dir` 语义），Broker 也传递这些原生选项。其他 Adapter 使用主要目录；chip tooltip 和弹窗说明这一限制，发送给 Harness 的变更说明只列有效目录。

## Desktop 绑定边界

Host 的环境和目录列表是执行层事实。当前没有已核验的 `thread-writable-roots` / applied workspace cwd 写接口，因此不直接改写这些 Desktop 私有持久化 atom。Desktop 的文件浏览器、diff 面板可能暂时保留旧根目录；重新打开对话后的根目录显示需要在真实 Desktop 验证。

跨机委派的项目归属通过 Renderer 的 `threadProjectAssignments.assign({hostId, threadId, project})` 服务绑定登记。服务不可用或调用失败时，Host 上的委派归属记录保留，Renderer 后续刷新重试；不改写全局状态文件。这个私有服务的实际导出和签名需要在目标 Mac Desktop 核验，预览页面不证明绑定存在。

## 相关验证

聚焦测试覆盖 start/turn 改写、环境优先级、`projectId` 保留、持久化隔离、失败重试、草稿并发隔离、委派项目继承，以及 app-server Host 路径。Playwright 使用真实鼠标/键盘覆盖多选、主要目录、目录补全、提示、Esc、点击外部关闭和最后一个目录保护。预览入口为 `thread-folders-local|remote|existing|limited`，截图清单见 [界面验收记录](../../tools/ui-preview/thread-folders-review.md)。

手动远程校验（先运行 `npm run build:typescript`）：

```sh
node tools/thread-folders-check.mjs --host <SSH别名> --cli <远程codex路径>
```

该脚本使用一次模型轮次，在远程 `~/.cache/codexhost-folder-probe-<UUID>` 创建两个随机临时目录（避开 sandbox 默认可写的 `/tmp`），通过 `thread/start` 创建 `ephemeral: true`、`workspace-write` 的对话，要求写入第二根目录，检查唯一标记并清理目录。需要目标机已登录 Codex。它不读取 codexhost runtime 目录，不修改用户项目。
