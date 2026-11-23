# fork 与上游 v0.25.1 的差异

| 功能 | fork 行为 |
| --- | --- |
| [钉钉](../architecture/dingtalk.md)与 [Codex 智能体](../architecture/codex-agents.md) | Mac Host 管理 `dws` 和钉钉配置。消息和会话使用内存状态，手动派发可选多个智能体，以 A2UI 卡片回传进度。Codex 智能体页读取和编辑原生智能体配置。 |
| [Jarvis 和模型服务](../architecture/jarvis-mention.md) | Desktop 提供 Jarvis 项目和提及。通用设置的「模型服务」由 Mac Host 管理 Gemini 凭据。 |
| [Skills](../architecture/skills-hub.md)、[MCP 和记忆](../architecture/hub-admin.md) | Desktop 设置提供跨机器 Skills 管理及由 Mac Host 代理的 MCPHub、MemHub 管理。MCPHub 管理密钥沿用 `~/.config/codexhost/mcphub-admin-key`。 |
| [工作文件夹和代码仓库](../architecture/thread-folders.md) | Desktop 和 Web 支持草稿和已有 Thread 的多个工作文件夹。Mac Desktop 的目录菜单可以选择 GitHub、GitLab 仓库，并克隆到本机或所选 SSH 主机。 |
| [SSH peer 委派](../architecture/peer-delegation.md) | Desktop 和 Web 的 `#`/`@` 菜单显示就绪的远端 Agent。带 `?host=` 的提及由 Host 转换成经 SSH 路由的 CLI 委派，完成通知回到父 Thread。 |
| 委派 Skill | 托管版本为 v18，使用上游的触发范围和委派默认值，包含 fork 的 SSH peer 命令及通知说明。上游 v16 和 fork v17 的托管副本均可识别升级。 |
| [存量数据工具](fork-data-migration.md) | `tools/migrate-fork-data` 提供旧版数据根迁移、备份和回滚。已经使用共享数据根的 fork 继续使用各机器现有的数据目录。 |

## Desktop 入口和侧栏

Desktop 的 Agent 菜单按草稿或项目所属 Host 显示，侧栏按原生分区和项目组织。跨机器派发通过 `#`/`@` 菜单。Desktop 设置显示 Jarvis，原有「会话导入」及「定时任务」入口在该设置菜单中隐藏。多 Agent 协作设置与插件市场使用上游入口。

[`fork-desktop-features.ts`](../../packages/renderer-extension/src/fork-desktop-features.ts) 的 `FORK_DESKTOP_FEATURES.sidebarAgentIcons` 在生产注入入口关闭普通和定时任务侧栏条目的 Agent 图标。禁用时仅对标题为路径的 SSH 条目查询归属，供上游清理已关闭的空 Thread。插件用到的侧栏身份和 Composer 打开 Thread 时的归属查询仍可用。单独调用 Probe 默认启用图标。

Desktop 兼容审计使用相同的构建开关。关闭图标时，审计检查 Fork 导航使用的原生侧栏 Thread 身份，比较报告时忽略 `titleOwnerCount`。

## 委派与远程项目

上游[多 Agent 协作](../architecture/delegation-defaults.md)保存每个 Harness 的默认 Model 和 Thinking，支持在 CLI 使用目录中公布的 Model ID 和速度档位。它也适用于 peer 目标上的委派。上游 Web 的[远程会话和项目](../product/standalone-web.md)通过已有的 Desktop SSH／Remote Control 连接，在指定项目中打开、新建及追问远程 Thread。fork 的 SSH peer 使用 `peers.json` 和对端 Launcher 的 `peer-exec`，可以不经过 Desktop 连接创建委派子 Thread，并把 watch 通知带回调用方。
