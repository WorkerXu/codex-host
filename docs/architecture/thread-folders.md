# 对话工作文件夹

工作文件夹属于对话，独立于项目。侧栏使用 Desktop 原生项目；跨机项目镜像创建目录、原生远程项目并打开新对话。

## 选择与显示

Composer 上方的「工作文件夹」显示主要目录的末级名称和额外目录数。弹窗显示当前目录、尚未选择的项目目录和该机器最近使用的目录。菜单对勾多选，选择即时保存；「设为主要」把目录移到第一位，始终保留至少一个目录。目录按顺序保存，第一项就是 `cwd`。

本机点击「添加文件夹…」调用 Desktop 的 `appServices.fileAttachments.pickFiles({kind:"directory", allowMultiple:true, pickerTitle:"选择工作文件夹"})`，打开系统目录选择框，按返回的 `fsPath` 一次加入多个文件夹。通过已加载模块中的原生服务发现该接口，不直接访问 Electron；Desktop 把单个服务暴露为可调用的 RPC stub，但承载它们的 `appServices` 注册表必须是普通对象。可调用的 transport root（`appHost`）对任意属性读取都返回函数，不能当作注册表，否则同一窗口会匹配到两个服务对象并让发现失败。取消选择保留主列表；接口缺失、调用失败或返回格式不可用时退回目录浏览子视图。异步选择返回后，对话已切换或菜单已关闭时丢弃结果。此调用不创建或激活 Desktop 项目。

远程机器始终使用目录浏览子视图，顶部提供返回箭头、绝对路径输入及原生小号主按钮「添加」。列表仅显示当前路径的子文件夹名，点击子目录进入该目录；回车或点击「添加」保存当前路径后返回主视图。Esc 先返回主视图，再次 Esc 关闭弹窗。弹层高度最多为 `min(420px, 视口高度 - 120px)`，内容在内部滚动，浏览视图的路径栏保持可见。目录元数据和列表始终通过所选 Host 的 `fs/getMetadata`、`fs/readDirectory` 获取，浏览不创建目录。Mac 路径不会拿到远程机器上解析。列表过滤为目录并隐藏以 `.` 开头的目录，异步浏览丢弃过期结果。

鼠标、Tab、空格、Enter 和 Esc 使用真实 DOM 控件，上下方向键和 Home / End 导航菜单。Esc 关闭弹窗并把焦点交回触发按钮。Popover 随内容尺寸重新定位，保持在视口内。保存期间禁用编辑；切换对话后，旧异步回复不能更新新对话的控件。

已有对话显示最近一次「工作文件夹已改为 …」提示。提示使用居中细分隔线，显示目录名和主要标记，完整路径放在 title。提示放在当前对话最后一个原生 `[data-turn-key]` 后；无法识别 transcript 容器时放在 Composer 前。Host 保留最多 100 条变更记录，重新加载后恢复最近一条提示。

## 原生 Codex 请求

- 环境与运行时工作目录接口需要 `initialize.capabilities.experimentalApi`。Desktop 连接保留客户端原始的能力协商参数；Host 自有的私有客户端在初始化时声明该能力。
- 新对话设置 `thread/start.cwd` 为主要目录、`runtimeWorkspaceRoots` 为所有目录；原请求的 `projectId`、权限和其他字段保留。
- Renderer 的草稿选择按 `hostId + client-new-thread ID` 隔离。原生创建通过单次调用的 ThreadCreation 参数和 request client 传递目录；主进程 RPC 创建改写同一个草稿 `startConversation` 输入的 `cwd` 与 `workspaceRoots`（`runtimeWorkspaceRoots` 只是 `thread/start` 参数，不能用于该输入）。选择后清理预热池，消费时拒绝不匹配目录的旧预热。
- Host 私有参数 `codexhostWorkingFolders` 在转发给 Codex 前移除。Desktop 已提供的 `cwd + runtimeWorkspaceRoots` 也保存为初始选择。
- 已有对话的下一次 `turn/start` 从 `thread/read.thread.environments` 读取当前 `environmentId`。该环境置于首位，更新 `cwd + runtimeWorkspaceRoots`，保留其他环境；不猜环境 ID。对话未加载、环境 ID 不可读时，拒绝提交并提示重新打开对话。
- 每轮都覆盖 Desktop 可能附带的旧 `cwd`。选择变化时，在下一轮 input 追加一行简短说明；输入附件和其他文本保留。
- 仅在 start/turn 的成功回复后记录 `appliedFolders`。失败重试仍带说明；持久化错误不会把已接受的原生请求变成缺失回复。

Desktop 按 Thread ID 分配项目。目录改写不迁移项目，也不直接写 `.codex-global-state.json`。

## 从代码仓库添加

工作文件夹菜单提供「从仓库添加…」，弹窗按 GitHub / GitLab 分页签展示自己的仓库首屏（最多 20 项），包含目录名、命名空间、简短说明和最近活动日期。搜索由服务端执行，输入期间旧结果立即清除，过期回复丢弃；Tab、上下方向键、Home / End 和 Enter 可选择仓库。GitHub 通过 Mac 的 `/opt/homebrew/bin/gh api` 读取 `user/repos?affiliation=owner&sort=pushed&direction=desc&per_page=20`，搜索限定已登录用户；GitLab 固定使用 `https://gitlab.xianghuanji.com/api/v4/projects?membership=true&order_by=last_activity_at&per_page=20&search=`。仓库地址由 Host 已读取的列表取得，Renderer 提交仓库 ID，不接受任意克隆 URL。

目标机器沿用当前对话的 Host。本机默认克隆位置为 `~/Downloads`；选中仓库后通过 `appServices.fileAttachments.pickFiles({kind:"directory", allowMultiple:false, pickerTitle:"选择克隆位置"})` 选择父目录，「更改位置…」可重新打开，接口不可用才退回目录子视图。该 Desktop 接口没有已核验的 `defaultPath` 参数，因此应用的默认目标为 Downloads，系统窗口的初始位置沿用 Desktop / 系统状态。远程默认 `~/projects`（缺少时创建），通过 Mac 使用现有 peer SSH alias 读取子目录，复用同一个目录浏览子视图；进入目录、路径输入、内部滚动和 Esc 返回一致。不会在服务器上调用本机文件夹选择器。

所有 GitHub、GitLab 与 git 网络访问均发生在 Desktop 所在的 Mac。Mac 先在临时目录克隆；本机目标复制完整 checkout，远程目标使用包含 `.git` 的 tar 包经 Mac 已配置 peer 的 SSH 连接传输。最终地址为 `<所选父目录>/<仓库目录名>`，保留原始 `origin`，远程解包不沿用 Mac 的文件所有者，文件归接收用户所有。状态按列出、克隆、传输、完成显示；成功保存工作文件夹后显示结果确认。克隆失败、无权限、连接失败均只返回固定错误码，由 Renderer 显示中文说明，不透传子进程输出。

预检查发现目标已经存在时，不启动克隆，也不改动目标；弹窗要求选择其他位置，或明确选择「使用已有文件夹」。后者只把经过验证的目录加入对话，不覆盖、不执行克隆。空目录、非空目录和文件均不直接覆盖；文件不能作为工作文件夹加入。最终创建还使用独占 mkdir，防止预检查后的竞态覆盖。操作产生的临时 checkout、askpass 脚本和传输包在成功/失败后清理；传输失败只清理本次独占创建的远程目录。

通用设置的「代码仓库」与「模型服务」使用同一卡片 / 行组件。GitHub 只读显示 `gh` 的登录用户。GitLab 访问令牌需要 `read_api`、`read_repository`，提供测试、更换、清除；Mac Host 原子写入 `~/.config/codexhost/gitlab-token`（0600），公开状态只含 configured 和末四位，不返回令牌。GitLab HTTPS 克隆使用一次性 `GIT_ASKPASS` 脚本与该次 git 子进程的环境，令牌不进入远程 URL、git 参数、`.git/config` 或 SSH 传输环境。令牌输入在保存、取消或卸载时清空。

已知网络限制：复制到服务器的 GitLab 仓库保留原始 GitLab origin；服务器无法访问内网 GitLab 时，不能自行 fetch / pull / push。本功能不把 Mac 令牌同步到服务器，也不改变服务器网络。远程传输需要该 peer 可执行 `python3`、`tar`。

## 持久化与 Harness

每个执行 Host 在 `${CODEXHOST_DATA_DIR:-~/.codexhost}/thread-folders/` 保存自己的选择，因此 Host 文件系统加 Thread ID 构成命名空间。文件名是 Thread ID 的 SHA-256，内容包含 `folders`、`appliedFolders`、`changedAt` 和变更记录。写入通过临时文件与 rename 原子替换，最近目录来自同一 Host 的记录。旧项目组文件不读取、不迁移、不删除。

外部 Harness 在下一轮开始前重新打开同一个 Native Session。运行中的轮次或后台工作不会被目录切换打断；恢复沿用 native ref、配置与历史映射。原 Mapping Store 的 cwd 保留原生会话定位语义，加载的 Thread 使用当前执行 cwd。目录变化后的 resume 同时带上原目录 `previousCwd`，让按历史目录校验归属的 Adapter（如 CodeBuddy）接受旧历史；恢复失败只回中文说明，不透传 Adapter 的原始英文错误。

Adapter 通过可选 `additionalDirectories` 能力声明原生额外目录支持。Claude Code 将额外目录传到官方 SDK 的 `additionalDirectories`（原生 `--add-dir` 语义），Broker 也传递这些原生选项。其他 Adapter 使用主要目录；chip tooltip 和弹窗说明这一限制，发送给 Harness 的变更说明只列有效目录。

Host 回答目录能力前等待安装的 Harness 插件加载完成，避免远程首次读取时把尚未加载的 Claude Code Adapter 误判为仅支持主要目录。插件不可用时不会硬编码声称具有能力。

## Desktop 绑定边界

Host 的环境和目录列表是执行层事实。当前没有已核验的 `thread-writable-roots` / applied workspace cwd 写接口，因此不直接改写这些 Desktop 私有持久化 atom。Desktop 的文件浏览器、diff 面板可能暂时保留旧根目录；重新打开对话后的根目录显示需要在真实 Desktop 验证。

跨机器目录不迁移项目。执行主机由 Composer 的机器选择决定，工作文件夹只改写该对话的 `cwd` 与环境根目录。Desktop 的新对话归属按执行主机选择项目：执行主机为本机时只登记本机项目（`projectKind: "local"`）或不登记，远程项目只在项目主机与执行主机一致时登记。`readMemberships()` 返回 `{assignments, projectlessThreadIds}`，远程归属带 `hostId`。侧栏项目分组按 `projectKind + projectId` 收集对话 ID，但只显示项目主机上的对话行；只读核对中把本机对话登记到远程项目后，该对话仍列在「对话」列表而不出现在项目下。因此在另一台机器上选择工作文件夹后，对话只会归入该机器的同名本机项目或无项目；跨机器保留原项目需要 Desktop 支持按项目聚合多主机对话，当前版本没有可用接口，不写入这种归属。

同主机与跨主机委派均保留来源 Thread 和显式项目选择，由 Mac Renderer 调用 Desktop 的 `appServices.threadProjectAssignments.readMemberships()` 读取父归属，再调用 `setMembership({hostId, threadId, assignment, projectless})` 登记子归属。`hostId` 是子对话执行主机；`assignment` 保留父分配中的 `projectKind`、`projectId`、远程项目的 `hostId` 和可选 `projectOrigin`。这些字段与调用形状已通过 Mac Desktop 的只读 CDP 数据和已加载原生调用点核对。服务不可用、写入失败或父分配尚未加载时保留记录并重试；显式无项目使用 `assignment:null, projectless:true`，已有人工归属（包括无项目）不被覆盖。不直接改写全局状态文件。跨主机子对话即使写入了父项目的远程归属，也受上面的项目聚合规则限制，仍列在「对话」列表。

## 相关验证

聚焦测试覆盖 start/turn 改写、环境优先级、`projectId` 保留、持久化隔离、失败重试、草稿并发隔离、委派项目继承，以及 app-server Host 路径。Playwright 使用真实鼠标/键盘覆盖多选、主要目录、目录补全、提示、Esc、点击外部关闭和最后一个目录保护。预览入口为 `thread-folders-local|remote|existing|limited`，截图清单见 [界面验收记录](../../tools/ui-preview/thread-folders-review.md)。

手动远程校验（先运行 `npm run build:typescript`）：

```sh
node tools/thread-folders-check.mjs --host <SSH别名> --cli <远程codex路径>
```

该脚本使用一次模型轮次，在远程 `~/.cache/codexhost-folder-probe-<UUID>` 创建两个随机临时目录（避开 sandbox 默认可写的 `/tmp`），通过 `thread/start` 创建 `ephemeral: true`、`workspace-write` 的对话，要求写入第二根目录，检查唯一标记并清理目录。需要目标机已登录 Codex。它不读取 codexhost runtime 目录，不修改用户项目。
