# 对话工作文件夹

工作文件夹按 Thread 保存，顺序的第一项是主要目录。项目归属由 Desktop 项目及原生 Thread 记录决定。Desktop 的 Composer 在本机调用系统目录多选器，在远程通过对应 Host 浏览文件夹。本机目录选择器不可用时也可使用浏览视图。Web 的 Composer 提供工作文件夹编辑器，支持草稿和已有会话。Web 在部署机器上浏览目录，只访问该机器共享 Host 的会话。

## Host 记录与执行

`codexhost/thread-folders/get` 返回已选目录、该 Host 的最近目录和当前 Harness 的额外目录能力。`codexhost/thread-folders/set` 更新已有 Thread。Web 通过 Host 客户端通道读写这两个方法，草稿保留在 Web 会话中，首次发送时随 `thread/start` 交付。Desktop 的草稿选择按 Composer 和执行 Host 绑定，创建使用该草稿的 `cwd` 和工作根目录。目录选择变更后清理旧预热，创建时核对草稿身份。

主机使用共享数据目录下的 `thread-folders/`，文件名是 Thread ID 的 SHA-256。记录沿用 `folders`、`appliedFolders`、`changedAt` 和 `notes`。读写按执行 Host 隔离。写入用锁和原子替换，选择变化保留最多 100 条提示。正在执行的 Turn 继续使用原目录，下一次普通 Turn 使用最新已保存选择。成功接收的 Turn 才更新应用状态。并发编辑时，接受旧轮次的结果只更新应用状态，保留新选择。

官方 Codex 以 `thread/start.cwd` 和 `runtimeWorkspaceRoots` 创建 Thread，沿用上游的 account scope、原生项目字段和初始化协商。在 `turn/start` 中使用真实环境 ID 设置 `cwd` 和当前环境的 `runtimeWorkspaceRoots`，保留其他已提供的环境和输入。目录选择变化随下一轮输入附一条变更说明。环境 ID 由原生 `thread/read` 提供，读取失败时提示重新打开对话。

外部 Harness 在执行下一轮前通过已有恢复流程重新打开同一 Native Session。主要目录进入 Adapter 的 `cwd`，额外目录由声明支持的 Adapter 交给原生接口。Claude Code 使用 SDK `additionalDirectories`，含 Broker 路径。Antigravity 和 CodeBuddy 通过 ACP 进程的原生 `--add-dir` 参数传入额外目录，进程的 cwd 是主要目录。CodeBuddy 恢复时可用记录中的原目录核验历史。当前未声明额外目录能力的 Adapter 使用主要目录，界面会显示该能力。

## 从代码仓库添加

Mac Desktop 可通过工作文件夹菜单浏览 GitHub、GitLab 仓库，选择本机或会话所属 SSH 主机的目标目录。GitHub 使用本机 `gh` 登录，GitLab 使用通用设置里的访问令牌。仓库列表由 Mac Host 获取，客户端以列表中的仓库 ID 请求克隆。Git 操作在 Mac 上进行，远程结果通过 Desktop 已配置的 SSH 连接传输完整 checkout，包含原始 `.git`。目标存在时可更换目标或选择已有文件夹，克隆和传输用独占目录保护目标。

GitLab 令牌由 Mac 本机设置 RPC 接收，保存在 `~/.config/codexhost/gitlab-token`，权限为 `0600`。设置返回配置状态和末四位。GitLab HTTPS 克隆以一次性 askpass 进程环境提供令牌，传输包只包含 checkout。Web 客户端通道只提供工作文件夹方法。旧 GitLab 令牌由原文件直接读取。

## 迁移与验证

Mac 使用现有共享 Host 数据根。SSH Desktop 和 Web 使用同一个共享数据根保存工作文件夹。若旧 SSH 数据根是 `~/.codexhost/remote/data`，由 T1 将原有 `thread-folders/` 带到选定的共享数据根，目录内记录格式保持兼容。

定向测试覆盖请求改写、已选目录持久化、并发确认、外部 Session 恢复、仓库克隆和 Web 草稿绑定。手动验收可以使用 `node tools/thread-folders-check.mjs --host <SSH 别名> --cli <远端 Codex 路径>` 检查第二根目录的实际写入。该命令使用原生 Codex 登录执行一轮，并清理本次创建的临时目录。
