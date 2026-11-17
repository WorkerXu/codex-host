# 从仓库添加工作文件夹：界面与验证记录

2026-11-17。任务基于 `f90043d9`，完整阅读 task-folders-from-repo.md 与 ui-quality-bar.md 后实现。未推送、合并或部署；未读取禁止的 runtime 目录。

## 视觉来源与逐图检查

预览使用 `tools/ui-preview`、真实 Desktop CSS 与已捕获的原生 Composer DOM（`fixtures/native-composer.html`）。CSS 位于 `/home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-reference/codex-desktop.css`，SHA-256 为 `45b6cbc843f0dd1b94491ae1ed8ff03fcb9cdf53b16eb10896673037648dd987`。浅深色均由真实主题变量解析，不使用近似深色。目录、仓库列表、保存和克隆进度由确定性 fixture 返回；不连接真实 Host。

所有截图都通过 agent-browser 的真实鼠标 / 键盘操作取得，34 张最终图均已逐张打开查看。常规窗口 1280×900，窄窗口 390×740。截图与校验 manifest 在上述仓库外的截图目录；仓库只保存此清单。

| 截图 | 修掉的问题与复查结果 |
| --- | --- |
| [01-github-hover-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/01-github-hover-light.png>) | 浅色。GitHub 首屏，真实鼠标悬停第二行。调整标签下划线为直线，名称、命名空间、说明、日期层级清晰，悬停底色沿用 Desktop。 |
| [01-github-hover-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/01-github-hover-dark.png>) | 深色。GitHub 首屏，真实鼠标悬停第二行。调整标签下划线为直线，名称、命名空间、说明、日期层级清晰，悬停底色沿用 Desktop。 |
| [02-gitlab-keyboard-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/02-gitlab-keyboard-light.png>) | 浅色。GitLab 标签，经 Tab / 方向键聚焦首行。原生焦点环完整，命名空间与说明不会越过日期；列表保持同一布局。 |
| [02-gitlab-keyboard-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/02-gitlab-keyboard-dark.png>) | 深色。GitLab 标签，经 Tab / 方向键聚焦首行。原生焦点环完整，命名空间与说明不会越过日期；列表保持同一布局。 |
| [03-search-focus-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/03-search-focus-light.png>) | 浅色。键盘输入 shared 后聚焦唯一匹配行。修掉输入后旧结果仍可被方向键选中的问题：等待服务端搜索时立即清空旧行，只有新结果可以选择。 |
| [03-search-focus-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/03-search-focus-dark.png>) | 深色。键盘输入 shared 后聚焦唯一匹配行。修掉输入后旧结果仍可被方向键选中的问题：等待服务端搜索时立即清空旧行，只有新结果可以选择。 |
| [04-local-target-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/04-local-target-light.png>) | 浅色。选择 shared-ui 后进入本机目标。默认 ~/Downloads，明确显示仓库目录名；更改位置入口获得焦点，原生主按钮层级清楚。 |
| [04-local-target-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/04-local-target-dark.png>) | 深色。选择 shared-ui 后进入本机目标。默认 ~/Downloads，明确显示仓库目录名；更改位置入口获得焦点，原生主按钮层级清楚。 |
| [05-remote-browser-focus-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/05-remote-browser-focus-light.png>) | 浅色。远程目标默认 ~/projects，复用原目录浏览子视图。修掉「选择」按钮文字被对话框通用颜色覆盖的问题；路径栏、目录图标和焦点环保持可读。 |
| [05-remote-browser-focus-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/05-remote-browser-focus-dark.png>) | 深色。远程目标默认 ~/projects，复用原目录浏览子视图。修掉「选择」按钮文字被对话框通用颜色覆盖的问题；路径栏、目录图标和焦点环保持可读。 |
| [06-cloning-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/06-cloning-light.png>) | 浅色。克隆进行中。列出 / 克隆 / 传输 / 完成四步在同一行，当前步骤加重，关闭按钮禁用，无英文子进程输出。 |
| [06-cloning-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/06-cloning-dark.png>) | 深色。克隆进行中。列出 / 克隆 / 传输 / 完成四步在同一行，当前步骤加重，关闭按钮禁用，无英文子进程输出。 |
| [06-transferring-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/06-transferring-light.png>) | 浅色。远程传输进行中。当前步骤切到传输，保持原对话框位置与间距，避免进度更新造成跳动。 |
| [06-transferring-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/06-transferring-dark.png>) | 深色。远程传输进行中。当前步骤切到传输，保持原对话框位置与间距，避免进度更新造成跳动。 |
| [07-complete-focus-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/07-complete-focus-light.png>) | 浅色。工作文件夹保存成功后显示完成步骤、最终路径及完成按钮，chip 已增加目录数。修掉完成步骤一闪而过、用户无法确认结果的问题。 |
| [07-complete-focus-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/07-complete-focus-dark.png>) | 深色。工作文件夹保存成功后显示完成步骤、最终路径及完成按钮，chip 已增加目录数。修掉完成步骤一闪而过、用户无法确认结果的问题。 |
| [08-conflict-hover-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/08-conflict-hover-light.png>) | 浅色。已有目标目录时显示明确确认，真实悬停「选择其他位置」。默认不写目标，不展示覆盖选项；使用已有目录是单独的明确动作。 |
| [08-conflict-hover-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/08-conflict-hover-dark.png>) | 深色。已有目标目录时显示明确确认，真实悬停「选择其他位置」。默认不写目标，不展示覆盖选项；使用已有目录是单独的明确动作。 |
| [09-loading-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/09-loading-light.png>) | 浅色。仓库首屏加载中。修正状态文字与列表/搜索框左缘不齐的问题；紧凑空白容器不跳出视口。 |
| [09-loading-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/09-loading-dark.png>) | 深色。仓库首屏加载中。修正状态文字与列表/搜索框左缘不齐的问题；紧凑空白容器不跳出视口。 |
| [09-empty-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/09-empty-light.png>) | 浅色。仓库为空时显示简短中文空态，保留搜索和来源标签；状态文字对齐列表首列。 |
| [09-empty-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/09-empty-dark.png>) | 深色。仓库为空时显示简短中文空态，保留搜索和来源标签；状态文字对齐列表首列。 |
| [09-error-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/09-error-light.png>) | 浅色。网络错误中文说明与重试。修正错误文案和按钮的左对齐；使用 Desktop 危险色，无原始英文异常。 |
| [09-error-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/09-error-dark.png>) | 深色。网络错误中文说明与重试。修正错误文案和按钮的左对齐；使用 Desktop 危险色，无原始英文异常。 |
| [09-unconfigured-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/09-unconfigured-light.png>) | 浅色。GitLab 未配置令牌时明确给出通用设置中的配置位置；长中文说明在弹层内换行，底部保留目标服务域名。 |
| [09-unconfigured-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/09-unconfigured-dark.png>) | 深色。GitLab 未配置令牌时明确给出通用设置中的配置位置；长中文说明在弹层内换行，底部保留目标服务域名。 |
| [10-clone-error-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/10-clone-error-light.png>) | 浅色。克隆无权限时保留返回动作，不把子进程 stderr 展示给用户；错误色与主内容间距按 Desktop 变量。 |
| [10-clone-error-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/10-clone-error-dark.png>) | 深色。克隆无权限时保留返回动作，不把子进程 stderr 展示给用户；错误色与主内容间距按 Desktop 变量。 |
| [11-settings-hover-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/11-settings-hover-light.png>) | 浅色。通用设置中代码仓库紧邻模型服务，沿用相同卡片/行组件；悬停更换令牌，GitHub 为只读状态，令牌只显示配置与末四位。 |
| [11-settings-hover-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/11-settings-hover-dark.png>) | 深色。通用设置中代码仓库紧邻模型服务，沿用相同卡片/行组件；悬停更换令牌，GitHub 为只读状态，令牌只显示配置与末四位。 |
| [12-settings-edit-focus-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/12-settings-edit-focus-light.png>) | 浅色。更换令牌的密码输入框，真实键盘输入预览占位内容。焦点环清楚；修掉 Esc 先关闭整页的问题，取消时清空输入并返回更换按钮。 |
| [12-settings-edit-focus-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/12-settings-edit-focus-dark.png>) | 深色。更换令牌的密码输入框，真实键盘输入预览占位内容。焦点环清楚；修掉 Esc 先关闭整页的问题，取消时清空输入并返回更换按钮。 |
| [13-narrow-keyboard-light.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/13-narrow-keyboard-light.png>) | 浅色。390×740 窄窗口，GitLab 列表键盘焦点。弹层两侧保留边距，日期在窄窗口隐藏，名称/命名空间/说明保留；无水平溢出或截断按钮。 |
| [13-narrow-keyboard-dark.png](</home/ubuntu/Documents/ChatGPT/AI工作台/codexhost-pack/ui-review/shots-folders-from-repo/13-narrow-keyboard-dark.png>) | 深色。390×740 窄窗口，GitLab 列表键盘焦点。弹层两侧保留边距，日期在窄窗口隐藏，名称/命名空间/说明保留；无水平溢出或截断按钮。 |

## 接口与交互

本机添加工作文件夹仍直接调用系统选择框；同一菜单新增「从仓库添加…」。仓库弹窗支持 GitHub / GitLab、服务端搜索、Tab / 上下方向键 / Home / End / Enter 导航；切换来源清除搜索，异步结果按代次丢弃。

选择目标沿用当前对话机器，本机默认 `~/Downloads`，选中仓库后即调用 `appServices.fileAttachments.pickFiles({kind:"directory", allowMultiple:false, pickerTitle:"选择克隆位置"})`；取消不改位置，接口不可用才退回子视图。该接口没有已核验的 defaultPath 参数，应用默认目标为 Downloads，系统选择窗口的初始目录沿用 Desktop / 系统状态。远程默认 `~/projects`，通过 Mac 的 peer SSH 连接浏览，复用 `mountFolderBrowser`；不会启动本机 picker。完成前不加入对话，加入前检查目录和对话身份；保存失败保留 checkout 并支持重试加入。

## 验证

- `npm run build:typescript`、`npm run build:renderer`、`node tools/ui-preview/build.mjs`：通过。
- `npm run typecheck`、`npm run lint`、改动文件 Prettier 与 `git diff --check`：通过。
- Host 聚焦测试：3 个文件、20 项通过，包含列表解析/搜索、0600 令牌、无凭据泄漏、已有目录拒绝、Mac/peer 克隆计划、SSH 与 tar、临时文件清理、Host RPC 的本机边界、首次读取插件能力。另用临时本地 Git 仓库实际执行 clone，验证历史、文件、.git 与原始 origin；未接触真实项目。
- UI 浏览器测试：仓库 8 项、原工作文件夹 15 项、模型服务 3 项，共 26 项通过，加载真实 Desktop CSS。覆盖目标目录选择、取消、远程浏览、多步进度、目录冲突确认、错误状态、令牌测试/更换/清除和两级 Esc。
- 全量执行 `npx vitest run --config tests/vitest.config.js packages/host-runtime/test packages/renderer-extension/test`：首次 279 个文件 / 2845 项通过，4 个文件 / 6 项时序或超时失败，5 个文件 / 13 项跳过。失败文件为 harness-plugin-loader、renderer-binding-probe-host-catalog、app-server-host.projection-2、codex-usage-plugin；按相同配置以单 worker 复跑 4 个文件的全部 135 项，全部通过。没有放宽超时或改动原断言。上轮两个指定 Host 回归也包含在本轮全量中。

## Mac 只读检查与实机边界

通过现有 SSH 的 `mac` alias 只读执行了 Mac `/opt/homebrew/bin/gh api user/repos?affiliation=owner&sort=pushed&direction=desc&per_page=20`，首屏 7 个仓库，字段有效。确认 Mac 的令牌文件已配置后，只在 Mac 进程内读取，调用 GitLab membership 首屏 API，HTTP 200、20 个项目，字段有效；没有输出令牌、响应正文或仓库详情。

未在 Mac 上创建 checkout、调用真实系统 picker、传输到生产服务器或安装分支。macOS 系统窗口和真实仓库克隆/远程 SSH 传输仍需用户实机验收。服务器保留 GitLab origin，但不能访问内网 GitLab 时无法自行 fetch / pull / push；Mac 令牌不会同步到服务器。SSH 目标需要 python3 与 tar。

## Claude Code 多目录提示

Host 的文件夹 GET 曾在插件加载前读取 Adapter 能力；首次加载远程 Composer 时，尚未装入的 Claude Code 被当作不支持额外目录，并显示「此智能体仅使用主要文件夹」。现在先等待插件加载，再读取 Adapter 的 additionalDirectories；没有硬编码 Harness 能力。新增异步插件回归在首次请求下验证该能力为 true。Claude Code 原生 SDK / Broker 的 --add-dir 传递保持原样。
