# 技能中央库

每台机器的中央库是 `~/.agents/skills/<skill>/SKILL.md`。工作台「技能」显示技能 × 机器的矩阵，以及各机器发现的智能体、技能目录、原生支持、链接和排除状态。同步只由用户操作或 CLI 发起，没有定时同步。

## 所有权与数据流

- `shared-contracts/skills-hub.ts` 定义浏览器安全的请求、库存、冲突与操作结果。
- `host-runtime/skills-hub/` 负责库存、发现、指纹、链接计划、备份、撤销、归档、来源重建及跨机协调。
- `renderer-extension/settings/skills-*` 使用设置页的 Shadow DOM 和 Tailwind 样式，只通过 `codexhost/skills/request` 调用本机协调器。
- Rust launcher 只把 `skills` 命令交给 TypeScript CLI，不解释技能语义。

本机协调器读取现有 `peers.json`，以 peer 名称列出远程机器；CLI 的 `--host` 也接受配置中的机器标识。远端必须运行支持技能路由的 codexhost。传输复用 `requestPeerRoute` 的 SSH ControlMaster 和认证控制服务。新增的白名单路由仅覆盖 `/v1/skills/` 下的库存、链接预览/执行、排除设置、撤销、导出、导入和分块传输；请求不接受任意路径或 shell 命令。远程技能路由不能递归发起跨机同步。

## 库存与发现

库存扫描只读，不创建目录。目录名作为稳定键，frontmatter 的 `name`、`description`、`version` 作为显示元数据。标量与折叠描述支持常见 `SKILL.md` 格式，不执行 YAML 标签。指纹覆盖每个普通文件的相对路径、字节内容及可执行位；忽略 `.DS_Store` 和 `.git`、`.hg`、`.svn` 目录。修改时间取所有文件的最新时间。

库存读取 `~/.agents/.skill-lock.json` 中 npx skills 的来源信息，以及技能中心自己的来源覆盖记录。已知 GitHub 仓库、固定 commit 和技能路径时，目标优先从该 commit 重建文件并验证整个目录的指纹；不运行技能脚本或包管理器。来源可变、不可用或内容不同则使用已经校验的归档。

Agent 名单来自已安装 Harness 的插件目录（`enabled.json` 与 manifest），只列已安装的 Agent 加官方 Codex；能力表只记录路径及原生支持证据。该名单约每月才变，Host 在生命周期内缓存它，不再扫描 `~/.*` 或 PATH。插件目录不可读时只保留内置 Codex。

库存以中央库及每个 Agent 技能目录的 mtime、size 作为指纹。指纹未变时直接返回上次库存，不读取任何文件；有变化才重新扫描。页面先用上次库存立即渲染，再在后台刷新。

原生支持证据（2026-11-17 核对）：

| 智能体 | 是否直接读取中央库 | 依据 |
| --- | --- | --- |
| Codex | 是 | [官方技能目录](https://developers.openai.com/codex/skills/) 的 USER `$HOME/.agents/skills`。 |
| Gemini CLI | 是 | [官方 Skills 文档](https://geminicli.com/docs/cli/skills/) 的用户级 `.agents/skills` alias，优先于 `.gemini/skills`。 |
| OpenCode | 是 | [官方 Skills 文档](https://opencode.ai/docs/skills/) 的 global compatibility `.agents/skills`。 |
| Claude Code | 否 | [官方 Skills 文档](https://code.claude.com/docs/en/skills) 的个人目录 `.claude/skills`。 |
| Antigravity | 否 | [skills 的 Agent 路径实现](https://github.com/vercel-labs/skills/blob/main/src/agents.ts) 明确 `globalReadsCanonical=false`，用户目录为 `.gemini/config/skills`。 |
| CodeBuddy、Grok、Cursor、Kiro | 按独立用户目录链接 | 同一份 [skills 路径实现](https://github.com/vercel-labs/skills/blob/main/src/agents.ts) 的 `globalSkillsDir`；项目级 `.agents/skills` 不等于用户级中央库支持。 |

GitHub Copilot、Qoder、Qoder CN 默认排除，设置页可以按机器编辑标识列表。即使其 home 或 CLI 存在，也不为被排除项创建技能目录。Claude Code 的 `codexhost-delegation` 留给专属安装/更新器管理。

## 链接、冲突与撤销

「一键链接」先生成有效期十分钟的只读预览。执行使用一次性预览编号，重新扫描库存、发现结果、排除列表和计划。任何变化都要求重新预览。

创建的新链接使用相对目标。已经指向正确中央技能的链接保留；仅自动清理指向中央库内部、且目标缺失的链接。外部失效链接、普通文件和同名真实目录都显示冲突。选择「收进中央库」需要单独确认并重新预览；执行会备份中央同名版本、移动选中的真实目录并留下相对链接。一次预览不能为同一个中央技能选择两个目录。

跨机同步支持单技能、整库推送和仅填缺失。相同名字、不同指纹的相关版本必须逐技能选择来源，冲突对话框显示机器、修改时间、指纹、文件列表和 `SKILL.md` 短差异。选择绑定原冲突预览；任一相关机器的内容发生变化，选择失效。填缺失不会改写已有版本；来源存在多个版本时仍需用户选择。

每次导出重新验证来源指纹；每次导入比较目标的预期指纹或缺失状态。两台机器无需全局事务：失败按机器与技能返回，已完成的操作有独立撤销编号。同步完成后提供目标机器的链接入口，链接不会隐式执行。

备份、变更清单、排除列表和来源记录保存在 `~/.codexhost/skills-hub/`。清单包含每一步的状态，执行失败可用预览编号检查。撤销前校验当前文件、链接和来源记录；被用户或其他工具修改后会拒绝撤销。撤销保留替换版本作为备份，不递归删除用户技能。设置页提供本次页面会话内的「撤销上次更改」，CLI 可按清单编号撤销。

## 传输限制

归档为 gzip ustar，仅接收普通文件，保留可执行位。拒绝符号链接、硬链接、设备、路径越界、重复路径和文件/父目录碰撞。中央技能目录以及待写入路径的祖先不得是符号链接；不支持的条目显示扫描提醒，不跟随其目标。

每个技能最多 64 MiB 普通文件、8192 个文件，`SKILL.md` 最多 64 KiB。大归档按 512 KiB 的 base64 片段传送，单次请求保持在现有 2 MiB 上限内。分块会话使用十分钟、一次性的随机编号，检查偏移、长度和内存配额；编号不能指定文件路径。上传完成并通过全部指纹校验前不改中央库。预览和传输会话在进程退出后失效，备份清单保留。

## CLI

```sh
codexhost skills list
codexhost skills list --host oracle-main
codexhost skills link --host local --dry-run
codexhost skills sync design-review --to oracle-main,build-server --dry-run
codexhost skills sync --all --host oracle-main --to local --dry-run
codexhost skills undo <change-id> --host oracle-main
```

交互终端先展示预览，再逐项选择冲突版本，最后确认执行。非交互调用默认只展示预览。自动化先检查输出中的 `confirmation` 摘要，再携带该摘要执行；摘要不匹配则拒绝写入。存在冲突时还需明确每个技能的来源，例如：

```sh
codexhost skills sync design-review --to oracle-main \
  --confirm <previous-confirmation> --choose design-review=local
codexhost skills link --host oracle-main --confirm <previous-confirmation>
```

本机 list/link dry-run 不需要读取运行时控制文件，也不写用户目录。远程操作通过现有 peer 控制通道执行。

## 验证与真实 Desktop 验收

聚焦测试覆盖假 home 下的库存、指纹、发现、排除、真实目录冲突、失效链接、收进中央库、撤销、来源重建、预览失效、分块偏移，以及两台假机器通过认证路由同步与撤销。真实用户目录验证只运行 dry-run。

`tools/ui-preview` 覆盖矩阵、机器卡片、排除编辑、冲突选择及文件列表、链接预览和收进中央库的选择，并提供悬停与键盘焦点场景。场景通过真实鼠标/键盘桥操作设置页 Shadow DOM。`CODEX_DESKTOP_CSS` 指向 Desktop 样式时，预览提取原始主题变量、深色选择器及媒体条件，避免浅色导出值遮蔽深色变量；截图报告记录主题来源。仅提供浅色变量导出时，深色报告仍标记为 approximate。

链接预览按 Agent 显示名和目录分组。「收进中央库」默认不勾选；更改选择后重新生成预览，点击「应用」才执行该预览。机器卡片共用列宽，排除编辑入口统一放在页面底部，设置仍按机器保存。

真实 Desktop 需验证：本机设置入口与 peer 名单；Mac/SSH peer 的实际技能发现；每个 Agent 对链接技能的原生加载；跨机断连与权限错误；同名冲突反复询问；确认后的同步、收进中央库及撤销。macOS/Windows 的符号链接权限和文件系统行为需在对应平台实测。
