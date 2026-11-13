# Jarvis `@` 引用

Codex Composer 的原生 `@` 菜单可以附加 Jarvis 项目、需求、任务和 Bug。原生菜单行为仍由 Desktop 负责；Host 只补充数据，并在提交时把引用展开成 Agent 可读的上下文。

## 引用与选择

- Renderer 检测光标前的 `@query`，停止输入约 300 ms 后请求建议。原生菜单打开时，Jarvis 分组追加到原生列表底部；原生菜单没有结果或已关闭时，同一组行停靠在 Composer 上的浮动面板。
- 行按 `project` / `requirement` / `task` / `bug` 分组，携带标题、`#id`、状态，Bug 额外显示可解析的指派人和创建人。
- 选择后替换 `@query` 为 Desktop 原生 mention chip。chip 的路径由 `shared-contracts` 定义：
  - `jarvis://bug/<projectId>/<bugId>`
  - `jarvis://project/<projectId>`
  - `jarvis://requirement/<requirementId>`
  - `jarvis://task/<taskId>`
- 控制器不可用时，Renderer 退化为插入 Markdown carrier（`[@Label](jarvis://…)`），与 `#` 委派引用同一回退路径。

## 提交时展开

`turn/start`、`turn/steer` 和外部 Harness 的 steering 都会在 Host 内经过 `jarvis-mention-rewrite.ts`：

- 每个 carrier 调用运行 Thread 的那台机器上的 `jarvis` CLI（Bug 优先 `bug context`，失败回退 `bug detail`；其余用 `detail`）。
- 原文保留为可读的 `@Label`，随后追加一段 `[codexhost Jarvis]` 上下文块，包含标题、网页链接和详情 JSON（超长截断）。
- CLI 失败不阻断 Turn，只在上下文块中写入一行「Jarvis 详情获取失败：…」。
- 官方 Codex 与所有外部 Harness 共用这条路径，因此不依赖 Harness 是否支持附件或结构化输入。

## 搜索流水线

每个 settled query：

1. 本地 Host 用 Gemini Decision 1 判定 `is_jarvis` 和 `kind`；低于设置阈值直接返回空。
2. 目标 Host 从自己的候选池返回该类型的候选。候选池由 `project list`、每个项目的 `bug list`（指派给我和由我创建）、`requirement list`、`task list` 构建，内存缓存 5 分钟，过期后先返回旧池并在后台刷新；首次为空时按需等待刷新。它是“我的条目”数据，不调用 Jarvis 关键词搜索。
3. 本地 Host 对最多 200 个候选发一次 `score` 请求，按分数取前 8 个。每个 score question 的 instructions 包含对应候选，模型才能区分同一批里的条目。

Gemini key 只保存在本地 Host 的 `~/.config/codexhost/gemini-api-key`（0600）。远程 Host 不上传、不读取该文件，只提供候选与详情。

## 机器管理

设置页「Jarvis」列出本地 Host 和 Desktop 已配置的 SSH 连接：

- **安装**：目标 Host 先通过公开 release API 自动下载。3 秒探测低于约 128 KB/s 时返回 `relay-required`；本地 Host 下载并校验后，由 Renderer 以 512 KB 分片经 Host RPC 推送到目标，目标完成 SHA256/大小校验后原子替换 `~/.local/bin/jarvis` 并运行 `version --json`。
- **登录**：目标 Host 运行 `jarvis login --no-browser` 并返回授权 URL。本地目标直接打开浏览器；远程目标由本地 Host 用 `peers.json` 的 SSH 别名建立 `127.0.0.1:<port>` 本地转发（优先复用原端口，否则改写回调端口），Renderer 轮询目标 Host 的 `auth status` 直到成功，然后关闭转发。
- 未安装或未登录的 Host 不返回候选，因此 `@` 菜单不会出现该 Host 的 Jarvis 分组，也不会显示错误行。

## 边界

- `shared-contracts` 只放路径、数据类型和 RPC schema，保持浏览器安全。
- `renderer-extension` 只做 DOM、防抖、过期响应丢弃和 chip 插入，不直接调用 CLI 或网络。
- CLI、Gemini、下载、SHA256 和 SSH 转发全部在 `host-runtime`，远程机器只执行本机操作。
