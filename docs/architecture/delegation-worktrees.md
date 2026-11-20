# 委派子任务的独立 Git worktree

`codexhost delegate start --worktree <branch>` 在启动子任务前创建独立分支和 checkout。
CLI 将创建请求交给目标 Host，因此本地、SSH peer 和 watch 使用同一实现。
不指定 `--worktree` 时保持原有工作目录继承行为。

```bash
codexhost delegate start --harness claude-code --task "修复测试" \
  --cwd /absolute/repository --worktree task/fix-tests --base main --watch true
```

本地源目录是显式 `--cwd` 或 CLI 进程当前目录；不使用父线程隐含目录。
跨主机必须给出目标机器上的绝对 `--cwd`，例如 `--host oracle-main --cwd /home/ubuntu/project`。
创建在目标机器执行，调用机器不读取或创建该路径。HTTP 控制接口也要求显式绝对 cwd。

默认基线是源 checkout 的 HEAD，支持 detached HEAD；`--base` 可指定其他提交或 ref。
从 linked worktree 启动时保留它的 HEAD，但目标目录始终位于主仓库旁的
`<repo>.worktrees/<branch>`，分支中的斜线等非路径安全字符替换为连字符。
返回 `worktree.path`、`worktree.branch`、`worktree.base`（解析后的完整提交 ID），
完整 JSON 与 compact 输出都保留这些信息。

源目录的未提交修改不会复制。已有分支、已有目标目录（包括空目录或符号链接）、
非法分支或基线、非 Git 目录，以及 merge/rebase 或未合并索引状态都会被拒绝。
checkout 禁用 Git hooks，避免创建工作目录时意外执行仓库钩子。

创建后如果子任务启动失败，返回错误的 `details.worktree` 与 `worktreeRetained: true`。
连接或响应失败不证明任务未启动；先检查线程和保留目录，再决定是否重试。
重试相同分支不会覆盖它。合并、清理、依赖安装均为后续显式操作。

托管委派 skill 建议代码修改任务使用独立 checkout；分支名由调用 Agent 提供。
这不更改聊天线程的 Harness，也不引入会话切换、Web 客户端或 Relay。

验证：`packages/host-runtime/test/delegation-cli-worktree.test.ts` 经过真实控制服务器
验证 Git 状态、CLI 目录解析、失败保留；peer 测试验证创建请求在目标机器执行。
