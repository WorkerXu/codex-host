# Jarvis `@` 引用

Codex Composer 的原生 `@` 菜单提供「工作台」分组，里面有一行「Jarvis」。输入 `@` 后的文字不会触发 Jarvis 搜索；只有选中这一行，才进入 Bug 搜索模式。选中 Bug 后插入 Desktop 原生 mention chip，提交时再由 Host 展开为可读上下文。

## 入口与模式

- 「Jarvis」行与「钉钉」行同处一个「工作台」分组，分组是原生 `@` 菜单 `[data-mention-list-scroll-area]` 滚动容器里的普通 section：`data-codexhost-workbench-section` / `data-mention-section-id="codexhost-workbench"`，标题与行使用原生 header / button 类名，行是 `[data-list-navigation-item]` 按钮。两个入口共用同一个 section，谁先出现谁创建，另一个复用，永远只有一条「工作台」标题。
- 原生菜单在 `input` 事件之后才挂载；Renderer 会在约 300 ms 内分多次重试，并继续用 `MutationObserver` 观察，等原生列表出现后再插入。原生列表始终不出现时什么都不画，不再自建浮层。
- 行只在查询为空或是 `jarvis` / `贾维斯` 前缀时显示为「Jarvis · 搜索 Bug」；其他自然语言查询显示一行「Jarvis：<文字>」（单行截断）。选中后先删除 `@<文字>`，再打开已预填该文字的搜索模式并立即查询；输入过程中仍然不调用 Host。
- 选中后进入 Bug 搜索模式。原生弹层只提供 Composer 顶边的锚点，随即隐藏；Renderer 在它原来的位置自建固定浮层：
  - 浮层底边贴住 Composer 顶边，内容向上生长；结果少时高度收缩回 Composer，不保留原生弹层的旧高度；
  - 浮层高度受 Composer 上方可用空间限制，结果区是唯一的滚动面，支持鼠标滚轮和触控板；
  - 顶部是 Jarvis 图标 +「‹ Jarvis · Bug」返回头；
  - 下面是自动聚焦的搜索框、条件 chip 和结果计数；
  - 结果行是两行、最小 48 px 行高、12 px 横向内边距：首行是 Bug 图标、`#id`、标题和状态 pill（未解决橙/红、已解决绿、已关闭灰）；次行是项目名标签、优先级圆点与文字、严重程度和相对时间；
  - 已解析条件显示为可删除 chip；删除后按剩余条件重新查询；
  - 方向键选择、Enter 插入、Esc 或返回箭头关闭模式并回到 Composer；
  - 加载时显示骨架行和「搜索中…」；超过 8 秒显示「Jarvis 响应较慢，仍在查询…」；空结果显示「没有符合条件的 Bug」并保留条件 chip；错误显示中文错误，不静默变成「无结果」。
- 原生弹层被 Desktop 关闭不影响模式；退出时移除自建浮层并恢复原生面板的可见性。
- 键盘与原生行共用一套状态：原生高亮行带 `aria-current="true"` 和 `bg-secondary-ghost-hover opacity-100`。方向键越过最后一个原生行后依次选中「工作台」两行并清掉原生高亮，向上逐行返回，最后回到最后一个原生行；未选中「工作台」行时不拦截原生导航。React 重渲染丢弃该分组时会重新追加，并保持它是最后一个 section。

## 搜索流水线

Renderer 不直接调用 CLI：`@` 查询固定先发给 Desktop 本地 Host（Mac）的 Jarvis。Gemini key 使用本地 `~/.config/codexhost/gemini-api-key`，不传给 Renderer 或远程 Host。远程 Host 不读取 key、不执行查询理解，搜索返回 `local_only` 错误。

1. **整句理解**：本地 Host 默认把完整查询交给 OpenAI `gpt-4.1-mini`，通过 Chat Completions 的 `response_format: json_schema`、`strict: true` 返回固定字段：`scope`、`statuses`、`priorities`、`severities`、`order`、`timeWindow`、`titleKeywords`、`projectNames`、`unrecognized`。空数组表示不限对应条件，时间范围为空时为 `null`。时间区间使用 Unix 毫秒，包含 `since`、不包含 `until`，`field` 区分创建和更新时间。
2. **上海时区与校验**：请求带上当前时刻、`Asia/Shanghai` 时区、当天日期和今天、昨天、本周、上周、本月的边界，模型据此换算相对时间。“最近的”只表示排序，不自动添加时间范围。JSON Schema 的对象禁止额外属性、所有属性必填、可空字段使用类型联合；返回 JSON 必须通过共享契约的 Zod schema 校验，不接受部分字段或不合法的时间区间。
3. **失败直接显示错误**：从读取模型选择、key 到响应读取、校验共用 3 秒截止时间。未配 key、网络或 API 失败、超时、JSON/schema 不合法，以及存在无法理解的片段时，页面显示错误；不执行规则解析、不继续查询 Bug、不回退远程 Host。错误区只显示中文原因和“去设置”入口：402、`insufficient_quota` 或额度类 429 为“OpenAI 额度不足”，401/403 为“OpenAI Key 无效”；普通 429 显示请求过于频繁，并区分未配密钥、超时、网络失败和输出非法，不展示 API 错误原文，也不保留上次查询的结果或条件。失败结果以 `source=openai|gemini` 标记模型服务，成功结果以 `source=model` 标记结构化解析。“去设置”打开通用页顶部的模型服务区。
4. **按模型点名解析项目**：只有 `projectNames` 参与 `project list --scope visible --name <项目名>` 搜索，并与 `project list` 返回的本人 Bug 关联项目合并去重。项目名不会被缩短成其他搜索词，也不会改作标题关键词；同名迭代项目可以一起命中。用户点名的项目未命中时保留项目条件并返回空结果；没有项目条件时查询本人 Bug 关联项目。项目搜索结果短暂缓存，不预加载全部可见项目。
5. **精确取数与标题查询**：`titleKeywords` 逐个通过 `bug list --title` 查询，多个关键词按 OR 合并；项目与标题条件可以同时生效。作用域为“两者”时分别查询指派给我和我创建的，最终按 `projectId + bugId` 去重。并发 8，每次 CLI 查询每页 100 条、最多 200 条，最多查询 40 个项目，最多显示 200 条；达到限制时在 UI 标记截断。多个关键词或作用域可能重叠，截断时不把各查询的服务端总数直接相加。
6. **本地过滤与排序**：状态、优先级、严重程度、标题关键词和时间窗口在本地再校验；Jarvis 无时区的时间戳按上海时间解读。按模型返回的顺序和时间字段排序；无时间字段时最新按更新时间、最早按创建时间。解析后的条件仍使用现有 chip 和稳定 key，删除 chip 会把该 key 作为 `omit` 传给 Host，并去掉对应条件。

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
- 未安装或未登录的 Host 不返回搜索结果；`@` 入口仍可打开，模式内显示「Jarvis 未安装或未登录」一类提示。
- 机器行的平台字段转成用户能读的名字（例如 `darwin-arm64` 显示为「macOS（Apple 芯片）」）。阈值配置保留读写兼容性，默认 0.5；整句结构化理解不使用阈值，设置页不提供阈值输入控件。

## 边界

- `shared-contracts` 只放路径、Bug/条件数据类型和 RPC schema，保持浏览器安全。
- `renderer-extension` 只做 DOM、防抖、过期响应丢弃、条件 chip 和 chip 插入，不直接调用 CLI 或网络。
- CLI、模型服务、下载、SHA256 和 SSH 转发全部在 `host-runtime`，远程机器只执行本机只读查询。
- Jarvis 命令只允许 `list`、`detail`、`context`、`project list`；搜索路径不执行任何写操作。

## 共享模型服务

通用页的「模型服务」管理 OpenAI 和 Gemini 的 API Key、保存/清除、测试和解析模型。该区复用通用页的卡片行布局，Key 行平时只显示配置后缀、连接状态与测试/更换/清除操作；添加或更换时展开掩码输入、保存和取消，保存成功直接更新状态。解析模型位于卡片第三行，使用带选中标记、方向键与 Esc 支持的菜单。默认 `OpenAI · gpt-4.1-mini`，可显式选择 `Gemini · gemini-3.5-flash-lite`（`generateContent` + JSON `responseSchema`）。一个 Provider 出错不会自动尝试另一个 Provider。测试只验证所选服务的结构化响应能力，并返回耗时或稳定错误码。

`model-service-settings.ts` 的 `ModelServiceSettingsStore` 在 Desktop 本地 Host 读取 `~/.config/codexhost`：复用 `gemini-api-key`，新增 `openai-api-key`，模型选择写入 `model-service.json`；原子写入，文件权限 0600。`readKey(provider)` 只供 Host 内部使用；公开 `read()/update()` 与 `codexhost/model-service/get|set|test` 只返回 `configured` 和末四位，不回传密钥。Renderer 不持久化密钥，保存成功后清空密码输入框。远程 Host 不注册这些共享设置 RPC。

`structured-query-client.ts` 公开 `createStructuredQueryClient({provider, readApiKey, fetchImpl?})`。调用 `query({instructions, input, schema, name}, validator)` 提交业务提示词和严格 JSON Schema，再通过业务校验器返回结果；模型选择函数、读 key、网络、响应体均在同一个 3 秒截止时间内。客户端只抛 `StructuredQueryError` 的稳定错误码，原始服务错误不进入 UI。`jarvis-query-parser.ts` 负责 Jarvis 提示词和上海时间上下文。

钉钉 dispatcher 后续可在自己的 Host 组合层复用该设置 Store 和结构化客户端，传入匹配 Agent 所需的独立提示词、schema 与校验器，不复用 Jarvis 的查询语义。当前钉钉分发路径保持原状。

设置菜单不注册「会话导入」或「定时任务」页面。会话导入的 Host 服务、CLI、独立页面工厂，以及官方定时任务能力保留；这些页面工厂没有默认设置路由。
