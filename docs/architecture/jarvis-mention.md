# Jarvis `@` 引用

Codex Composer 的原生 `@` 菜单提供「工作台」分组，里面有一行「Jarvis」。输入 `@` 后的文字不会触发 Jarvis 搜索；只有选中这一行，才进入两段式搜索：先选项目，再搜这个项目里的 Bug。选中 Bug 后插入 Desktop 原生 mention chip，提交时再由 Host 展开为可读上下文。

## 入口与模式

- 「Jarvis」行位于原生 `@` 菜单的「工作台」分组。分组和按钮沿用原生列表样式及键盘导航，其他工作台入口可以复用该分组。
- 原生菜单在 `input` 事件之后才挂载；Renderer 会在约 300 ms 内分多次重试，并继续用 `MutationObserver` 观察，等原生列表出现后再插入。原生列表始终不出现时什么都不画，不再自建浮层。
- 行只在查询为空或是 `jarvis` / `贾维斯` 前缀时显示为「Jarvis · 搜索 Bug」；其他自然语言查询显示一行「Jarvis：<文字>」（单行截断）。选中后先删除 `@<文字>`，再打开两段式面板并把该文字作为第一步的项目搜索词；输入过程中仍然不调用 Host。
- 选中后进入自建固定浮层。原生弹层只提供 Composer 顶边的锚点，随即隐藏；浮层底边贴住 Composer 顶边，内容向上生长，高度受 Composer 上方空间限制，结果区是唯一的滚动面。
- 面板有两个步骤，同一个浮层内切换，不叠加第二个弹窗：
  - **项目**：顶部是「‹ Jarvis · 项目」返回头、自动聚焦的搜索框、「我的项目 / 搜索结果」列表；每行是文件夹图标、项目名和右箭头；方向键选择、Enter 或点击进入第二步。
  - **Bug**：顶部是「‹ Jarvis · Bug」，下面依次是项目 chip（可删除，删除即回到第一步）、已解析条件 chip、结果计数、结果行。搜索框里输入文字先做标题预览；停止输入约 800 ms 后自动调用 Gemini 解析其余条件，不需要按 Enter。
  - 方向键选择、Enter 插入（有高亮行时）、Esc 或返回箭头从 Bug 回到项目，项目步骤再按 Esc 退出并回到 Composer。
  - 加载时显示骨架行；错误显示中文原因，不静默变成「无结果」。
- 原生弹层被 Desktop 关闭不影响模式；退出时移除自建浮层并恢复原生面板的可见性。

## 两步搜索

### 第一步：只按名字找项目

1. 打开面板时，若本地存有该 Host、该 Jarvis 用户的短期项目缓存（10 分钟），立即画出「我的项目」；同时后台调用 `project list` 复核。缓存只是展示数据，不参与权限或搜索决策。
2. 输入时按 300 ms 防抖调用 `project list --scope visible --name <q>`，并丢弃过期响应；旧请求立即取消。结果最多 20 行，被截断时在列表上方标注「已显示前 N 个」。
3. 记住每个用户最后进入的项目（本地存储，按 Host 和 Jarvis userId 分开）。下次打开面板直接进入第二步；点项目 chip 的 × 或返回箭头回到第一步。
4. 第一步完全不调用 Gemini，也没有 Gemini 兜底。

### 第二步：项目固定，条件由 Gemini 解析

1. 项目来自第一步，Host 只在该项目内执行 `bug list --project-id N`；第二步从不调用 `project list`，也不重新解析项目名。Gemini 返回的 `projectNames` 被忽略。
2. 输入框文字变化时只做标题预览：`bug list --project-id N --title <原文>`（默认「指派给我」范围），返回后立即显示。预览不经过模型，因此输入过程中面板始终有反馈。
3. 停止输入约 800 ms 后自动提交条件解析；Enter 只用于在防抖前立即解析。Host 复用 `JarvisBugSearcher` 的固定项目路径：Gemini `gemini-3.5-flash-lite` 以 `thinkingLevel: minimal` 解析其余条件（状态、优先级、严重程度、时间窗口、指派给我 / 我创建的、排序、标题关键词），同时并行启动「指派给我」的首页 `bug list`；首页完整时直接过滤，项目较大时回退到带状态过滤的分页查询。返回后替换标题预览，并展示条件 chip。
4. **不做静默兜底**：解析进行中计数位置固定显示「正在识别条件…」，标题预览只在有空结果时显示骨架，绝不显示「无结果」。解析超时或失败时保留预览结果，显示中文「识别条件超时 / 条件识别失败」和「重试」；同一段文字成功解析后不再重复调用 Gemini，文字变化会取消上一请求。
5. 条件 chip 仍使用稳定 key。点掉 chip 会把该 key 作为 `omit` 重新解析；项目 chip 不参与 `omit`，只负责回到第一步。
6. 取数上限沿用现有规则：每个查询每页 100 条、最多 200 条，最多显示 200 条；达到上限时标注「已显示前 N 条」。
7. 错误码沿用 Host 约定并转成中文：`not_logged_in` →「未登录 Jarvis」，`not_installed` →「未安装 Jarvis」，`timeout` / `cli_failed` / `network` →「网络失败，请稍后重试」；解析完成但没有结果时显示「没有符合条件的 Bug。换个说法，或点掉一个条件。」。

### 兼容

旧的整句搜索 RPC `codexhost/jarvis/bug/search` 和取消 RPC 保留，老 Renderer 仍可使用；当前面板只使用三个新 RPC：

- `codexhost/jarvis/project/list`：`{query?}` → 项目列表、是否完整、当前 Jarvis userId。
- `codexhost/jarvis/project/bug/title`：`{projectId, title}` → 标题预览（`conditions` 为空）。
- `codexhost/jarvis/project/bug/search`：`{projectId, query, omit?, requestId?}` → 解析后的条件结果；取消复用 `codexhost/jarvis/bug/search/cancel`。

## 引用载体

- 只支持 Bug：`jarvis://bug/<projectId>/<bugId>`。
- 项目、需求、任务不再出现在 `@` 菜单，也不再生成对应载体；旧载体按普通链接保留，不展开。
- 控制器不可用时，Renderer 退化为插入 Markdown carrier（`[@Label](jarvis://bug/…)`），与 `#` 委派引用同一回退路径。

## 提交时展开

`turn/start`、`turn/steer` 和外部 Harness 的 steering 都会在 Host 内经过 `jarvis-mention-rewrite.ts`：

- 每个 Bug carrier 调用运行 Thread 的那台机器上的 `jarvis bug context`，失败回退 `bug detail`。
- 原文保留为可读的 `@Label`，随后追加一段 `[codexhost Jarvis]` 上下文块，包含标题、网页链接和详情 JSON（超长截断）。
- CLI 失败不阻断 Turn，只在上下文块中写入一行「Jarvis 详情获取失败：…」。
- 官方 Codex 与所有外部 Harness 共用这条路径，因此不依赖 Harness 是否支持附件或结构化输入。

## 机器管理

设置页「Jarvis」显示本地 Host 和 Desktop 已配置的 SSH 连接，并按机器显示安装、登录和连接状态。顶部的「刷新」会更新整批状态。

- **安装**：目标 Host 先通过公开 release API 自动下载。3 秒探测低于约 128 KB/s 时返回 `relay-required`；本地 Host 下载并校验后，由 Renderer 以 512 KB 分片经 Host RPC 推送到目标，目标完成 SHA256/大小校验后原子替换 `~/.local/bin/jarvis` 并运行 `version --json`。
- **登录**：目标 Host 运行 `jarvis login --no-browser` 并返回授权 URL。本地目标直接打开浏览器；远程目标由本地 Host 从 Desktop 的 SSH 连接目录取得对应连接参数并建立 `127.0.0.1:<port>` 本地转发（优先复用原端口，否则改写回调端口），Renderer 轮询目标 Host 的 `auth status` 直到成功，然后关闭转发。
- 未安装或未登录的 Host 不返回搜索结果；`@` 入口仍可打开，模式内显示「未登录 Jarvis」或「未安装 Jarvis」一类的具体提示。
- 机器行的平台字段转成用户能读的名字（例如 `darwin-arm64` 显示为「macOS（Apple 芯片）」）。阈值配置保留读写兼容性，默认 0.5；整句结构化理解不使用阈值，设置页不提供阈值输入控件。

## 边界

- `shared-contracts` 只放路径、Bug/条件数据类型和 RPC schema，保持浏览器安全。
- `renderer-extension` 只做 DOM、防抖、过期响应丢弃、条件 chip 和 chip 插入，不直接调用 CLI 或网络。
- CLI、模型服务、下载、SHA256 和 SSH 转发全部在 `host-runtime`，远程机器只执行本机只读查询。
- 解析服务仅用于第二步识别搜索条件。项目列表、标题预览及引用详情都直接调用 Jarvis CLI。
- Jarvis 命令只允许 `list`、`detail`、`context`、`project list`；搜索路径不执行任何写操作。第二步只使用 `bug list --project-id`，不查询项目列表。

## 共享模型服务

通用页的「模型服务」提供 Gemini API Key 的保存、清除和连接测试。Key 行只显示配置状态与末四位，编辑时使用密码输入框。下一行显示 Jarvis 固定使用的 `Gemini · gemini-3.5-flash-lite`。连接测试使用 `gemini-decision-1` 的 Decisions API，返回耗时或稳定错误码。

Mac 的 Desktop-local Host 使用原有的 `~/.config/codexhost/gemini-api-key`，以 0600 权限原子写入。已有的 `openai-api-key` 和 `model-service.json` 文件留在原处，模型服务只访问 Gemini 文件。Renderer 只在提交保存时将输入传给本地 Host，保存后清空密码输入框。读取和更新 RPC 只返回配置状态与末四位。

`jarvis-query-parser.ts` 构建搜索提示词与上海时间边界，`structured-query-client.ts` 提交 Gemini 结构化请求。读取 Key、HTTP 请求与响应体共享 20 秒截止时间。结果经共享 schema 校验，错误以稳定代码返回。钉钉匹配可复用 `ModelServiceSettingsStore.readKey("gemini")` 和独立的 Decisions 客户端。

「Jarvis」与「模型服务」入口只在 Desktop Renderer 注册。Desktop 设置菜单移除「会话导入」和「定时任务」入口。Web 可从原有的侧栏导入会话，定时任务仍可从 Desktop 官方入口打开。
