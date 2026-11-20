# 技能中央库

每台机器的中央库是 `~/.agents/skills/<skill>/SKILL.md`。工作台「技能」提供「技能库」卡片/列表与「按 Agent」工作区：卡片显示来源、机器状态和已安装 Agent 的链接徽标，Agent 页显示路径、数量与每个技能的状态。同步与链接只由用户操作或 CLI 发起，没有定时同步。

## 所有权与数据流

- `shared-contracts/skills-hub.ts` 定义浏览器安全的请求、库存、冲突与操作结果。
- `host-runtime/skills-hub/` 负责库存、发现、指纹、链接计划、备份、撤销、归档、来源重建及跨机协调。
- `renderer-extension/settings/skills-*` 使用设置页的 Shadow DOM 和 Tailwind 样式。每台机器通过 `codexhost/skills/request` 读取自己的状态；跨机同步和导入仍由本机协调器通过 `SkillsHubService` 接收机器列表、peer 标识解析和请求传输。当前分支默认列出本机。合入 T0 后，在 `getSkillsHub` 中把 `hosts`、`resolveHost` 和 `transport` 接到 T0 的 `peers.json` 读取器、别名解析与 SSH 传输。T0 的 `peer-exec` 应放行 `SKILL_PEER_OPERATIONS` 对应的 `/v1/skills/<op>` 路径。另一个 Host 的认证控制端口按该清单接收库存、链接、撤销、导入导出和分块操作。Desktop 优先使用已建立的对应 Host 连接，跨机同步计划由本机协调器处理。

## 库存与发现

库存扫描只读，不创建目录。目录名作为稳定键，frontmatter 的 `name`、`description`、`version` 作为显示元数据。与 [Skill Library](skill-library.md) 共用 YAML frontmatter 解析。指纹覆盖每个普通文件的相对路径、字节内容及可执行位；忽略 `.DS_Store` 和 `.git`、`.hg`、`.svn` 目录。修改时间取所有文件的最新时间。

库存读取 `~/.agents/.skill-lock.json` 中 npx skills 的来源信息，以及技能中心自己的来源覆盖记录。已知 GitHub 仓库、固定 commit 和技能路径时，目标优先从该 commit 重建文件并验证整个目录的指纹；不运行技能脚本或包管理器。来源可变、不可用或内容不同则使用已经校验的归档。

Agent 名单来自缓存的 Harness 可用性（`~/.codexhost/cache/harness-availability.json` 中 `status !== "notInstalled"`），只列已安装的 Agent 加官方 Codex；不读取未安装 Agent 的技能目录，也不扫描 `~/.*` 或 PATH。可用性由 Harness 检查器维护，技能操作读取该缓存，不重新探测 CLI。库存候选随缓存名单更新。T0 负责生成和刷新该缓存，暂无缓存时只列内置 Codex。

库存以中央库及每个 Agent 技能目录的 mtime、size 作为指纹。指纹未变时直接返回上次库存，不读取任何文件；有变化才重新扫描。设置页按机器缓存上次库存；重开时先用缓存立即渲染并显示「更新于 X 前」，再在后台刷新。首次打开直接向每台机器的 Host 读取自己的 `{op:"status",hostId:"local"}`，不再由 Mac Host 为每次请求新开 SSH；本机先出现，远程机器各自返回后逐台填充。直连请求（状态、链接预览、执行、撤销）的请求体一律使用 `hostId:"local"`，预览结果返回前换回该机器的 peer 名称；只有跨机同步仍把 peer 名称交给本机协调器。

每个技能的每个 Agent 状态（已链接、未链接、冲突、原生支持、托管）随库存返回，供技能库徽标和 Agent 页使用。链接徽标复用预览、应用与撤销流程；目标化 `unlink` 只移除指向对应中央技能的符号链接，不删除中央库技能，可撤销。托管技能不参与链接或解除链接。库存、预览、应用前校验和导入导出均使用缓存的 Harness availability 筛选 Agent；预览后安装状态变化会使预览失效，已卸载 Agent 的链接撤销会拒绝执行。

原生支持证据（2026-11-17 核对）：

| 智能体 | 是否直接读取中央库 | 依据 |
| --- | --- | --- |
| Codex | 是 | [官方技能目录](https://developers.openai.com/codex/skills/) 的 USER `$HOME/.agents/skills`。 |
| OpenCode | 是 | [官方 Skills 文档](https://opencode.ai/docs/skills/) 的 global compatibility `.agents/skills`。 |
| Claude Code | 否 | [官方 Skills 文档](https://code.claude.com/docs/en/skills) 的个人目录 `.claude/skills`。 |
| Antigravity | 否 | [skills 的 Agent 路径实现](https://github.com/vercel-labs/skills/blob/main/src/agents.ts) 明确 `globalReadsCanonical=false`，用户目录为 `.gemini/config/skills`。 |
| CodeBuddy、Grok、Cursor、Kiro | 按独立用户目录链接 | 同一份 [skills 路径实现](https://github.com/vercel-labs/skills/blob/main/src/agents.ts) 的 `globalSkillsDir`；项目级 `.agents/skills` 不等于用户级中央库支持。 |

设置页不提供排除功能：已安装的 Agent 都按同一规则参与库存、链接和同步。旧的 `exclusions.json` 不再读取，也不会被删除。Claude Code 的 `codexhost-delegation` 留给专属安装/更新器管理。

## 链接、冲突与撤销

「一键链接」先生成有效期十分钟的只读预览。执行使用一次性预览编号，重新扫描库存、发现结果和计划。任何变化都要求重新预览。

创建的新链接使用相对目标。已经指向正确中央技能的链接保留；仅自动清理指向中央库内部、且目标缺失的链接。外部失效链接、普通文件和同名真实目录都显示冲突。选择「收进中央库」需要单独确认并重新预览；执行会备份中央同名版本、移动选中的真实目录并留下相对链接。一次预览不能为同一个中央技能选择两个目录。

跨机同步支持单技能、整库推送和仅填缺失。相同名字、不同指纹的相关版本必须逐技能选择来源，冲突对话框显示机器、修改时间、指纹、文件列表和 `SKILL.md` 短差异。选择绑定原冲突预览；任一相关机器的内容发生变化，选择失效。填缺失不会改写已有版本；来源存在多个版本时仍需用户选择。

每次导出重新验证来源指纹；每次导入比较目标的预期指纹或缺失状态。两台机器无需全局事务：失败按机器与技能返回，已完成的操作有独立撤销编号。同步完成后提供目标机器的链接入口，链接不会隐式执行。

备份、变更清单和来源记录保存在 `~/.codexhost/skills-hub/`。清单包含每一步的状态，执行失败可用预览编号检查。撤销前校验当前文件、链接和来源记录；被用户或其他工具修改后会拒绝撤销。撤销保留替换版本作为备份，不递归删除用户技能。设置页提供本次页面会话内的「撤销上次更改」，CLI 可按清单编号撤销。

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

本机 list/link dry-run 不需要读取运行时控制文件，也不写用户目录。远程命令依赖 T0 的 peer 传输配置。

## 验证与真实 Desktop 验收

聚焦测试覆盖假 home 下的库存、指纹、发现、真实目录冲突、失效链接、收进中央库、撤销、来源重建、预览失效、分块偏移，以及两台假机器通过认证路由同步与撤销。真实用户目录验证只运行 dry-run。

用 `tools/ui-preview/capture-hubs.mjs` 和导出的 Desktop CSS 核对浅色、深色、悬停、焦点和链接预览。脚本使用假库存与真实设置页。Desktop 实机验证包括 Mac 与 SSH peer 的技能发现、Agent 对链接技能的加载、断线、权限错误、确认后的同步及撤销。
