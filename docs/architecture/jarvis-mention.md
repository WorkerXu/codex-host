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

Renderer 不直接调用 CLI：`@` 查询固定先发给 Desktop 本地 Host（Mac）的 Jarvis；只有本地未安装、未登录或不可达时才回退到 Composer Thread 所在的 Host。本地 Host 的 Gemini key 与登录状态因此对所有 Thread 生效。

1. **规则优先**：在 Host 本地解析作用域（我的/指派给我、我创建/我提的、两者）、状态（未解决/已解决/已关闭）、优先级、严重程度、时间词（今天、昨天、本周、上周、最近 N 天）和排序词（最新/最早）。规则能确定的字段不再询问模型。
2. **Gemini Decisions 只处理规则未覆盖的条件字段**：一次请求里只包含未确定的 `choice` / `noul` 问题。没有 key、超时或低于阈值时保留规则默认值。key 只保存在本地 Host；远程 Host 只用规则，不读取 key。
3. **按需解析项目**：先抽取「标题/题目/名称 + 有/含/包含/带/是/叫/关于 + 关键词」「关键词在标题里」「标题里有关键词」等标题条件，去掉关键词末尾的「的」「bug」「问题」，再去掉其余条件词。只有剩余文本参与项目解析，字段词和连接词不作为项目候选。剩余短语从长到短处理；先匹配 `project list` 返回的「本人 Bug 关联项目」，并结合 `project list --scope visible --name <短语>` 判断。模糊命中超过 3 个项目且短语不包含完整项目名时，不添加项目条件，原短语保留为标题关键词候选；明确项目名仍支持多个迭代项目。未命中的剩余文本与显式标题关键词共同作为 `bug list --title` 关键词，因此项目与标题条件可同时生效。项目名搜索与 `auth status`、`project list` 并行启动；项目是否命中只由项目列表和项目搜索决定，Gemini 不能把已命中的项目改写成标题关键词。项目搜索结果短暂缓存，搜索过程中不预加载全部项目。
4. **精确取数**：有项目条件时只查这些项目；没有时并行查询 `project list` 返回的每个项目（并发 8）。作用域为「两者」时分别查询指派给我和我创建的，按 `projectId + bugId` 去重。每页 100 条，最多 200 条；超过上限时在 UI 标注「仅显示前 N 条」。
5. **本地过滤与排序**：状态、优先级、严重程度、时间窗口在本地再校验；按请求的时间字段排序，默认按 `updateTime` 最新优先。
6. **可选语义排序**：只有仍留有自由描述文本且结果较多、用户没有指定顺序时，才用既有 score question 重排；重排不删除任何结果。
7. 解析后的条件与结果一起返回。每个 chip 有稳定的 key，删除 chip 会把该 key 作为 `omit` 传给 Host，Host 按同一查询重新解析并去掉对应条件。

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

设置页「Jarvis」只列标题，不加页面或区块副标题：一栏是可选的 Gemini API Key，一栏是已安装的机器。机器列表包含本地 Host 和 Desktop 已配置的 SSH 连接，由顶部唯一的「刷新」按钮整批更新，每行不再单独提供刷新：

- **安装**：目标 Host 先通过公开 release API 自动下载。3 秒探测低于约 128 KB/s 时返回 `relay-required`；本地 Host 下载并校验后，由 Renderer 以 512 KB 分片经 Host RPC 推送到目标，目标完成 SHA256/大小校验后原子替换 `~/.local/bin/jarvis` 并运行 `version --json`。
- **登录**：目标 Host 运行 `jarvis login --no-browser` 并返回授权 URL。本地目标直接打开浏览器；远程目标由本地 Host 用 `peers.json` 的 SSH 别名建立 `127.0.0.1:<port>` 本地转发（优先复用原端口，否则改写回调端口），Renderer 轮询目标 Host 的 `auth status` 直到成功，然后关闭转发。
- 未安装或未登录的 Host 不返回搜索结果；`@` 入口仍可打开，模式内显示「Jarvis 未安装或未登录」一类提示。
- 机器行的平台字段转成用户能读的名字（例如 `darwin-arm64` 显示为「macOS（Apple 芯片）」）。Gemini 判定阈值仍保存在设置里，默认 0.5，但设置页不再提供输入控件。

## 边界

- `shared-contracts` 只放路径、Bug/条件数据类型和 RPC schema，保持浏览器安全。
- `renderer-extension` 只做 DOM、防抖、过期响应丢弃、条件 chip 和 chip 插入，不直接调用 CLI 或网络。
- CLI、Gemini、下载、SHA256 和 SSH 转发全部在 `host-runtime`，远程机器只执行本机只读查询。
- Jarvis 命令只允许 `list`、`detail`、`context`、`project list`；搜索路径不执行任何写操作。
