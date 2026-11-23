# fork 与上游的差异

## Desktop 侧栏 Agent 图标

fork 默认关闭普通会话和定时任务侧栏的 Agent 图标。两类条目共用一个图标模块。关闭后跳过该模块的 DOM 观察和按 Host 的批量归属查询（`codexhost/thread/ownership/list`），缩短会话列表显示所需的工作。打开会话时，Composer 仍向所属 Host 查询会话归属。

[`fork-desktop-features.ts`](../../packages/renderer-extension/src/fork-desktop-features.ts) 中的 `FORK_DESKTOP_FEATURES.sidebarAgentIcons` 是 Desktop 构建开关。生产注入入口把它传给 `installRendererBindingProbe` 的 `sidebarAgentIcons` 参数。单独调用 Probe 并省略该参数时，按上游行为启用图标。

Desktop 兼容审计读取同一个构建开关。默认只检查 Fork 导航依赖的原生侧栏 Thread 身份，比较旧审计报告时忽略 `titleOwnerCount`。构建开关设为 `true` 时，审计也按上游规则检查行标题的归属。

## Codex Desktop 26.1117 兼容性

以下修复从上游移植到 fork 0.22.0。旧版 macOS Desktop 的直接 app-server 启动路径和 26.1117 的 `App server host` 启动路径均保留。Composer 按草稿身份、原生提交回调和 Model 的归属识别写入器，支持较早的草稿布局和 26.1117 的布局。

| 上游提交 | 修复内容 |
| --- | --- |
| `82c1da2f3`、`cd205d702` | 识别 macOS 和 Windows 的主 app-server 工具进程。 |
| `35ce94e94`（#1003） | 识别 MCP 启动目录参数，并在 Remote SSH 上按原生参数边界处理。 |
| `4fe7022ca`（#1010，包含 `6e6a886dd` 和 `0c995a0ae`） | 恢复 Composer 的草稿路由和 Model 重试控件。fork 的工作目录沿用独立草稿标记，原生模式复用时按当前草稿绑定目录。 |
| `fced5a639`（#1040）及 `2cb94c295` | 支持多个 store wrapper，按所有权识别草稿写入器。显式切换失败时保留原 Agent 并显示提示。兼容审计检查草稿写入与提交模式的归属。 |
| `15579657d` | 支持合并的 Codex 额度阻止原因。外部 Harness 可以提交，原生 Codex 和其他提交限制保持各自行为。 |
| `5c965b881`（#978） | 为 Remote SSH 的 Harness 发现放宽 CDP 堆查询时限。 |
| `ac7ee6423`、`0445d77f1` | 启用侧栏图标时，26.1117 的图标使用原生前导槽位和 14 px 尺寸。 |
| `c8778a1a4` | Settings 覆盖工作区时隐藏原生工作区外框，关闭 Settings 时恢复。 |
