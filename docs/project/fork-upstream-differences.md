# fork 与上游的差异

## Desktop 侧栏 Agent 图标

fork 默认关闭普通会话和定时任务侧栏的 Agent 图标。两类条目共用一个图标模块。关闭后跳过该模块的 DOM 观察和按 Host 的批量归属查询（`codexhost/thread/ownership/list`），缩短会话列表显示所需的工作。打开会话时，Composer 仍向所属 Host 查询会话归属。

[`fork-desktop-features.ts`](../../packages/renderer-extension/src/fork-desktop-features.ts) 中的 `FORK_DESKTOP_FEATURES.sidebarAgentIcons` 是 Desktop 构建开关。生产注入入口把它传给 `installRendererBindingProbe` 的 `sidebarAgentIcons` 参数。单独调用 Probe 并省略该参数时，按上游行为启用图标。

Desktop 兼容审计读取同一个构建开关。默认只检查 Fork 导航依赖的原生侧栏 Thread 身份，比较旧审计报告时忽略 `titleOwnerCount`。构建开关设为 `true` 时，审计也按上游规则检查行标题的归属。
