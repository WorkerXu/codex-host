# Jarvis `@` 引用

Codex Composer 的原生 `@` 菜单提供「工作台」分组，里面有一行「Jarvis」。输入 `@` 后的文字不会触发 Jarvis 搜索；只有选中这一行，才进入两段式搜索：先选项目，再搜这个项目里的 Bug。选中 Bug 后插入 Desktop 原生 mention chip，提交时再由 Host 展开为可读上下文。

## 入口与模式

- 「Jarvis」行与「钉钉」行同处一个「工作台」分组，分组是原生 `@` 菜单 `[data-mention-list-scroll-area]` 滚动容器里的普通 section：`data-codexhost-workbench-section` / `data-mention-section-id="codexhost-workbench"`，标题与行使用原生 header / button 类名，行是 `[data-list-navigation-item]` 按钮。两个入口共用同一个 section，谁先出现谁创建，另一个复用，永远只有一条「工作台」标题。
- 原生菜单在 `input` 事件之后才挂载；Renderer 会在约 300 ms 内分多次重试，并继续用 `MutationObserver` 观察，等原生列表出现后再插入。原生列表始终不出现时什么都不画，不再自建浮层。
- 行只在查询为空或是 `jarvis` / `贾维斯` 前缀时显示为「Jarvis · 搜索 Bug」；其他自然语言查询显示一行「Jarvis：<文字>」（单行截断）。选中后先删除 `@<文字>`，再打开两段式面板并把该文字作为第一步的项目搜索词；输入过程中仍然不调用 Host。
- 选中后进入自建固定浮层。原生弹层只提供 Composer 顶边的锚点，随即隐藏；浮层底边贴住 Composer 顶边，内容向上生长，高度受 Composer 上方空间限制，结果区是唯一的滚动面。
- 面板有两个步骤，同一个浮层内切换，不叠加第二个弹窗：
  - **项目**：顶部是「‹ Jarvis · 项目」返回头、自动聚焦的搜索框、「我的项目 / 搜索结果」列表；每行是文件夹图标、项目名和右箭头；方向键选择、Enter 或点击进入第二步。
  - **Bug**：顶部是「‹ Jarvis · Bug」，下面依次是项目 chip（可删除，删除即回到第一步）、已解析条件 chip、结果计数、结果行。搜索框里输入文字只做标题预览；按 Enter 才调用 Gemini 解析其余条件。
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
2. 输入框文字变化时只做标题预览：`bug list --project-id N --title <原文>`（默认「指派给我」范围），约 0.3 秒返回并立即显示。预览不经过模型，因此输入过程中面板始终有反馈。
3. 按 Enter（且没有高亮结果行）才提交条件解析。Host 复用 `JarvisBugSearcher` 的固定项目路径：Gemini `gemini-3.5-flash-lite` 只解析其余条件（状态、优先级、严重程度、时间窗口、指派给我 / 我创建的、排序、标题关键词），再在该项目内取数、过滤、排序。返回后替换标题预览，并展示条件 chip。
4. **8 秒保护**：Renderer 给解析请求 8 秒截止时间；超时或解析失败时取消 Host 请求，保留标题预览结果，在计数位置显示「条件未识别，已按标题搜索」。解析途中如果标题预览已经返回，先显示预览，绝不让面板空等。
5. 条件 chip 仍使用稳定 key。点掉 chip 会把该 key 作为 `omit` 重新解析；项目 chip 不参与 `omit`，只负责回到第一步。
6. 取数上限沿用现有规则：每个查询每页 100 条、最多 200 条，最多显示 200 条；达到上限时标注「已显示前 N 条」。
7. 错误码沿用 Host 约定并转成中文：`not_logged_in` →「未登录 Jarvis」，`not_installed` →「未安装 Jarvis」，`timeout` / `cli_failed` / `network` →「网络失败，请稍后重试」；空结果显示「无结果」。

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

设置页「Jarvis」只显示已安装的机器，不加页面或区块副标题。机器列表包含本地 Host 和 Desktop 已配置的 SSH 连接，由顶部唯一的「刷新」按钮整批更新，每行不再单独提供刷新：

- **安装**：目标 Host 先通过公开 release API 自动下载。3 秒探测低于约 128 KB/s 时返回 `relay-required`；本地 Host 下载并校验后，由 Renderer 以 512 KB 分片经 Host RPC 推送到目标，目标完成 SHA256/大小校验后原子替换 `~/.local/bin/jarvis` 并运行 `version --json`。
- **登录**：目标 Host 运行 `jarvis login --no-browser` 并返回授权 URL。本地目标直接打开浏览器；远程目标由本地 Host 用 `peers.json` 的 SSH 别名建立 `127.0.0.1:<port>` 本地转发（优先复用原端口，否则改写回调端口），Renderer 轮询目标 Host 的 `auth status` 直到成功，然后关闭转发。
- 未安装或未登录的 Host 不返回搜索结果；`@` 入口仍可打开，模式内显示「未登录 Jarvis」或「未安装 Jarvis」一类的具体提示。
- 机器行的平台字段转成用户能读的名字（例如 `darwin-arm64` 显示为「macOS（Apple 芯片）」）。阈值配置保留读写兼容性，默认 0.5；整句结构化理解不使用阈值，设置页不提供阈值输入控件。

## 边界

- `shared-contracts` 只放路径、Bug/条件数据类型和 RPC schema，保持浏览器安全。
- `renderer-extension` 只做 DOM、防抖、过期响应丢弃、条件 chip 和 chip 插入，不直接调用 CLI 或网络。
- CLI、模型服务、下载、SHA256 和 SSH 转发全部在 `host-runtime`，远程机器只执行本机只读查询。
- 第一步的项目搜索和第二步的标题预览都不经过模型；只有第二步的 Enter 提交会调用 Gemini。
- Jarvis 命令只允许 `list`、`detail`、`context`、`project list`；搜索路径不执行任何写操作。第二步只使用 `bug list --project-id`，不查询项目列表。

## 共享模型服务

通用页的「模型服务」只管理 Gemini API Key、保存/清除和测试。该区复用通用页的卡片行布局，Key 行平时只显示配置后缀、连接状态与测试/更换/清除操作；添加或更换时展开掩码输入、保存和取消，保存成功直接更新状态。解析模型位于卡片第二行，右侧以次要文字色静态显示 `Gemini · gemini-3.5-flash-lite`，无箭头或交互。OpenAI Key 文件仍留在磁盘上，但界面不再展示或读取它。Gemini Key 连接测试使用钉钉同款 `gemini-decision-1` Decisions API。测试返回耗时或稳定错误码。

`model-service-settings.ts` 的 `ModelServiceSettingsStore` 在 Desktop 本地 Host 读取 `~/.config/codexhost`：复用 `gemini-api-key`；旧 `openai-api-key` 与 `model-service.json` 只为保留已存文件而继续存在，解析器不再读取其中的选择；原子写入，文件权限 0600。`readKey(provider)` 只供 Host 内部使用；公开 `read()/update()` 与 `codexhost/model-service/get|set|test` 只返回 `configured` 和末四位，不回传密钥。Renderer 不持久化密钥，保存成功后清空密码输入框。远程 Host 不注册这些共享设置 RPC。

`structured-query-client.ts` 公开 `createStructuredQueryClient({provider, readApiKey, fetchImpl?})`。调用 `query({instructions, input, schema, name}, validator)` 提交业务提示词和严格 JSON Schema，再通过业务校验器返回结果；Gemini 请求使用 `systemInstruction`、`contents` 和 `generationConfig.responseSchema`，并为可空字段写回 `nullable`。Jarvis 固定使用 Gemini 与 `gemini-3.5-flash-lite`，读 key、网络、响应体均在同一个 20 秒截止时间内（共享客户端的默认截止时间仍为 3 秒）。客户端只抛 `StructuredQueryError` 的稳定错误码，原始服务错误不进入 UI。`jarvis-query-parser.ts` 负责 Jarvis 提示词和上海时间上下文。

钉钉 dispatcher 只复用该设置 Store 的 Gemini Key 存储，不复用 Jarvis 查询解析或结构化客户端。匹配继续使用独立的 Gemini Decisions API 与 `gemini-decision-1` 模型，不受通用页「解析模型」选择影响；详见[钉钉派发](dingtalk.md#智能体监听与派发)。

设置菜单不注册「会话导入」或「定时任务」页面。会话导入的 Host 服务、CLI、独立页面工厂，以及官方定时任务能力保留；这些页面工厂没有默认设置路由。

Gemini Decisions 只支持 `noul`、`choice`、`score` 三类封闭问题，输出概率、固定选项或分数，不能抽取任意标题关键词、项目名或返回自定义 JSON schema，故不作为 Jarvis 解析模型。能力依据：[Google Decisions API 文档的 “Decisions API or structured output”](https://aistudio.google.com/docs/decisions-api)。钉钉的候选智能体评分仍使用该 Decisions 模型。
