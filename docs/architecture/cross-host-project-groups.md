# 跨机项目组（Cross-host Project Groups）

本功能把多个原生 Codex Desktop 项目（可来自本机和不同远程连接）组合成一个侧边栏项目组。组配置属于 codexhost，不写入 Desktop 状态。

v2 不再自绘对话行：成员项目对应的原生项目块（项目行 + 它的对话列表）原样保留，只通过 codexhost 的样式表调整显示顺序和缩进，让它出现在组标题下方。原生项目块的悬停信息卡片、右键菜单、快捷键、项目「···」菜单、编辑项目弹窗、新对话按钮、展开显示和拖拽全部保持 Desktop 原生行为。

本实现对应 A 阶段报告 [`docs/proposals/cross-host-project-groups.md`](../proposals/cross-host-project-groups.md)。报告里的建议与最终拍板有差异时，以本篇的当前行为为准。

## 边界

- 只支持原生项目；projectless 对话不能进组。
- 成员的 React 项目单元不隐藏、不移动、不克隆、不改节点内容；顺序与缩进只由 `<style>` 完成。
- 组标题、收起列表占位和「新建项目组」是插入原生列表的非 React 外来节点；React 只操作自己的节点，外来节点在其容器替换后由 Renderer 补回。
- 所有项目/对话交互由 Desktop 原生实现，codexhost 不代理菜单、不复制对话行。
- Desktop DOM 契约不满足（section/list/项目身份缺失或 `:has()` 不可用）时整体 fail-open：移除样式和外来节点，回到原生列表。
- 单个项目的状态问题（例如远程离线导致新对话按钮消失、项目尚未挂载）只做成员级降级，不关闭整个功能。

## 组成

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 共享契约 | `packages/shared-contracts/src/project-groups.ts` | 组/成员/RPC schema，浏览器安全 |
| 组配置存储 | `packages/mapping-store/src/project-groups.ts` | `groups.json` 原子写、revision、损坏隔离 |
| Host 服务 | `packages/host-runtime/src/project-groups-service.ts` | 组合存储与 Desktop 项目目录读取 |
| Desktop 项目目录 | `packages/host-runtime/src/desktop-project-catalog.ts` | 只读 `.codex-global-state.json` 的目标键 |
| Host RPC | `packages/host-runtime/src/app-server-host.ts` | `codexhost/project-groups/list|replace`、`codexhost/desktop-projects/catalog` |
| Renderer 布局 | `packages/renderer-extension/src/renderer-project-groups-layout.ts` | 生成原生项目单元的 `order`/缩进/折叠样式 |
| Renderer 组标题 | `packages/renderer-extension/src/renderer-project-groups-header.ts` | 组标题、占位、新建组外来节点 |
| Renderer 控制器 | `packages/renderer-extension/src/renderer-project-groups.ts` | 项目目录、成员解析、配置、新对话、管理 |
| 契约审计 | `packages/renderer-extension/src/renderer-project-groups-dom.ts`、`contract-audit.ts` | 提供 `project-groups` audit surface |

## 数据流

1. Renderer 启动时读取一次 preload 的 `getInitialSidebarBootstrap()`。该值是初始快照，preload 会缓存，不能用于刷新。
2. Renderer 通过本地 Host 调用：
   - `codexhost/project-groups/list` 获取组配置与 revision；
   - `codexhost/desktop-projects/catalog` 获取新鲜的项目目录（`local-projects`、`remote-projects`、`thread-project-assignments`、`codex-managed-remote-connections`、`project-order`）。
3. Host 只读 `$CODEX_HOME/.codex-global-state.json`（默认 `~/.codex`），只投影需要的字段；解析失败重试一次，仍失败返回错误，Renderer 保留上一份目录。
4. Renderer 监听 window `message`：
   - `global-state-updated` 且 key 命中项目状态（含 `pinned-project-ids`）；
   - `thread-project-memberships-updated`。
   收到后 debounce 刷新 Host 目录。
5. 组内对话直接来自原生项目块 DOM；codexhost 不读取或重建对话行。

## 存储

```text
~/.codexhost/project-groups/groups.json
```

```json
{
  "formatVersion": 1,
  "revision": 3,
  "groups": [
    {
      "id": "<uuid>",
      "name": "跨机前端",
      "order": 0,
      "collapsed": false,
      "members": [
        {
          "projectKind": "local",
          "projectId": "local-...",
          "rootPaths": ["/Users/.../project"],
          "label": "project"
        },
        {
          "projectKind": "remote",
          "projectId": "<app-server project id>",
          "hostId": "remote-ssh-discovered:<alias>",
          "remotePath": "/srv/project",
          "label": "project"
        }
      ],
      "createdAt": "2026-11-11T10:00:00.000Z",
      "updatedAt": "2026-11-11T10:00:00.000Z"
    }
  ]
}
```

- 写临时文件、`fsync`、`rename`；文件权限 `0600`，目录 `0700`。
- 读取失败或 zod 校验失败时隔离为 `groups.json.<timestamp>.invalid`，以空配置继续，不阻塞 Host；Renderer 提示一次备份名并写入 `status.lastError`。
- `replace` 带 `revision`；不一致返回 `-32082`，Renderer 提示冲突并重新加载，不静默覆盖。
- 成员 `rootPaths` / `hostId + remotePath` 是项目 ID 迁移后的 fallback 识别依据。

## Renderer DOM 契约

依赖 Desktop 自己的 `data-app-action-sidebar-*` 属性；这些属性也是 Desktop `app.get_summary` 和 sidebar app actions 使用的同一套契约。

| 目标 | 选择器 |
| --- | --- |
| Projects 区域 | `section[data-app-action-sidebar-section][data-app-action-sidebar-section-heading="Projects"]` |
| 项目列表 | Projects section 内 `div[role="list"]`（直接子项含项目行） |
| 项目单元 | 项目列表直接子项 `div[role="listitem"]` |
| 项目行 | `[data-app-action-sidebar-project-row]` |
| 项目 ID/名称 | `data-app-action-sidebar-project-id` / `-label` |
| 项目类型 | `[data-sidebar-project-kind="local|remote"]` |
| 新对话按钮 | 项目行内 `button:not([aria-haspopup]):not([data-app-action-sidebar-select-project])` |
| 展开显示 | 非项目 listitem 内文本/aria 为「展开显示 / Show more」的按钮 |

`probeProjectGroupsContract` 只把全局结构问题作为契约失败：Projects section、项目列表、至少一个项目单元、已挂载项目行的 ID/名称、`:has()` 支持。缺少新对话按钮、项目未挂载等属于成员状态，记录为诊断计数，不触发 fail-open。

## 原生项目块布局

`renderer-project-groups-layout.ts` 向 `document.head` 注入一个 `<style data-codexhost-project-groups>`：

- 定位 Projects 列表：`section[...] div[role="list"]:has(> div[role="listitem"] [data-app-action-sidebar-project-row])`。
- 列表保持 `display:flex; flex-direction:column`。
- 所有项目单元默认 `order: 1000000`，非成员之间保持原生文档顺序。
- 每个成员按其原生 DOM 顺序设置 `order`（组内拖拽重排后下一次刷新即跟随），并用 `margin-left: 12px` 形成组内缩进。
- 折叠组的成员加 `display: none !important`；展开时移除该规则。
- 组序号使用 1000 的间隔，成员 `+10..`，占位 `+900`，「新建项目组」在最后一个组之后、非成员之前。

项目单元本身没有 inline style 或属性被修改；删除样式表即可完全恢复原生顺序。

## 组标题与外来节点

- `renderer-project-groups-header.ts` 把组标题、收起列表占位和「新建项目组」作为 `div[role="listitem"]` 直接插入原生列表。
- 组标题通过 inline `order` 排在组成员之前；DOM 位置优先放在该组第一个已挂载成员单元之前，没有成员时追加到列表末尾。
- 组标题包含名称、机器摘要（单个机器显示名称，多个显示「N 台」，完整列表在 tooltip/aria-label）、悬停「＋新对话」和「⋯管理」。
- 「＋」打开机器/项目选择器；「⋯」和「新建项目组」打开管理弹窗。
- 节点带 `data-codexhost-project-groups-ui`，MutationObserver 忽略自身插入/更新，避免刷新自激。
- React 正常状态更新会保留外来节点；当 React 替换整个 Projects 列表（例如折叠再展开 section）时旧节点被分离，下一次 refresh 会把它们重新插入新列表。

## 折叠与收起列表

- 组折叠只影响组成员单元和占位行；组标题保留，`aria-expanded` 同步。
- 原生 Projects 列表处于收起状态时，已挂载成员照常显示在组内。
- 未挂载成员仅在存在原生「展开显示」按钮、且该成员没有在 Projects 之外渲染（例如原生置顶区）时，显示一行「N 个成员项目在收起的列表中 · 展开」；点击代理原生按钮并刷新。
- 没有「展开显示」时，未挂载成员不显示占位，也不报错。

## 新对话

- 组标题「＋」打开机器/项目选择器；机器显示状态，离线、未挂载或缺新对话按钮的成员禁用。
- 选中项目后点击该项目行原生的新对话按钮；按钮携带完整 `projectKind/hostId/projectId`，Agent 选择器自然是该机器的服务商。
- 按钮缺失或 disabled 时提示，不重试、不自动发送消息。

## 组管理

- 组标题「⋯」或「＋ 新建项目组」打开管理弹窗。
- 支持改名、增/移除成员、删除组；成员快照来自当前 Host 项目目录。
- 一个项目只能属于一个组；保存使用当前 revision，冲突时提示并重新加载。
- 删除组只是从组列表移除；原生项目从未被移动，立即恢复。

## 降级与诊断

- `<html data-codexhost-project-groups-state="probing|active|disabled">`。
- `window.__codexhostProjectGroupsV1.status()` 返回 `state/reason/groupCount/projectCount/missingMembers/lastError`。
- `missingMembers` 只统计配置里已不在 Desktop 项目目录的成员；未挂载但目录仍存在的成员不计为错误。
- `window.__codexhostProjectGroupsV1.refresh()` 手动刷新；`dispose()` 完全移除样式与外来节点。
- 常见 reason：`projects-section-missing`、`contract-missing:projects-section|projects-list|project-units|project-row-identity|has-selector`、`host-unavailable`、`desktop-catalog-unavailable`。
- 审计 surface `project-groups` 记录 Projects section 数、项目数、缺新对话按钮数、契约是否通过；section 不存在时 `unverified`，存在但契约失败时 `confirmed-impact`。

## 已知限制

- 布局依赖原生列表是 flex column 和 Chromium 的 `:has()`；Desktop 改版导致契约不满足时整体 fail-open。
- 组标题/占位是 React 列表里的外来节点；React 替换列表容器到下一次 refresh 之间可能存在一个短暂空档（debounce 约 40ms）。
- 组成员视觉顺序跟随原生 DOM 顺序，组标题顺序由组配置 `order` 决定；跨组拖拽不会改变成员归属。
- 缩进只是视觉上的 `margin-left`，不改变原生 DOM 层级和拖拽目标。
- 组折叠状态保存在当前 Renderer 内存中，不写回 `groups.json`。
- 原生置顶区等 Projects 之外的项目不会出现在组内，也不显示占位。
- 多窗口通过 revision 冲突避免静默覆盖；没有实时 BroadcastChannel 同步，另一个窗口在 focus/刷新后看到最新配置。

## 手动验收

1. 新建组：加入一个本机项目和一个远程项目；组标题出现在 Projects 顶部，成员项目块位于组标题下方并带缩进，非成员保持原顺序。
2. 组内对话：悬停出现原生信息卡片和置顶/归档按钮；右键出现完整原生菜单（重命名、置顶、未读、分叉、复制、新窗口、归档、永久删除）；快捷键可用。
3. 组内项目行：悬停出现原生「···」和新对话图标；「···」菜单完整，远程项目含「编辑连接…」；编辑项目弹窗与组外一致。
4. 组标题「＋」选择机器/项目：在对应项目打开新对话，Agent 选择器是该机器的服务商。
5. 编辑组：改名、加/移除成员；保存后组成员顺序和缩进同步。
6. 删除组：原生项目立即恢复。
7. 折叠组：成员项目块隐藏，组标题保留；展开后恢复。
8. 收起 Projects：已挂载成员照常显示；未挂载成员显示一行「N 个成员项目在收起的列表中 · 展开」，点击后原生展开。
9. 失败注入：临时删除一个 `data-app-action-sidebar-project-row` 属性；组功能应自动 disabled，原生列表完整。
10. 两窗口：一边改组并保存，另一边保存旧 revision 应看到冲突提示，而不是覆盖。
