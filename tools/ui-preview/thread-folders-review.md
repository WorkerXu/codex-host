# 对话工作文件夹界面验收

2026-11-17，`tools/ui-preview`，Chromium，1280×900。预览直接导入生产 `createThreadFoldersControl`，使用隔离的假 Host 和文件系统回复。使用 `agent-browser` 的真实鼠标/键盘操作后截图；以下 12 张均已逐张打开查看。

截图位于工作区外：`/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-thread-folders/`，未纳入 Git。

| 截图 | 操作与查看结果 |
| --- | --- |
| `local-chip-hover-light.png` | 鼠标悬停 chip；与机器/项目 chip 同行，标签完整 |
| `local-popover-light.png` | 点击 chip；主要目录、最近目录、添加/取消/应用可辨认 |
| `local-multiselect-hover-light.png` | 点击第二个复选框并悬停「设为主要」；多选与按钮状态清楚 |
| `local-main-light.png` | 点击「设为主要」；主要目录移到首位，原项目目录保留 |
| `local-popover-dark.png` | 深色多选；路径、复选框、主要标记和动作按钮可辨认 |
| `local-path-completion-light.png` | 输入本机绝对路径；目录补全列表展开，弹窗保持在视口内 |
| `remote-popover-dark.png` | 深色远程弹窗；机器标识明确，路径属于远程 Host |
| `remote-browse-hover-dark.png` | 输入远程父路径并悬停子目录；列表展开向上重定位，无裁切 |
| `remote-popover-hover-light.png` | 浅色远程弹窗；目录行 hover 与 chip 状态正常 |
| `existing-note-light.png` | 已有对话多选、切主要目录并应用；出现变更提示和 `+1` |
| `existing-note-dark.png` | 已有对话深色提示；提示、chip 与 Composer 层级可辨认 |
| `limited-popover-dark.png` | 主目录模式 Harness；弹窗解释只使用主要文件夹，tooltip 有相同限制 |

另以真实 Enter 执行添加/设置主要目录、Esc 关闭并观察焦点返回；Playwright 覆盖相同键盘操作、空选择禁用应用，以及远程补全后的视口边界。没有通过脚本直接修改 DOM 来伪造交互结果。

深色使用 ui-preview 的深色映射；导出的 Desktop shadow context 是浅色来源，深色不等同于实机主题证明。

## 真实 Desktop 待验

1. Mac 本机和已连接 SSH Host：从同一个项目创建对话，选择两个目录，确认 `cwd` 为主要目录且可以写入第二目录，侧栏仍归原项目；草稿与预热不能串到其他对话。
2. 已有原生对话：切换主要/额外目录，确认下一轮、CLI 续聊和重新加载后的选择一致；agent 只收到一次变更说明。检查当前 `environmentId` 可读。
3. Claude Code：确认 SDK 原生额外目录可用，主要目录切换后的 Native Session 身份、历史、配置和继续执行正常。其他 Harness 确认主要目录模式提示与实际行为一致。
4. 委派：同机 Codex 与外部子 Thread 继承父项目；`--project <id>|none` 优先。跨机检查实际 `threadProjectAssignments.assign` 导出和签名；绑定不可用时 `window.__codexhostDelegationProjectsV1.status()` 显示 pending/error，记录保留并重试。
5. 文件浏览器/diff 根目录：当前未写入未核验的 `thread-writable-roots` / applied workspace cwd 私有 atom，可能显示旧根；这是明确的集成缺口。
6. 侧栏保持原生项目；跨机镜像仍创建目录/项目、打开新对话并选择 Harness；旧组文件保持原样。

手动远程探针：`node tools/thread-folders-check.mjs --host <SSH别名> --cli <远程codex路径>`。需要目标机已登录 Codex，使用一次模型轮次；创建 ephemeral Thread，在随机 cache 目录验证第二根目录可写并清理。此环境未执行真实远程探针。


## 本地检查

- `npm run build:typescript`、`npm run build:renderer`：通过。
- 聚焦 Vitest：33 个文件、594 个用例通过；末次父会话目录继承改动另以 5 个 Host 路径用例验证，52 个原生投影用例单文件重跑通过。并行负载下两项 Usage 用例曾触发 fixture 固定 2 秒等待上限，没有修改等待时间或跳过用例。
- `tests/e2e/renderer-thread-folders.spec.ts`：3 个真实交互用例通过。
- `npm run lint`：通过；包含边界检查。
- `npm run typecheck`：11 个错误，与独立 `a9162bb5` 基线 worktree 的错误完全一致。错误位于原有 external-inject-items、DingTalk、native-at-menu 和 accept2 测试文件，未修改这些文件。
- 改动文件 Prettier 检查与 `git diff --check`：通过。
- 远程探针仅检查 `--help`；没有执行真实远程模型轮次。

## 功能提交

以下提交均为本地提交，没有 push、merge 或部署：

```text
2b54a73b refactor: remove project groups and preserve native project mirrors
1605e91f feat: persist thread folders and delegation project metadata
15e5599a feat: pass native additional directories to Claude Code
36afbac1 feat: rewrite and track per-thread working folder requests
f5ad16b9 feat: apply thread folders and inherit delegation projects
99a2de4f feat: expose delegation project choices and upgrade managed skill
e1593f7a feat: scope working folders to native conversation drafts
3cdc4bcc fix: honor cleared Desktop project assignments in delegation
f824f657 feat: add conversation working folder controls to Composer
7cc965d9 fix: inherit the parent thread current working directory
```

委派 Skill 升为 v15。v14 fixture 来自真实已安装文件，SHA-256 为 `7caa62a4fed8a0d4ae2f757bc28e80da05fefc6bc2b46b231d42d57c01461a32`，与升级白名单一致。
