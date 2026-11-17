# 委派子会话命名

通过 `codexhost delegate start` 创建的子 Thread 默认命名为“子任务名 · 父会话名”，适用于原生 Codex 和外部 Harness。名称在创建时写入；父会话后来改名、子会话续聊或幂等重试都不联动改名，用户仍可手动重命名已有子会话。

```sh
codexhost delegate start --harness example --task-name "协议审查" --task "完整任务说明" --parent-thread <parent>
```

`--task-name` 是独立的显示名称，去除首尾空白后不能为空，输入长度不超过 120 个 UTF-16 代码单元；不传时使用任务正文第一行并截断至 120 个代码单元。任务正文原样投递，不增加命名提示。委派 Skill 提示调用方为新子会话提供简短的 `--task-name`。

父会话优先使用已保存标题；原生 Codex 通过不含 turns 的元数据读取 `name`，缺失时使用 `preview`。标题不可读取或为空时使用 `Untitled Thread`，不因此阻断任务。标题中的连续空白压成空格；完整名称最多 200 个代码单元，子任务名在前，侧边栏从末尾截断时同一父会话的子任务仍可区分；父标题过长时截断父标题，且不截断代理对。

原生 Codex 先通过 `thread/name/set` 保存名称，再开始任务；名称只用于展示，命名失败时保留默认标题，任务照常投递。外部 Harness 使用既有的 Thread 映射存储，在 Session 创建前保存标题。

显示名称不参与任务执行去重；同一 `request-id` 重试仍返回原子会话及原名称。此规则不修改历史子会话，也不控制 Harness 在内部自行创建的原生子 Agent。


## 对话项目归属

`delegate start` 默认继承发起对话的项目，与子对话 `--cwd` 无关。未显式指定 `--cwd` 时，使用父会话当前主工作文件夹。`--project <projectId>` 显式指定项目，`--project none` 创建无项目子对话；显式选择优先于继承。同机原生 Codex 在 `thread/start` 携带 `projectId`，外部 Harness 把它保存在 Thread metadata。

跨机的项目 ID 属于 Desktop，不能当作目标机器 app-server 的项目 ID。Host 将来源 Host、来源 Thread 和显式项目选择保存在委派记录中，Renderer 通过 Desktop 的 Thread 项目分配服务登记；服务未就绪时保留记录并重试。已有人工作出的子对话归属不被覆盖。

工作文件夹、持久化与真实 Desktop 绑定限制见 [对话工作文件夹](thread-folders.md)。
