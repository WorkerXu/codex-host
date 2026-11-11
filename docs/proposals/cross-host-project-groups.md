# 跨机项目组（Cross-host Project Groups）A 阶段调研报告

- 日期：2026-11-11
- 仓库：`/home/ubuntu/work/codex-host-groups`
- 分支：`feat/cross-host-project-groups`，基线 `d8676fc6`
- 目标机器：Mac mini（macOS 15.3.1），Codex Desktop `26.1027.61615`，Chromium 156
- 调研方式：只读阅读仓库源码；SSH 到 Mac 读取 `~/.codex/.codex-global-state.json`；通过 loopback CDP 执行只读 `Runtime.evaluate` 和 `window.electronBridge.getInitialSidebarBootstrap()`；读取 `ChatGPT.app/Contents/Resources/app.asar` 的字符串与片段。
- 只读声明：本阶段没有修改仓库代码、没有 commit、没有点击/输入/修改 Desktop DOM，也没有改 Mac 上任何文件或状态。唯一写入是本报告。

> 说明：Desktop 是压缩后的产物，没有 source map。下文对 Desktop 内部实现的引用使用 **`app.asar` 字节偏移 + 符号名/片段**，对仓库代码使用 **文件:行号**。两者都是证据，但 Desktop 的内部实现不是公开契约。

---

## 0. 结论速览

| # | 问题 | 一句话结论 |
| --- | --- | --- |
| 1 | `persisted-atom-sync` 能否读到 4 个键 | **不能直接读**。该通道只发送 `electron-persisted-atom-state` 这个桶；4 个项目键在 `.codex-global-state.json` 顶层，不在桶里。`getInitialSidebarBootstrap()` 能同步拿到其中 3 个键，但 preload 缓存第一次结果，只能当初始快照；新鲜数据应由本地 Host 只读该 JSON 文件并经 RPC 返回。 |
| 2 | 项目列表 DOM | 项目行、项目列表、对话行都有 `data-app-action-sidebar-*` 原生属性；这些属性正是 Desktop 自己的 `app.get_summary` 和 sidebar app actions 使用的同一套契约。新对话按钮没有 `data-app-action`，但可用项目行内的结构选择器稳定命中。 |
| 3 | 隐藏原生项目行 | 最稳的是 **CSS + `:has()` + `display:none`**，作用在 Projects 列表的直接 `div[role=listitem]` 上；不要移除 DOM。隐藏不触发 React 状态变化，重渲染后选择器仍然生效；功能关闭时删掉样式即可恢复。 |
| 4 | 在指定项目新建对话 | 最可靠的是**点击该项目行原生的「开始新聊天」按钮**。该按钮的 onClick 接收完整 project group（含 `projectKind`/`hostId`/`projectId`），与用户手点完全同路径。Desktop 自己的 sidebar app action 也是用 `.click()` 操作这些原生控件。 |
| 5 | 对话归属与在线状态 | 对话列表以**原生项目列表 DOM**为准（展开的项目才有列表容器）；项目归属用 `thread-project-assignments` 校验；在线状态优先读项目行的原生状态图标， authoritative fallback 是 `CodexSshClient.state(hostId)`。折叠/分页项目是主要数据缺口。 |
| 6 | 存储 | 放 `~/.codexhost/project-groups/groups.json`，独立文件、`formatVersion` + `revision` + 原子写；Host Runtime 暴露 `codexhost/project-groups/list|replace`，仅本地 Host 提供。删组只删配置，原生列表立即恢复。 |
| 7 | 兼容性风险 | 最可能坏在 DOM 契约、项目 ID 迁移、新对话按钮语义、React 重渲染注入块。策略是**能力探测 + fail-open**：任何关键契约不满足就移除隐藏样式/注入块，完整回到原生列表，绝不半隐藏。 |
| 8 | 推荐方案 | **DOM companion（MVP）**：不搬 React 节点，只在 Projects 列表外挂一个组块，用 CSS 隐藏成员项目，对话行从原生 DOM 读取并做点击代理。先做存储/RPC/DOM 契约，再做组 UI、新建对话、管理；原生列表搬移只作为二期可选。 |

---

## 1. 数据读取（Q1）

### 1.1 `persisted-atom-sync` 的真实语义

仓库现有代码只在 Thread reference capability 检查里使用这个通道：

- `packages/renderer-extension/src/renderer-thread-reference-persistence.ts:14-17` 从 `window.electronBridge` 取 `sendMessageFromView`；
- 同文件 `:29-33` 监听 `message.type === "persisted-atom-sync"`，并检查 `message.state` 是否有某个 key；
- 同文件 `:36-39` 发送 `{ type: "persisted-atom-sync-request", responsePriority: "critical" }`；
- 同文件 `:64-69` 用 `persisted-atom-update` 写回一个 key。

Desktop 主进程的实现（`app.asar` 偏移 `11290487`，符号 `sendPersistedAtomState`）是：

```js
sendPersistedAtomState(e,t){
  let r=this.globalState.get("electron-persisted-atom-state")??{},
      n=this.browserHostManager.isPrimaryWindowPersistenceOwner(e),
      i={type:"persisted-atom-sync",
         state:Object.fromEntries(Object.entries(r).filter(([t])=>(n||!eeA(t))&&this.windowManager.shouldSyncPersistedAtom(e,t))),
         canWritePrimaryWindowTabPersistence:n};
  ...
}
```

也就是说，`state` 的内容是 **`electron-persisted-atom-state` 这个全局状态桶**，不是整个 `.codex-global-state.json`。主进程在 `persisted-atom-update` 时也只更新这个桶，并通过 `persisted-atom-updated` 推送给窗口。

对 Mac 上当前文件的只读检查结果：

- 顶层有 `local-projects`、`remote-projects`、`thread-project-assignments`、`codex-managed-remote-connections`；
- `electron-persisted-atom-state` 里 **这 4 个键都不存在**（该桶当前有 1342 个 key）；
- 因此 `persisted-atom-sync` 的 `state` 里不会出现这 4 个键。

**结论：不能把 `persisted-atom-sync` 当作项目数据源。** 现有代码能用它，只是因为 `thread-reference-capability:*` 恰好是 atom 桶里的键。

### 1.2 可用的原生读取面：`getInitialSidebarBootstrap`

Desktop 的 preload 暴露了同步方法 `window.electronBridge.getInitialSidebarBootstrap()`（`app.asar` 偏移 `16054992` / `12712416`，主进程 IPC handler 在 `12970262`）。它返回：

```ts
{
  globalStateEntries: Array<{ key: string; value: unknown }>,
  catalogEntries: ...,
  catalogHostIds: ...,
  workspaceRootOptions: ...,
  projectlessWorkspaceRoot: ...
}
```

我在 Mac 的 Renderer 里只读调用了一次，`globalStateEntries` 的 key 是固定的 16 个（`app.asar` 偏移 `11784000` 的 `ept` 数组）：

```text
local-projects
selected-project
project-appearances
pinned-thread-ids
pinned-project-ids
sidebar-project-thread-orders
sidebar-thread-metadata
thread-project-assignments
thread-workspace-root-hints
projectless-thread-ids
remote-projects
project-order
connection-group-order
remote-cwds-by-host-and-workspace
added-remote-control-env-ids
remote-connection-auto-connect-by-host-id
```

其中已经包含需求里的 3 个键：

- `local-projects`
- `remote-projects`
- `thread-project-assignments`

**不包含** `codex-managed-remote-connections`。

**重要限制：bootstrap 在 preload 里被缓存了。** `app.asar` 偏移 `16054992` 的 preload 代码是：

```js
getInitialSidebarBootstrap: () => (
  void 0 === r && (r = ipcRenderer.sendSync("codex_desktop:get-initial-sidebar-bootstrap")),
  r
)
```

也就是说，第一次调用之后，同一个 Renderer 再调用只会拿到**同一个初始快照**，不会刷新。它只能作为“窗口加载时的初始目录”，不能当实时数据源。

### 1.3 更新时机与新鲜数据

Desktop 主进程在项目状态变化时会向所有窗口广播：

- 项目目录变化：`windowManager.sendMessageToAllWindows({ type: "global-state-updated", keys: [LOCAL_PROJECTS] })`（`app.asar` 偏移 `12649467` 附近）；
- 项目增删/远程项目变化：`#iz([REMOTE_PROJECTS])` 等（`app.asar` 偏移 `11784778` 附近）；
- Thread 归属变化：`windowManager.sendMessageToAllWindows({ type: "thread-project-memberships-updated", memberships })`（`app.asar` 偏移 `12199751`、`12649364`）。

这些消息确实以 window `message` 事件到达扩展。preload（`app.asar` 偏移 `9885627`）统一转发：

```js
ipcRenderer.on("codex_desktop:message-for-view", (e, t) => {
  ...
  window.dispatchEvent(new MessageEvent("message", { data: t }));
});
```

现有 `renderer-thread-reference-persistence.ts:29-33` 也是在这个事件上监听 `persisted-atom-sync`，可以互相印证。

Desktop 自己的 Renderer 收到 `global-state-updated` 后会 invalidate `get-global-state` query（`app.asar` 偏移 `377267500` 附近）：

```js
case `global-state-updated`:
  ...
  for(let t of e.keys)
    c.invalidateQueries({queryKey: Ec(`get-global-state`,{key:t})});
```

**因此正确的新鲜数据路径不是“重读 bootstrap”，而是：**

1. 启动时用 bootstrap 拿初始目录（3 个键）；
2. 监听 `global-state-updated` / `thread-project-memberships-updated` 作为“该刷新了”的信号；
3. 通过本地 Host Runtime 的只读 RPC 重新读取 `.codex-global-state.json` 的目标键（Host 和 Desktop 同机同用户；Renderer 不能直接用 `fs`）；
4. 用 DOM 作为项目行/对话行/状态的实时视图。

**实测注意：bootstrap 会落后于文件。** 当前一次调用返回 `thread-project-assignments` 155 条，而同一时刻文件里是 159 条；说明窗口加载后状态已经变化，且 preload 缓存不会更新。这进一步证明它只能做初始快照。

### 1.4 `codex-managed-remote-connections` 与新鲜目录 RPC

这个键不在 bootstrap 的 16 个 key 里，也不在 atom 桶里。建议由本地 Host Runtime 增加一个只读 RPC：

```text
codexhost/desktop-projects/catalog
  params: {}
  result: {
    localProjects: ...,
    remoteProjects: ...,
    threadProjectAssignments: ...,
    codexManagedRemoteConnections: ...,
    projectOrder: ...,
    readAt: string
  }
```

实现要点：

- 路径：`process.env.CODEX_HOME ?? ~/.codex` + `.codex-global-state.json`；
- 只返回目标键，不返回整个 2MB 文件；连接目录只投影 `hostId/displayName/alias/hostname/source`，不返回 `identity`、端口等渲染不需要的字段；
- JSON 解析失败时重试一次（Desktop 可能正在写），仍失败则返回错误或上一份缓存；不要让 Host 崩溃；
- Host 侧可以按文件 `mtimeMs + size` 做几秒缓存，避免每次 UI 刷新都解析 2MB；
- 只有本地 Host 提供这个 RPC；远程 Host 拒绝。

现有 `CodexSshClient.list()`（`packages/renderer-extension/src/codex-ssh-adapter.ts:132-176`）也能拿连接目录，但它调用的是原生 `refresh-remote-connections`，可能触发连接探测，不建议作为高频读取路径。它更适合连接设置页，不适合项目组刷新。

**建议：MVP 用 Host 只读 RPC 统一拿 4 个键。** bootstrap 只做初始提示和 Host RPC 失败时的降级；不要依赖 bootstrap 刷新。

### 1.5 Q1 结论

- `persisted-atom-sync`：**不可用**于 4 个项目键。
- `getInitialSidebarBootstrap`：**可用但只限初始快照**，preload 会缓存第一次结果；不能用来刷新。
- 新鲜数据：本地 Host 只读 `.codex-global-state.json` 的 4 个目标键，经 `codexhost/desktop-projects/catalog` 返回；项目/对话的实时视图用 DOM。
- 更新信号：`global-state-updated` 和 `thread-project-memberships-updated` 以 window `message` 事件到达，debounce 后触发 Host 重读。

---

## 2. 项目列表 DOM（Q2）

### 2.1 层级结构

当前 Desktop 的 Projects 区域结构（只读 DOM 观察）：

```text
section[data-app-action-sidebar-section]
  data-app-action-sidebar-section-heading="Projects"
  data-app-action-sidebar-section-collapsed="false"
  └─ div.group/nav-section
      ├─ div (标题行，含 data-app-action-sidebar-section-toggle)
      └─ div[aria-hidden="false"]
          └─ div.overflow-hidden
              └─ div.group/nav-list[data-appearance="plain"]
                  └─ div[role="list"]                 ← 12 个项目单元
                      └─ div[role="listitem"].touch-pan-y   ← 直接 flex 子项
                          └─ div.overflow-hidden
                              └─ div[role="listitem"][aria-label="<project label>"]
                                  ├─ span
                                  │   └─ div[data-app-action-sidebar-project-row]
                                  └─ div[data-app-action-sidebar-project-list-id="<projectId>"]
                                      └─ div[role="list"] ...
```

关键点：

- 每个项目是一个 `div[role="listitem"].touch-pan-y`，是 `div[role="list"]` 的**直接子项**；
- 项目行和它的对话列表都在这个项目单元里；
- `div.group/nav-list` 是 Projects 的 flex 容器，`div[role="list"]` 是它唯一的子项。**这是我们注入组块的最佳位置**：把组块插到 `div[role="list"]` 前面，位于 React 的 keyed list 之外，不参与项目列表的 reconciliation。

### 2.2 稳定属性/选择器

| 目标 | 选择器/属性 | 观察到的值/说明 |
| --- | --- | --- |
| Projects 区域 | `section[data-app-action-sidebar-section][data-app-action-sidebar-section-heading="Projects"]` | heading 值是英文 `Projects`，即使 UI 语言是中文；比可见文本稳定 |
| 项目列表 | `section[...] div[role="list"]` | 直接子项是项目单元 |
| 项目单元 | `div[role="list"] > div[role="listitem"]` | 12 个；`class` 含 `touch-pan-y`，但不要依赖 class |
| 项目行 | `[data-app-action-sidebar-project-row]` | 当前 12 个 |
| 项目 ID | `data-app-action-sidebar-project-id` | 远程项目为 UUID；本地项目可能是 `local-<hash>` 或 UUID |
| 项目名 | `data-app-action-sidebar-project-label` | 原始 label，不含机器名 |
| 折叠状态 | `data-app-action-sidebar-project-collapsed` | `"true"` / `"false"` |
| 项目对话列表 | `[data-app-action-sidebar-project-list-id="<projectId>"]` | **只有展开的项目才有**；折叠项目没有这个容器 |
| 是否显示全部 | `data-app-action-sidebar-project-show-all` | `"true"` / `"false"` |
| 显示更多开关 | `[data-app-action-sidebar-project-show-all-toggle]` | 当前 DOM 未渲染；源码有定义 |
| 对话行 | `[data-app-action-sidebar-thread-row]` | 当前 42 行（包含 Recents 重复） |
| 对话 ID | `data-app-action-sidebar-thread-id` | 形如 `local:<id>` 或 `local:client-new-thread:<id>` |
| 对话 Host | `data-app-action-sidebar-thread-host-id` | `local` 或 `remote-ssh-discovered:<alias>` |
| 对话标题 | `data-app-action-sidebar-thread-title` | 与可见标题一致 |
| 选中/激活 | `data-app-action-sidebar-thread-selected` / `-active` | `"true"` / `"false"` |
| 置顶 | `data-app-action-sidebar-thread-pinned` | `"true"` / `"false"` |
| 项目菜单 | `row.querySelector('button[aria-haspopup="menu"]')` | `aria-label="<label> 的项目操作"` |
| 新对话 | `row.querySelector('button:not([aria-haspopup]):not([data-app-action-sidebar-select-project])')` | 当前每个项目恰好命中 1 个；`aria-label="在 <label> 中开始新聊天"` |
| 选择项目（隐藏） | `[data-app-action-sidebar-select-project]` | `class="sr-only"`；Desktop 自己的 `windows.sidebar.select_project` 就是 `.click()` 它 |

这些 `data-app-action-sidebar-*` 不是随意类名：Desktop 自己的 `app.get_summary` 和 sidebar app actions 使用同一套属性。`app.asar` 偏移 `173744436` 的 selector 常量表里有：

```js
sidebarProjectCollapsed: `data-app-action-sidebar-project-collapsed`,
sidebarProjectCreate: `data-app-action-sidebar-project-create`,
sidebarProjectId: `data-app-action-sidebar-project-id`,
sidebarProjectLabel: `data-app-action-sidebar-project-label`,
sidebarProjectListId: `data-app-action-sidebar-project-list-id`,
sidebarProjectRow: `data-app-action-sidebar-project-row`,
sidebarProjectSelect: `data-app-action-sidebar-select-project`,
sidebarProjectShowAll: `data-app-action-sidebar-project-show-all`,
sidebarProjectShowAllToggle: `data-app-action-sidebar-project-show-all-toggle`,
sidebarSection: `data-app-action-sidebar-section`,
sidebarSectionCollapsed: `data-app-action-sidebar-section-collapsed`,
sidebarSectionHeading: `data-app-action-sidebar-section-heading`,
sidebarThreadActive: `data-app-action-sidebar-thread-active`,
sidebarThreadHostId: `data-app-action-sidebar-thread-host-id`,
sidebarThreadId: `data-app-action-sidebar-thread-id`,
sidebarThreadKind: `data-app-action-sidebar-thread-kind`,
sidebarThreadPinned: `data-app-action-sidebar-thread-pinned`,
sidebarThreadRow: `data-app-action-sidebar-thread-row`,
sidebarThreadSelected: `data-app-action-sidebar-thread-selected`,
sidebarThreadTitle: `data-app-action-sidebar-thread-title`
```

并且 `app.asar` 偏移 `527174818` 的 `register-app-actions` 里，`app.get_summary` 的 sidebar rows 就是读这些 `dataset`：

```js
e.matches(N.sidebarProjectRow)
  ? {type:`project`, projectId:e.dataset.appActionSidebarProjectId, label:e.dataset.appActionSidebarProjectLabel, ...}
  : {type:`thread`, hostId:e.dataset.appActionSidebarThreadHostId, id:e.dataset.appActionSidebarThreadId, title:e.dataset.appActionSidebarThreadTitle, ...}
```

同类源码还显示 `windows.sidebar.select_project` 的实现就是：

```js
let t=S(e).querySelector(N.sidebarProjectSelect);
if(t==null)throw Error(`Missing sidebar project select action`);
t.click();
```

这反过来证明：**对这些原生控件做程序化 `.click()` 是 Desktop 自己承认的操作路径**。

### 2.3 DOM 片段（已脱敏）

项目行：

```html
<div data-app-action-sidebar-project-row
     data-app-action-sidebar-project-id="<projectId>"
     data-app-action-sidebar-project-label="<label>"
     data-app-action-sidebar-project-collapsed="false"
     role="button" aria-expanded="true" aria-label="<label> <host>">
  ...
  <button aria-haspopup="menu" aria-label="<label> 的项目操作">...</button>
  <button aria-label="在 <label> 中开始新聊天">...</button>
  <button data-app-action-sidebar-select-project class="sr-only"></button>
</div>
```

项目对话列表：

```html
<div data-app-action-sidebar-project-list-id="<projectId>"
     data-app-action-sidebar-project-show-all="false">
  <div role="list" aria-label="<localized>">
    <div role="listitem">
      <div role="group">
        <div data-app-action-sidebar-thread-row
             data-app-action-sidebar-thread-id="local:<id>"
             data-app-action-sidebar-thread-host-id="remote-ssh-discovered:<alias>"
             data-app-action-sidebar-thread-kind="local"
             data-app-action-sidebar-thread-title="<title>"
             data-app-action-sidebar-thread-selected="false"
             role="button">...</div>
      </div>
    </div>
  </div>
</div>
```

远程项目行右侧的机器名与状态：

```html
<span class="flex max-w-48 min-w-0 items-center whitespace-nowrap">
  <span class="min-w-0 truncate text-codex-description">colab</span>
  <span class="flex h-5 shrink-0 items-center justify-center">
    <span aria-label="已连接" role="img" class="... text-chart-green" data-state="closed">
      <span class="block size-2 rounded-full bg-chart-green"></span>
    </span>
  </span>
</span>
```

### 2.4 项目菜单（编辑项目）

- 菜单触发器：`button[aria-haspopup="menu"]`，`aria-label="<label> 的项目操作"`。
- 菜单内容由 Radix 渲染，源码里菜单项定义在 `app.asar` 偏移 `183555122` 附近（`T6n`）：

```js
{id:`edit-project`, icon:d0.edit, message:f0.edit, onSelect:a}
```

其中 `f0.edit` 的默认文案是 `Edit`（中文 UI 显示「编辑」）。菜单项没有 `data-app-action-*` 属性，只能靠 `[role="menuitem"]` + 文本命中；**本地化后会变**。

- 另有项目 hover card 的「Edit project」按钮，`app.asar` 偏移 `182936816` 附近，使用 `aria-label` + 文本，仍是本地化文案。

**本次没有打开菜单**（只读约束）。结论：如果未来需要程序化打开原生「编辑项目」，可靠度低于 sidebar 的 `data-app-action-*` 契约；本功能的「编辑组」不需要它，建议不依赖。

### 2.5 Q2 结论

- 项目行、列表、对话行都有原生 `data-app-action-sidebar-*` 契约，当前版本全部命中；
- 新对话按钮没有 action 属性，但项目行内结构选择器（排除 menu 和 sr-only select）在每个项目上都唯一命中；
- 项目列表只有展开项目才有；折叠项目没有列表容器；
- 菜单项没有稳定 action 属性，编辑项目菜单不适合作为依赖；
- 这些属性是 Desktop 自己自动化同源契约，但仍是内部实现，升级必须 fail-open。

---

## 3. 隐藏原生项目行（Q3）

### 3.1 方案对比

| 方案 | 做法 | 对 React 的影响 | 可恢复性 | 结论 |
| --- | --- | --- | --- | --- |
| 移除 DOM 节点 | `row.remove()` / `unit.remove()` | **高**。React fiber 仍持有节点引用，下一次 commit 可能出现 `insertBefore` 失败、节点被重新创建或状态错位 | 需要重新挂载，可能丢滚动/展开状态 | 不用 |
| 逐个加属性 + CSS | `unit.dataset.codexhostHidden = "1"`，样式 `[data-codexhost-hidden]{display:none}` | 低。只改属性，不改树 | 删属性即可 | 可用 |
| 纯 CSS `:has()` | `<style>` 里生成 `div[role=list] > div[role=listitem]:has([data-app-action-sidebar-project-id="X"]) { display:none!important }` | **最低**。不碰 React 节点，重渲染后选择器自动匹配新节点 | 删除样式即可 | **推荐** |

### 3.2 推荐做法

在扩展里维护一份 `<style data-codexhost-project-groups>`，按当前组配置生成规则：

```css
section[data-app-action-sidebar-section][data-app-action-sidebar-section-heading="Projects"]
  div[role="list"] > div[role="listitem"]:has(
    [data-app-action-sidebar-project-row][data-app-action-sidebar-project-id="<escapedId>"]
  ) {
  display: none !important;
}
```

要点：

- 只作用于 Projects 区域的直接 listitem，避免误伤 Recents 或其他列表；
- 项目 ID 用 `CSS.escape`；
- 一个组有多个成员就生成多条规则；
- 删除组/关闭功能时，直接把整个 `<style>` 的 `textContent` 置空或移除 `<style>`；
- 不写 `style` 到 React 节点上，避免 React 重渲染覆盖。

当前 Chromium 156 已支持 `:has()`（CDP `CSS.supports('selector(:has(*))')` 返回 `true`），并且 `:scope > div[role="listitem"]:has(...)` 可以命中目标项目单元（已只读验证）。

### 3.3 React 重渲染影响

- `display:none` 不会卸载组件，项目仍保持展开状态、选中状态、滚动位置和 DOM 身份；
- React 下一次 commit 改的是隐藏节点内部，不会因为隐藏而报错；
- 如果 React 重新创建项目单元，新节点仍然匹配 CSS 规则，不需要重新标记；
- 不会触发 `MutationObserver` 死循环（我们只改 `<style>`，不改项目树）。

### 3.4 注意事项

- `display:none` 会让被隐藏项目不参与布局，可能影响侧边栏滚动位置/高度；Phase B 需要在 Mac 上做一次展开/滚动/切换项目的验收。若出现跳动，可改用 `visibility:hidden; height:0; overflow:hidden; pointer-events:none`，但 `display:none` 更简单，先作为默认。
- 隐藏的是项目单元，不是项目行；这样项目下的对话也不会在原生列表里重复出现。
- 如果成员项目当前正被选中，隐藏后主内容仍停留在该项目；组行可以显示 active 状态。不要因为“选中”而放弃隐藏，否则会出现重复项目。
- 绝不隐藏无法解析的成员：解析失败时保留原生项目，组内显示“成员缺失”，并记录诊断。

### 3.5 Q3 结论

**CSS `:has()` + `display:none` 是当前最稳的隐藏方式。** 不碰 React 树，升级/重渲染的破坏面最小；功能关闭或契约失败时删除样式即可完整恢复。

---

## 4. 在指定原生项目里新建对话（Q4）

### 4.1 可行路径

#### 路径 A（推荐）：点击项目行原生的「开始新聊天」按钮

- 选择器（已对 12 个项目逐一验证，全部唯一命中）：

```js
const button = row.querySelector(
  'button:not([aria-haspopup]):not([data-app-action-sidebar-select-project])'
);
button.click();
```

- 该按钮的 `aria-label` 是 `在 <label> 中开始新聊天`；但选择器不依赖这段本地化文本。
- Desktop 源码（`app.asar` 偏移 `183568000` 附近，项目行组件 `G6n`）显示：
  - `onStartNewThread` 接收到的是完整 `group`，其中包含 `projectKind`、`hostId`、`projectId`；
  - 远程项目且 `hostId != null` 时按钮可用（`canStartNewThread = !ae && (!Fe || ...)`，`Fe = remote && hostId == null`）；
  - 本地/远程项目走同一个 `onStartNewThread`，由项目自身决定 Host 和 Agent 选择器。
- 当前 DOM 中 12 个项目的该按钮 `disabled=false`。
- 即使项目行被 CSS 隐藏，按钮仍在 DOM 中，`HTMLElement.click()` 仍会触发 React 的 onClick；`display:none` 不会阻止程序化 click。
- 与用户手点完全同路径，Agent 选择器自然是该项目的 Host 服务商。

**可靠性：高。风险：中低。** 唯一不确定的是“点击后是否一定创建/打开草稿”；这需要在 Phase B 做一次人工点击验收。源码显示这是项目行的正式新对话入口。

#### 路径 B：先选择项目，再触发全局新对话

- `windows.sidebar.select_project` 是 Desktop 自己的 app action，实现就是 `.click()` 隐藏的 `[data-app-action-sidebar-select-project]`；
- 选择项目后再触发全局 `new-chat` / `windows.show_home`，理论上会在当前项目上下文新建对话。
- 但这是两步、间接，且“全局新对话”是否继承刚选中的项目取决于 Desktop 的当前路由；不如路径 A 明确。
- 可作为路径 A 失败时的降级方案，但需要 Phase B 验证。

#### 路径 C：原生 IPC / `navigate-to-route` / deeplink

- Desktop 主进程支持 `navigate-to-route`，但项目新建对话的路由状态包含内部 `projectId`/`hostId` 组合，未找到公开稳定的消息契约；
- `codex://` deeplink 是否支持“在项目 X 新建对话”未验证；
- 直接构造内部 IPC 消息风险高，升级易碎。

**不推荐作为 MVP 主路径。**

#### 路径 D：通过 React fiber 直接调用组件内部函数

- 技术上可从 DOM 的 `__reactFiber$*` 找到项目行组件，读取 `memoizedProps`，再调用内部回调；
- 但这是最脆弱的路径：React 版本、组件层级、memo 缓存、闭包身份都会变；仓库现有 fiber 读取只用于只读归属判断，不用于执行动作；
- **不推荐。**

### 4.2 推荐流程

组行「＋ 新对话」：

1. 如果组只有一个可用成员：直接点击该成员的新对话按钮；
2. 如果有多个成员：弹一个机器/项目选择器（复用组内机器状态），选中后点击对应原生按钮；
3. 如果项目离线/按钮 `disabled`：在选择器里显示离线，不发起点击；
4. 点击后等待 Desktop 进入新对话面板/出现 Composer；若 1.5s 内没有变化，提示“无法在该项目新建对话”，不自动重试；
5. 不自动发送任何消息。

### 4.3 折叠/隐藏项目

- 折叠项目的项目行仍然存在，新对话按钮也在；路径 A 不受折叠影响。
- 如果整个 Projects section 被折叠、项目行未挂载，需要先展开 section（点击 `[data-app-action-sidebar-section-toggle]`）或提示用户；Phase B 验证 section 折叠时子节点是否仍挂载。
- 被 CSS 隐藏的项目不需要先取消隐藏；`.click()` 对隐藏元素仍有效。

### 4.4 Q4 结论

**推荐路径 A：点击项目行原生新对话按钮。** 它与用户手点同路径、携带完整 Host 上下文、对隐藏/折叠项目也有效。路径 B 作为降级，路径 C/D 不作为 MVP。

---

## 5. 对话归属与在线状态（Q5）

### 5.1 对话列表的数据源

当前可用的数据源有三类：

| 数据源 | 内容 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 原生项目列表 DOM | `[data-app-action-sidebar-project-list-id]` 下的 `[data-app-action-sidebar-thread-row]` | 与原生显示完全一致：顺序、标题、选中、置顶、Agent 图标都在 | **只有展开项目才有**；可能被“显示更多”分页；折叠项目没有列表容器 |
| `getInitialSidebarBootstrap` | `thread-project-assignments`、`remote-projects`、`local-projects`、`project-order`、`catalogEntries` | 不依赖 DOM 折叠；有项目元数据和最近 Thread 摘要 | preload 缓存第一次结果，**只是初始快照**；`catalogEntries` 当前只有 20 条，不是每项目完整列表；标题字段是 `displayTitle` |
| Host 只读 `.codex-global-state.json` | 4 个目标键 + `project-order` | 新鲜、包含连接目录、Renderer 无 Node 依赖 | 需要新增本地 Host RPC；要处理 Desktop 写入中的瞬时坏 JSON |
| Host / app-server `thread/list` | 按 cwd/project 查询完整 Thread | 完整、可分页、可跨 Host | 需要按项目/Host 聚合、排序、去重；工作量大；远程 Host 还要连接 |

**推荐 MVP：以原生项目列表 DOM 为主。** 理由：

- 组的核心价值是“把原生项目列表按机器重新展示”，不是重建一套 Thread 列表；
- DOM 行已经包含原生排序、标题、选中、置顶和 Agent 图标；
- 点击行可以直接委托给原生行，导航行为一致；
- 不需要为每个项目额外发 `thread/list`，避免重复查询和排序分歧。

### 5.2 折叠与分页缺口

这是本方案最大的数据缺口，必须显式处理：

- 折叠项目（`data-app-action-sidebar-project-collapsed="true"`）没有 `data-app-action-sidebar-project-list-id` 容器，读不到对话行。
- 展开但 `show-all=false` 的项目可能只渲染一部分对话；当前 DOM 中没有看到 `show-all-toggle`，但源码定义了它，说明存在分页场景。
- 处理选项：
  1. **MVP 推荐**：组内对该项目显示“该项目在原生侧已折叠/仅显示部分对话”，提供“展开/显示更多”动作；动作通过点击原生项目行或 `[data-app-action-sidebar-project-show-all-toggle]` 实现。点击项目行会选中项目，这是用户主动操作，可接受。
  2. **Phase 2**：由 Host 按 `local-projects.rootPaths` / `remote-projects.remotePath` 调用 `thread/list`，渲染完整列表；需要解决排序、分页、去重和远程 Host 连接。
  3. **折中**：用 `getInitialSidebarBootstrap().catalogEntries` + `thread-project-assignments` 给折叠项目显示最近几条，并标注“最近对话”；不保证完整。

**需要拍板：MVP 是否接受“折叠项目只显示占位/最近几条”，还是必须一次性做完整 `thread/list`。**

### 5.3 在线状态

有两种来源：

1. **项目行原生状态图标**（推荐用于显示）：
   - 远程项目行右侧有 `role="img"` 的状态点，当前连接时是 `aria-label="已连接"`，class 含 `text-chart-green`，内部是 `bg-chart-green` 的 2px 圆点；
   - 状态随 Desktop 连接状态实时更新，不需要额外请求；
   - 缺点是 `aria-label` 是本地化文本，class 颜色 token 也可能变。
2. **`CodexSshClient.state(hostId)`**（推荐作为 authoritative fallback）：
   - `packages/renderer-extension/src/codex-ssh-adapter.ts:255-267` 调用原生 `app-server-connection-state`；
   - 返回 `{ state, error }`；
   - `packages/renderer-extension/src/settings/remote-connections-card.ts:93-105` 已经定义了状态映射：`connected` / `connecting` / `disconnected` / `error` / `null`；
   - 适合在状态图标缺失、或需要机器级状态时使用。

**建议**：机器小节标题的状态点优先读项目行图标（零请求、实时）；如果读不到，调用 `state(hostId)`；两者都失败显示“状态未知”，不阻塞组展开。

### 5.4 对话行复用方式对比

| 方式 | 行为保真 | React 风险 | 实现成本 | 结论 |
| --- | --- | --- | --- | --- |
| 移动原生列表容器到组内 | 最高（原生 hover、菜单、置顶都在） | **高**。容器是 React 管理的，React 可能在下次 commit 把它放回原父节点；折叠/展开可能重建 | 中 | 不作为 MVP |
| 克隆原生行 DOM | 外观高，行为丢失（事件处理器不在 clone 上） | 低（clone 不在 React 树） | 中高（需要同步标题/选中/图标，点击要代理） | 可选 |
| 从 DOM 读数据，自己渲染行 | 外观可控，行为通过点击原生隐藏行代理 | **最低** | 中 | **推荐 MVP** |

推荐的自渲染行只需：

- 标题：`data-app-action-sidebar-thread-title`；
- 选中/激活：`data-app-action-sidebar-thread-selected` / `-active`；
- 点击：找到同 `thread-id` + `host-id` 的原生行，调用 `.click()`；
- 可选：置顶标记、Agent 图标（复用现有 `createRendererAgentIcon`）；
- 不复制原生 hover 菜单（置顶/归档/重命名）；需要时可在 Phase 2 通过原生 contextmenu 代理实现。

### 5.5 机器分组

- 成员项目 → Host：`remote-projects` 里有 `hostId`；本地项目没有 `hostId`，归为 `local`；
- 机器显示名：优先项目行右侧的 host label（DOM 已显示 `colab`、`oracle-sg` 等）；其次 `remote-projects.hostId` 的 alias；最后 `hostId`；
- 本地机器显示名建议统一为「本机」（或可配置），不要用 `coderxudeMac-mini.local` 这种长主机名；
- 同一 Host 有多个成员项目时，建议机器小节内再按项目分组（项目名小标题），避免对话混在一起；这是产品决策。
- 状态：同一 Host 取任一成员项目的状态图标；若多个状态不一致，取最差（error > disconnected > connecting > connected）。

### 5.6 Q5 结论

- 对话：**原生项目列表 DOM 为主**，自渲染行 + 点击代理；不搬 React 节点。
- 归属：`thread-project-assignments` 用于校验和补充，不重复实现原生过滤。
- 状态：项目行状态图标为主，`CodexSshClient.state()` 兜底。
- 折叠/分页是已知缺口，MVP 用占位/展开动作，Phase 2 再考虑完整 `thread/list`。

---

## 6. 存储（Q6）

### 6.1 位置

```text
~/.codexhost/project-groups/groups.json
```

- 与 `mapping-store` 平级、独立文件，不写 Desktop 的 `.codex-global-state.json`；
- 目录权限建议 `0700`，文件 `0600`；
- `CODEXHOST_DATA_DIR` 存在时，根目录跟随它（与 `defaultMappingStoreDirectory` 的约定一致，见 `packages/host-runtime/src/external-thread-repository.ts:103-109`）。

不建议直接放进 `mapping-store`：mapping store 是 Thread 元数据，重建/隔离时不应连带清掉 UI 组配置。独立目录更符合“删组即恢复原状”的产品语义。

### 6.2 Schema 草案

```json
{
  "formatVersion": 1,
  "revision": 3,
  "groups": [
    {
      "id": "4d1c0f5e-7a1b-4c2d-9e3f-5a6b7c8d9e0f",
      "name": "跨机前端",
      "order": 0,
      "collapsed": false,
      "members": [
        {
          "projectKind": "local",
          "projectId": "local-c6c2f5d343db8499cf2cedb80c232d17",
          "rootPaths": ["/Users/<user>/work/htdocs"],
          "label": "htdocs"
        },
        {
          "projectKind": "remote",
          "projectId": "b285194d-5884-496d-8687-16b1ce7c3dd7",
          "hostId": "remote-ssh-discovered:oracle-main",
          "remotePath": "/srv/<path>",
          "label": "codex"
        }
      ],
      "createdAt": "2026-11-11T09:30:00.000Z",
      "updatedAt": "2026-11-11T09:30:00.000Z"
    }
  ]
}
```

Zod 草案（可放 `packages/shared-contracts/src/project-groups.ts`，文件层 schema 放 `packages/mapping-store/src/project-groups.ts`）：

```ts
const projectGroupMemberSchema = z.discriminatedUnion("projectKind", [
  z.object({
    projectKind: z.literal("local"),
    projectId: z.string().min(1).max(1024),
    rootPaths: z.array(z.string().min(1).max(4096)).max(64),
    label: z.string().max(1024),
  }).strict(),
  z.object({
    projectKind: z.literal("remote"),
    projectId: z.string().min(1).max(1024),
    hostId: z.string().min(1).max(1024),
    remotePath: z.string().min(1).max(4096),
    label: z.string().max(1024),
  }).strict(),
]);

const projectGroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  order: z.number().int().nonnegative(),
  collapsed: z.boolean(),
  members: z.array(projectGroupMemberSchema).min(1).max(64),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const projectGroupsFileSchema = z.object({
  formatVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  groups: z.array(projectGroupSchema).max(64),
}).strict();
```

约束：

- 同一个 `(projectKind, projectId)` 只能属于一个组；
- 组 ID 唯一；组名不强制唯一，但管理 UI 提示重名；
- 成员数量上限 64，组数量上限 64，避免单文件无限增长；
- `rootPaths`/`remotePath`/`label` 是**快照**，用于项目 ID 迁移或 Desktop 项目重建后的 fallback 识别，不作为显示的唯一来源。

### 6.3 原子写与损坏恢复

参照 `packages/mapping-store/src/section-placements.ts:83-105`：

- 写临时文件 `${file}.tmp-${randomUUID()}`，`wx` + `0600`；
- `writeFile` → `fsync` → `close` → `rename`；
- 失败时删除临时文件；
- 读取时 JSON/zod 校验失败：把文件重命名为 `groups.json.<timestamp>.invalid`（隔离），返回空配置，继续运行；不要让组配置损坏阻塞 Host 启动。
- 建议在 Host 侧用一个 promise 队列串行化 `read-check-write`，避免同一进程内两个窗口并发写丢更新。

### 6.4 RPC

仅在**本地 Host** 上暴露：

```text
codexhost/project-groups/list
  params: {}
  result: { revision: number, groups: ProjectGroup[] }

codexhost/project-groups/replace
  params: { revision: number, groups: ProjectGroup[] }
  result: { revision: number, groups: ProjectGroup[] }

codexhost/desktop-projects/catalog
  params: {}
  result: {
    localProjects: ...,
    remoteProjects: ...,
    threadProjectAssignments: ...,
    codexManagedRemoteConnections: ...,
    projectOrder: ...,
    readAt: string
  }
```

行为：

- `list`：读取组配置文件，返回当前 revision + groups；
- `replace`：校验 `revision` 与文件一致；不一致返回冲突错误（例如 `-32082` + “Project groups changed; reload”）；一致则校验 schema、递增 revision、原子写、返回新结果；
- 删除组 = `replace` 一个不包含该组的列表；
- `desktop-projects/catalog`：只读 `~/.codex/.codex-global-state.json` 的目标键，返回新鲜项目目录；不写 Desktop 状态；
- 可选：`codexhost/project-groups/changed` 通知；MVP 可以不做，改用 renderer 的 `BroadcastChannel` 或窗口 focus 刷新。

Host 接入点：

- `packages/host-runtime/src/app-server-host.ts:342` 的 `AppServerHostOptions` 增加 `projectGroups?: ProjectGroupStore` 和 `desktopProjects?: DesktopProjectCatalogReader`；
- 在 `app-server-host.ts` 的请求分发里，于 `externalOnly` 拒绝逻辑之前处理 `codexhost/project-groups/*` 和 `codexhost/desktop-projects/*`；只有注入了对应依赖的本地 Host 才会命中；
- `packages/host-runtime/src/run-host-runtime.ts:300` 的本地 Host 构造处注入；远程 Host / `externalOnly` 不注入，因此远端不会写组配置，也不会读 Mac 的 Desktop 状态文件。

Renderer 接入点：

- `packages/renderer-extension/src/renderer-model-client.ts:203-226` 的 `RendererModelClient` 增加 `listProjectGroups()` / `replaceProjectGroups()` / `readDesktopProjectCatalog()`；
- 通过 `createRendererHostClients(...).forHost("local")` 调用（`versioned-renderer-adapter.ts:890` 已经用 `window` 创建 clients）；
- 不要用当前激活项目的 Host client，否则会把组配置写到远程 Host；必须显式 `forHost("local")`。

### 6.5 身份与迁移

Desktop 的项目 ID 可能变化（当前状态里同时存在 `local-<hash>` 和 UUID；还有 `app-server-project-id-by-legacy-project-id-by-host` 迁移记录）。解析成员时按顺序：

1. `(projectKind, projectId)` 精确命中当前 `local-projects` / `remote-projects` / DOM 项目行；
2. local：用 `rootPaths` 交集匹配；
3. remote：用 `(hostId, remotePath)` 匹配；
4. 仍失败：标记 `missing`，**不隐藏该项目**，组内显示“成员缺失”，管理 UI 提供移除/重新绑定。

不要因为“ID 找不到”就删组或删成员；Desktop 升级/项目重建后用户还能修复。

### 6.6 多窗口与并发

- 组配置是共享的；每个窗口自己渲染组块、自己维护隐藏样式。
- 写操作建议带 `revision` 冲突检查；冲突时重新 `list`，让用户确认后重试。
- 其他窗口刷新：优先 `BroadcastChannel("codexhost-project-groups")` 发一个 invalidate 信号（同 `app://-` origin）；不支持时在窗口 `focus` / `visibilitychange` 时重新 `list`。
- `BroadcastChannel` 只传 invalidate，不传配置本身；Host 文件仍是唯一事实源。

### 6.7 Q6 结论

独立文件 + `formatVersion`/`revision` + 原子写 + 本地 Host-only RPC，是最贴合现有 `section-placements` 模式、又不会污染 Desktop 状态的方案。删除组只删这个文件里的条目，隐藏样式随之移除，原生列表立即恢复。

---

## 7. 兼容性风险与降级（Q7）

### 7.1 风险矩阵

| 风险 | 触发点 | 影响 | 检测 | 降级 |
| --- | --- | --- | --- | --- |
| Desktop 改 `data-app-action-sidebar-*` 名称 | 升级 | 找不到项目/对话行 | 启动和每次 Projects 变化时跑契约探测 | 禁用组 UI，移除隐藏样式，原生列表完整可用 |
| 项目单元结构变化（`:has` 不再命中） | 升级 | 成员项目没被隐藏，出现重复 | 验证每个成员 ID 能命中 `div[role=listitem]` | 不隐藏该成员，组内标“未隐藏”，或整体禁用 |
| 新对话按钮结构变化 | 升级 | 无法新建对话 | 每个项目行必须唯一命中结构选择器；按钮存在且未 disabled | 组内“新对话”禁用并提示；不影响其他功能 |
| 项目 ID 迁移/重建 | Desktop 项目迁移 | 组成员失联 | 精确命中失败后走 rootPaths/remotePath fallback | 标记 missing，不隐藏，管理 UI 修复 |
| React 重渲染移除注入块 | 项目/侧边栏更新 | 组行消失 | MutationObserver 检查 `block.isConnected` 和父节点 | 重新插入；连续失败则整体禁用并恢复原生列表 |
| 折叠项目没有列表容器 | 用户折叠项目 | 组内看不到该项目对话 | 检查 `[data-app-action-sidebar-project-list-id]` 是否存在 | 显示“已折叠”占位 + 展开动作；不静默显示 0 条 |
| `show-all` 分页 | 项目对话很多 | 组内只显示部分 | 检查 `data-app-action-sidebar-project-show-all` | 显示“查看更多”点击原生 toggle；Phase 2 用 `thread/list` |
| 状态图标文案/颜色变化 | 升级/本地化 | 状态显示错误 | 优先用 `state(hostId)` 兜底 | 显示“状态未知”，不阻塞 |
| `getInitialSidebarBootstrap` 改名/移除 | 升级 | 初始目录缺失 | 启动探测函数是否存在 | 用 Host `desktop-projects/catalog` 或纯 DOM：项目 ID/label 从行读，host 从 aria-label/状态图标读 |
| bootstrap 缓存导致“看起来不更新” | 项目/归属变化 | 用旧快照做成员解析 | 不在变化后依赖 bootstrap，改用 Host catalog RPC | 以 Host 文件读取结果为准；bootstrap 只做初始降级 |
| Host RPC 不可用 | Host 未启动/旧版 | 拿不到组配置/项目目录 | `list`/`catalog` 超时或方法不存在 | 完全禁用组功能，不隐藏任何项目 |
| 组文件损坏 | 手改/磁盘问题 | 配置丢失 | zod 校验失败 | 隔离文件，空配置启动，不隐藏 |
| 多窗口并发写 | 两个窗口同时编辑 | 丢更新 | `revision` 冲突 | 重新加载并提示用户 |
| `display:none` 影响滚动 | 隐藏大量项目 | 滚动跳动 | Phase B 验收 | 改用 `visibility:hidden; height:0` 或分组折叠 |

### 7.2 契约探测（feature gate）

启动时和 Projects 区域变化时，检查：

```text
[ ] 存在 section[data-app-action-sidebar-section][...heading="Projects"]
[ ] 存在 section 内的 div[role="list"]
[ ] 至少 1 个 div[role="list"] > div[role="listitem"]
[ ] 每个项目单元包含 [data-app-action-sidebar-project-row]
[ ] 项目行有 data-app-action-sidebar-project-id 和 -label
[ ] 展开项目有 [data-app-action-sidebar-project-list-id]
[ ] 对话行有 -thread-id、-thread-host-id、-thread-title
[ ] 每个项目行唯一命中新对话按钮结构选择器
[ ] CSS.supports('selector(:has(*))') 为 true（否则用属性标记 fallback）
```

判定：

- 全部通过 → `active`；
- 关键项失败（section/list/project row/ID）→ `disabled`，不隐藏；
- 单个成员解析/隐藏失败 → 只跳过该成员，不整体禁用；
- 结果写到 `<html data-codexhost-project-groups-state="active|disabled|probing">`，便于诊断。

### 7.3 版本变化策略

- 用 `window.electronBridge.getDesktopUserAgent()` 记录 Desktop 版本；
- 不硬编码“只支持 26.1027.61615”；升级后先跑契约探测，通过就继续；
- 契约探测失败时自动关闭，并在 console 打一条带版本/缺失选择器的诊断；
- 提供 `window.__codexhostProjectGroupsV1.disable()` 作为人工 kill switch；
- 在 `tools/codex-desktop-contract-audit` 增加 `project-groups` surface，升级时输出 `no-impact` / `confirmed-impact` / `unverified`。

### 7.4 降级原则

1. **Fail-open，不 fail-closed**：任何不确定都回到原生列表，绝不留下被隐藏但组块没渲染的项目。
2. **不做半隐藏**：要么完整渲染组并隐藏所有已解析成员，要么全部恢复原生。
3. **不改 Desktop 状态**：组配置只在 `~/.codexhost`；隐藏只通过 CSS；删除组立即恢复。
4. **可观测**：诊断状态、缺失选择器、成员解析结果都写到 console/诊断页，方便升级后定位。

### 7.5 Q7 结论

最可能坏在 DOM 契约和项目 ID 迁移；用“契约探测 + 单成员跳过 + 全局 fail-open + 可删除样式”可以把影响限制在功能本身，不会破坏原生项目列表。

---

## 8. 推荐实现方案与工作量拆分（Q8）

### 8.1 推荐架构：DOM companion（MVP）

```text
┌─────────────────────────────── Mac Desktop Renderer ───────────────────────────────┐
│ renderer-extension                                                                  │
│  ├─ project-groups controller                                                       │
│  │   ├─ bootstrap (initial snapshot) + global-state/membership signals               │
│  │   ├─ Host catalog RPC (fresh projects/assignments/connections)                   │
│  │   ├─ DOM contract probe + MutationObserver        → project units/thread rows     │
│  │   ├─ hide style (<style data-codexhost-project-groups>) → display:none members    │
│  │   ├─ group block (inserted before div[role=list])  → native-looking group UI      │
│  │   ├─ thread rows (read from native DOM)           → click delegates to native row │
│  │   └─ new-chat picker                              → native project new-chat button│
│  └─ management dialog                                → RPC replace                   │
└─────────────────────────────────────────────────────────────────────────────────────┘
                    │ codexhost/project-groups/list|replace
                    │ codexhost/desktop-projects/catalog
                    ▼
┌─────────────────────────────── Mac Host Runtime ───────────────────────────────────┐
│ project-group store (local only)                                                    │
│  ~/.codexhost/project-groups/groups.json                                            │
│  formatVersion + revision + atomic write + quarantine                               │
│ desktop project catalog reader (local only)                                         │
│  read-only ~/.codex/.codex-global-state.json → 4 target keys                        │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

关键设计选择：

- **不移动/不克隆 React 管理的项目单元或列表容器**；只加 `<style>` 和在 keyed list 外插入组块。
- 组块放在 `div.group/nav-list` 里、`div[role="list"]` 之前；它是 Projects section 的 flex 子项，视觉上就是列表最上面的一个“项目”。
- 对话行从原生 DOM 读取，自己渲染；点击时找到同 `thread-id` + `host-id` 的原生行并 `.click()`。这样保留原生导航，不复制 React 事件。
- 新对话用原生项目行按钮；管理用我们自己的 modal。
- 删除组只删配置 + 样式；原生节点从未被移动，恢复是即时的。

### 8.2 为什么不是“搬原生列表到组内”

搬移能保留原生 hover 菜单、置顶、归档等行为，但：

- 项目单元/列表是 React keyed children；移动后 React 可能在下次 commit 用 `insertBefore` 放回原父节点；
- 折叠/展开可能重建列表容器，导致搬移失效；
- 需要 MutationObserver 反复 re-home，复杂度和不确定性都高；
- 任何 re-home 失败都可能让对话“消失”或重复。

MVP 先不承担这个风险。若 reviewer 认为原生 hover 行为必须保留，再做 Phase 2 的“搬移 + re-home + 失败回退”，单独 feature flag。

### 8.3 Commit 粒度

| # | Commit | 内容 | 验收 |
| --- | --- | --- | --- |
| 1 | `feat(shared-contracts): define project group schemas` | `ProjectGroup`/member/RPC zod 类型；浏览器安全 | 类型/单测通过；无 Node 依赖 |
| 2 | `feat(mapping-store): persist project groups atomically` | `project-groups.ts` 读写、revision、隔离损坏文件 | 单测：ENOENT、损坏、原子写、revision 冲突 |
| 3 | `feat(host-runtime): expose local project RPC` | `codexhost/project-groups/list|replace` + `codexhost/desktop-projects/catalog`；仅本地 Host 注入 | 单测：本地可用、远程/externalOnly 拒绝；组文件落盘；状态文件解析/坏 JSON 重试 |
| 4 | `feat(renderer-extension): read native project catalog` | bootstrap 初始快照、Host catalog RPC、`global-state-updated`/`thread-project-memberships-updated` 信号、契约探测、诊断状态；不渲染 UI | 只读测试：bootstrap/Host catalog 解析、消息触发刷新、契约失败 fail-open |
| 5 | `feat(renderer-extension): render project groups and hide members` | 组块插入、CSS `:has` 隐藏、机器小节、DOM 对话行、点击代理；先只读组配置 | DOM fixture：隐藏/恢复、重渲染后仍隐藏、成员缺失不隐藏 |
| 6 | `feat(renderer-extension): start chats in member projects` | 组行“＋新对话”、机器选择器、原生按钮点击、离线/折叠处理 | 手动验收：在 Mac/oracle/colab 项目各新建一次；失败提示 |
| 7 | `feat(renderer-extension): manage project groups` | 管理 modal：加/移除成员、改名、删除；RPC replace + 冲突处理 | 手动/单测：增删改、删除恢复原生列表、两窗口冲突 |
| 8 | `test+docs: project group contract and fallback` | 契约 fixture、audit surface、实现文档/索引 | `npm run lint` + 相关测试；Mac 手动清单 |

可以合并 4+5，但建议保留独立 commit，便于在 Phase B 先验证“只读契约”再上 UI。

### 8.4 验证清单（Phase B）

- 新建组：成员项目从原生列表消失，组行出现在 Projects 顶部；非成员不变。
- 展开组：按机器分小节；每节显示机器名和状态；对话行顺序/标题与原生一致。
- 点击组内对话：进入对应 Thread；返回后组仍展开。
- 组内新对话：选择机器/项目后在对应项目打开新对话；Agent 选择器是该机器的服务商。
- 删除组：原生项目行/对话立即恢复，顺序不变。
- Desktop 重渲染（切换项目、折叠/展开、刷新）：隐藏和组块仍正确；无重复/丢失。
- 失败注入：删除一个选择器属性（DevTools 临时改 DOM）→ 功能自动禁用，原生列表完整。
- 折叠成员/分页成员：显示占位/查看更多，不静默丢对话。
- 两窗口：一边改组，另一边刷新/收到 BroadcastChannel 后一致。

### 8.5 需要拍板的问题

| # | 问题 | 选项 | 建议 |
| --- | --- | --- | --- |
| 1 | 对话数据完整性 | A. 只镜像原生可见列表（折叠/分页显示占位） B. 做 `thread/list` 完整聚合 | **A 先上线**；B 作为 Phase 2，除非要求“必须看到全部历史” |
| 2 | 组内对话行的原生操作 | A. MVP 不提供 hover 菜单 B. 代理原生 contextmenu C. 搬原生列表 | **A**；B 作为增强；C 风险高 |
| 3 | 同机多项目展示 | A. 机器小节内再按项目分组 B. 机器小节内混排所有对话 | **A**，避免同机项目对话混淆 |
| 4 | 组在 Projects 的位置 | A. 固定在 Projects 顶部 B. 可排序到任意项目之间 | **A**；B 需要动 keyed list，风险高 |
| 5 | 本机显示名 | A. 「本机」 B. Mac 主机名 C. 可配置 | **A**，简洁；C 可后加 |
| 6 | 多窗口并发 | A. revision 冲突提示 B. 最后写入者胜 | **A**，成本低，避免静默丢组 |
| 7 | 折叠成员是否自动展开 | A. 显示占位，用户点“展开” B. 自动点原生项目行展开 | **A**，避免自动选中/导航 |
| 8 | 是否允许 projectless 对话进组 | A. 不允许，只支持原生项目 B. 允许 | **A**，与产品目标一致 |

---

## 9. 证据附录

### 9.1 仓库代码

| 证据 | 位置 |
| --- | --- |
| `persisted-atom-sync` 消息解析与请求 | `packages/renderer-extension/src/renderer-thread-reference-persistence.ts:29-39` |
| `persisted-atom-update` 写回 | 同文件 `:64-69` |
| sidebar thread 行属性与 MutationObserver | `packages/renderer-extension/src/renderer-sidebar-agent-icons.ts:17-22`、`:269-304` |
| section placements schema/原子写 | `packages/mapping-store/src/section-placements.ts:33-66`、`:83-105` |
| mapping store 读取/隔离/路径 | `packages/mapping-store/src/mapping-store.ts:485-496`、`:913-960`、`:1395-1407` |
| 默认 data 目录 | `packages/host-runtime/src/external-thread-repository.ts:103-115` |
| placement RPC 先例 | `packages/host-runtime/src/app-server-host.ts:1370-1376`、`:3069-3078` |
| Codex SSH 连接 list/state | `packages/renderer-extension/src/codex-ssh-adapter.ts:100-124`、`:132-176`、`:255-267` |
| 连接状态映射 | `packages/renderer-extension/src/settings/remote-connections-card.ts:93-105` |
| Renderer host clients | `packages/renderer-extension/src/renderer-host-clients.ts:23-...`、`packages/renderer-extension/src/versioned-renderer-adapter.ts:890` |
| RendererModelClient 接口 | `packages/renderer-extension/src/renderer-model-client.ts:203-226` |
| CDP evaluate | `packages/desktop-control/src/cdp-client.ts:324-358` |
| 插件边界（不应任意访问 Desktop 内部） | `docs/architecture/harness-plugin-architecture.md:41`；本功能属于 renderer extension，不是 Harness plugin，但仍应保持 fail-open |

### 9.2 Desktop `app.asar` 关键偏移

| 偏移 | 符号/内容 |
| --- | --- |
| `11290487` | `sendPersistedAtomState`：只读 `electron-persisted-atom-state` |
| `11262743` | 主进程 `persisted-atom-sync-request` / `persisted-atom-update` 分支 |
| `9885627` | Desktop preload：`codex_desktop:message-for-view` → `window.dispatchEvent(new MessageEvent("message"))` |
| `12712416` / `16054992` / `12970262` | `getInitialSidebarBootstrap` preload/主进程；preload 首次调用后缓存 |
| `11784000` | `ept` 数组：bootstrap 的 16 个 global state key |
| `173744436` | `data-app-action-sidebar-*` selector 常量表 |
| `183568000` | 项目行组件 `G6n`：`onStartNewThread` 接收完整 group |
| `183555122` | 项目菜单 `T6n`：`edit-project` 等菜单项 |
| `12199751` / `12649364` | `thread-project-memberships-updated` 广播 |
| `12649467` / `11784778` | `global-state-updated` 广播 |
| `377267500` | Renderer 处理 `global-state-updated` 并 invalidate `get-global-state` |
| `527174818` | `register-app-actions`：`app.get_summary` 读 `data-app-action-sidebar-*` |
| `539671856` | `run-app-action-in-primary-window`：动态 UI 工具的动作执行入口 |
| `533355217` | sidebar app actions：`windows.sidebar.select_project` 等 `.click()` 实现 |

### 9.3 现场状态（脱敏）

- `~/.codex/.codex-global-state.json` 顶层有 4 个目标键；`electron-persisted-atom-state` 里没有。
- 当前计数：`local-projects` 10、`remote-projects` 2、`thread-project-assignments` 159、`codex-managed-remote-connections` 5、`project-order` 12。
- `local-projects` 字段：`id/name/rootPaths/createdAt/updatedAt`。
- `remote-projects` 字段：`id/hostId/remotePath/label`；`hostId` 形如 `remote-ssh-discovered:<alias>`。
- `thread-project-assignments` 字段：`projectKind`（`local`/`remote`）+ `projectId`。
- `codex-managed-remote-connections` 字段：`hostId/displayName/alias/hostname/sshPort/identity/source/connectionAnalyticsId`。
- bootstrap 的 `globalStateEntries` 包含 `local-projects`、`remote-projects`、`thread-project-assignments`，不包含 `codex-managed-remote-connections`。
- bootstrap 的 `thread-project-assignments` 条数（155）与文件（159）不一致，证明它是快照；preload 还会缓存第一次结果，不能用于刷新。
- 主进程广播的 `global-state-updated` / `thread-project-memberships-updated` 经 preload 的 `message-for-view` 转发为 window `message` 事件；现有 `persisted-atom-sync` 监听同一路径。

### 9.4 DOM 现场

- 当前 12 个项目单元，全部是 `div[role="list"] > div[role="listitem"]`。
- 每个项目行有 3 个 button：菜单（`aria-haspopup=menu`）、新对话（无 `aria-haspopup`、无 `data-app-action-sidebar-select-project`）、隐藏 select（`data-app-action-sidebar-select-project`）。
- 结构选择器 `button:not([aria-haspopup]):not([data-app-action-sidebar-select-project])` 在 12 个项目上各命中 1 个。
- 远程项目行有机器名 + `aria-label="已连接"` 的状态点；本地项目行没有 host 后缀。
- 折叠项目（`data-app-action-sidebar-project-collapsed="true"`）没有 `data-app-action-sidebar-project-list-id` 容器。
- `CSS.supports('selector(:has(*))')` 为 `true`；`div[role="list"] > div[role="listitem"]:has([data-app-action-sidebar-project-id="..."])` 可以命中。
- 当前 DOM 中没有 `data-app-action-sidebar-project-show-all-toggle`；源码有定义，说明分页场景存在但当前未触发。

### 9.5 方法与限制

- CDP 连接：Mac 上 `--remote-debugging-address=127.0.0.1 --remote-debugging-port=60273`；本次用 `pgrep -fl ChatGPT.app/Contents/MacOS/ChatGPT` 确认端口，实际仍为 `60273`。
- 只执行 `Runtime.evaluate` 读取 DOM/调用 `getInitialSidebarBootstrap`；没有点击、输入、`DOM.setAttribute`、`Runtime.callFunctionOn` 修改、导航或状态写入。
- 没有打开项目菜单，所以菜单内容的 DOM 结构来自源码推断，不是现场观察；报告已明确标注。
- `app.asar` 是压缩产物，偏移会随版本变化；这些偏移只用于本次证据，不应写进生产代码。
