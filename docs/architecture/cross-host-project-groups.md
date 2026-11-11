# 跨机项目组（Cross-host Project Groups）

本功能把多个原生 Codex Desktop 项目（可来自本机和不同远程连接）组合成一个侧边栏项目组。组配置属于 codexhost，不写入 Desktop 状态；隐藏原生项目行只通过样式完成，删除组即可恢复原状。

本实现对应 A 阶段报告 [`docs/proposals/cross-host-project-groups.md`](../proposals/cross-host-project-groups.md)。报告里的建议与最终拍板有差异时，以本篇的当前行为为准。

## 边界

- 只支持原生项目；projectless 对话不能进组。
- 组只镜像原生侧当前可见的项目/对话，不重建 Thread 排序或完整历史。
- 所有隐藏、组块和交互都在 Renderer extension 内完成；Host Runtime 只提供本地配置和 Desktop 项目目录的只读 RPC。
- 不写 `.codex-global-state.json`，不移动或克隆 React 管理的项目单元/对话行。
- Desktop DOM 契约不满足时整体 fail-open：移除组块和隐藏样式，回到原生列表。

## 组成

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 共享契约 | `packages/shared-contracts/src/project-groups.ts` | 组/成员/RPC schema，浏览器安全 |
| 组配置存储 | `packages/mapping-store/src/project-groups.ts` | `groups.json` 原子写、revision、损坏隔离 |
| Host 服务 | `packages/host-runtime/src/project-groups-service.ts` | 组合存储与 Desktop 项目目录读取 |
| Desktop 项目目录 | `packages/host-runtime/src/desktop-project-catalog.ts` | 只读 `.codex-global-state.json` 的 4 个目标键 |
| Host RPC | `packages/host-runtime/src/app-server-host.ts` | `codexhost/project-groups/list|replace`、`codexhost/desktop-projects/catalog` |
| Renderer companion | `packages/renderer-extension/src/renderer-project-groups*.ts` | 组块、隐藏、对话行、菜单代理、新对话、管理 |
| 契约审计 | `packages/renderer-extension/src/renderer-project-groups-dom.ts`、`contract-audit.ts` | 提供 `project-groups` audit surface |

## 数据流

1. Renderer 启动时读取一次 preload 的 `getInitialSidebarBootstrap()`。该值是初始快照，preload 会缓存，不能用于刷新。
2. Renderer 通过本地 Host 调用：
   - `codexhost/project-groups/list` 获取组配置与 revision；
   - `codexhost/desktop-projects/catalog` 获取新鲜的项目目录（`local-projects`、`remote-projects`、`thread-project-assignments`、`codex-managed-remote-connections`、`project-order`）。
3. Host 只读 `$CODEX_HOME/.codex-global-state.json`（默认 `~/.codex`），只投影需要的字段；解析失败重试一次，仍失败返回错误，Renderer 保留上一份目录。
4. Renderer 监听 window `message`：
   - `global-state-updated` 且 key 命中项目状态；
   - `thread-project-memberships-updated`。
   收到后 debounce 刷新 Host 目录。
5. 需要展示的对话来自原生项目列表 DOM；不需要为每个项目额外发 `thread/list`。

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
- 读取失败或 zod 校验失败时隔离为 `groups.json.<timestamp>.invalid`，以空配置继续，不阻塞 Host。
- `replace` 带 `revision`；不一致返回 `-32082`，Renderer 提示冲突并重新加载，不静默覆盖。
- 成员 `rootPaths` / `hostId + remotePath` 是项目 ID 迁移后的 fallback 识别依据。

## Renderer DOM 契约

依赖 Desktop 自己的 `data-app-action-sidebar-*` 属性；这些属性也是 Desktop `app.get_summary` 和 sidebar app actions 使用的同一套契约。

| 目标 | 选择器 |
| --- | --- |
| Projects 区域 | `section[data-app-action-sidebar-section][data-app-action-sidebar-section-heading="Projects"]` |
| 项目列表 | Projects section 内 `div[role="list"]` |
| 项目单元 | 项目列表直接子项 `div[role="listitem"]` |
| 项目行 | `[data-app-action-sidebar-project-row]` |
| 项目 ID/名称 | `data-app-action-sidebar-project-id` / `-label` |
| 项目对话列表 | `[data-app-action-sidebar-project-list-id="<id>"]` |
| 对话行 | `[data-app-action-sidebar-thread-row]` |
| 新对话按钮 | 项目行内 `button:not([aria-haspopup]):not([data-app-action-sidebar-select-project])` |

`probeProjectGroupsContract` 要求 Projects section、项目列表、至少一个项目单元、项目行 ID/名称、每个项目行的唯一新对话按钮。任一项不满足即 `disabled`，不隐藏任何项目。

## 隐藏与组块

- 隐藏：向 `document.head` 注入一个 `<style data-codexhost-project-groups>`，按成员 ID 生成
  `section[...] div[role="list"] > div[role="listitem"]:has([data-app-action-sidebar-project-row][data-app-action-sidebar-project-id="..."]) { display:none!important }`。
- 不支持 `:has()` 时退化为给项目单元加 `data-codexhost-project-group-hidden`，CSS 隐藏。
- 组块插入在 Projects 的 `div.group/nav-list` 内、原生 `div[role="list"]` 之前；它不在 React keyed list 里，不参与项目列表 reconciliation。
- 删除组、Host 不可用超过 5 秒、契约失败或手动 dispose 时移除样式/组块，原生项目立即恢复。

## 对话行与悬停菜单

- 对话行从原生项目列表读取标题、选中/激活、置顶状态，自己渲染；点击时找到同 `thread-id` + `host-id` 的原生行并 `.click()`。
- 原生项目被 `display:none` 隐藏时，原生对话菜单的锚点会失效。右键先尝试在组内行坐标派发原生 `contextmenu`；如果菜单没有出现在组内行附近，再尝试临时 ghost 锚点，仍失败则不再依赖原生弹层。
- 行尾「⋯」直接打开 codexhost 自己的代理菜单；菜单项来自原生行上真实存在的按钮（置顶/取消置顶、归档及其他带 aria-label 的按钮），点击代理到原生按钮。没有可用动作时不显示入口。
- 状态 `menu` 区分：`native-context`（原生右键菜单成功）、`proxy-menu`（本地代理菜单可用）、`unavailable`（没有可用动作）。
- 原生菜单/代理菜单关闭后触发一次组刷新，保持组内列表与原生状态一致。

## 新对话

- 组行「＋」打开机器/项目选择器；机器显示状态，离线/缺失项目禁用。
- 选中项目后点击该项目行原生的新对话按钮；按钮携带完整 `projectKind/hostId/projectId`，Agent 选择器自然是该机器的服务商。
- 项目被 CSS 隐藏不影响程序化 click；折叠项目的新对话按钮仍在项目行里。
- 按钮缺失或 disabled 时提示，不重试、不自动发送消息。

## 组管理

- 组行「⋯」或「＋ 新建项目组」打开管理弹窗。
- 支持改名、增/移除成员、删除组；成员快照来自当前 Host 项目目录。
- 一个项目只能属于一个组；保存使用当前 revision，冲突时提示并重新加载。
- 删除组只是从组列表移除；原生项目从未被移动，立即恢复。

## 降级与诊断

- `<html data-codexhost-project-groups-state="probing|active|disabled">`。
- `window.__codexhostProjectGroupsV1.status()` 返回 state/reason/groupCount/projectCount/missingMembers/menu/threadActions/lastError。
- `window.__codexhostProjectGroupsV1.refresh()` 手动刷新；`dispose()` 完全移除。
- 常见 reason：`projects-section-missing`、`contract-missing:*`、`host-unavailable`、`desktop-catalog-unavailable`、`native-context-menu-*`。
- 契约审计新增 `project-groups` surface：Projects section 存在时检查项目数、对话行数、缺新对话按钮数、原生菜单能力和整体契约；不满足则 `confirmed-impact`。

## 已知限制

- 折叠项目没有原生对话列表容器，组内显示“已折叠/展开”，点击走原生项目行；不会自动展开。
- `show-all=false` 的项目可能只渲染部分对话；组内显示“查看全部”，点击原生 toggle；完整 `thread/list` 聚合留到第二期。
- 组固定在 Projects 顶部，不支持排到任意原生项目之间。
- 同机多项目时，机器小节内再按项目分小组；只有一个项目时直接列对话。
- 组内对话行不复制原生 hover 菜单的 DOM；「⋯」打开 codexhost 的代理菜单，右键优先尝试原生菜单。
- 多窗口通过 revision 冲突避免静默覆盖；没有实时 BroadcastChannel 同步，另一个窗口在 focus/刷新后看到最新配置。

## 手动验收

1. 新建组：加入一个本机项目和一个远程项目；成员项目从原生列表消失，组行出现在 Projects 顶部，右侧显示机器名。
2. 展开组：机器小节、状态点、对话标题/顺序与原生一致；同机多项目出现项目小标题。
3. 点击组内对话：进入对应 Thread；返回后组仍展开。
4. 在组内对一条本机对话和一条远程对话分别执行置顶/取消置顶/归档：原生状态一致，组内列表刷新，菜单出现在组内行旁。
5. 组行「＋」选择机器/项目：在对应项目打开新对话，Agent 选择器是该机器的服务商。
6. 编辑组：改名、加/移除成员；保存后隐藏集合和组内容同步。
7. 删除组：原生项目/对话立即恢复，顺序不变。
8. 折叠成员：组内显示“已折叠/展开”，点击后在原生侧展开并刷新组。
9. 失败注入：临时删除一个 `data-app-action-sidebar-project-row` 属性；组功能应自动 disabled，原生列表完整。
10. 两窗口：一边改组并保存，另一边保存旧 revision 应看到冲突提示，而不是覆盖。
