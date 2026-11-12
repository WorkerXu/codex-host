# 跨机同名项目（Cross-host Project Mirror）

本功能让本机「只填名字」创建的原生项目，在模型选择器里提供「其他机器」入口：选中某台远程机器的服务商/模型后，codexhost 在该机器创建同名项目，打开该项目的空白新对话并预选该模型，最后尝试把两端项目加入同名项目组。

对应 A 阶段调研与拍板见 [`docs/proposals/cross-host-project-mirror.md`](../proposals/cross-host-project-mirror.md)。本文只描述当前行为。

## 边界

- 仅针对**本机**、单 root、位于 `defaultProjectParent`（默认 `~/Documents/ChatGPT`）下、basename 与项目名匹配的项目；远程项目不能作为源项目。
- 只在「新对话」Composer 中提供入口；已有对话不显示。
- 不迁移草稿、附件、引用；不自动发送。
- 目标机必须是已连接的 SSH Host；离线时机器置灰。
- 不写 `.codex-global-state.json`；项目创建走 Desktop 自己的 renderer 服务。
- 项目组只通过 `codexhost/project-groups/*` RPC 联动，不依赖 renderer 组显示实现。

## 入口

1. 用户点击原生项目行的「新对话」。
2. Composer 的模型下拉由 Desktop React 管理；codexhost 在原生模型按钮的 `click` 后等待菜单出现。
3. 在菜单末尾追加 `data-codexhost-cross-host-model-menu` 分组：
   - 按机器分组，显示连接状态；离线/错误机器禁用。
   - 展开机器后列出该机器的服务商（`model_providers`），再展开列出模型（`model/list`）。
4. 该分组只在 `agent === "codex"` 且 Composer 的 model target 是 `default`（新对话）时尝试注入；任何一步失败都 fail-open，不影响原生模型菜单。

## 只填名字识别

- 启发式：`rootPaths.length === 1`，父目录等于 `defaultProjectParent`，basename 等于 `sanitize(name)` 或 `sanitize(name) <n>`。
- 第一次使用时弹出确认对话框；确认后把 `sourceProjectId` 写入 codexhost 登记表。取消不写。
- 识别不确定或项目已改名时不提供该入口，而不是猜测。

## 目标路径

- `<目标机 home>/Documents/ChatGPT/<name>`（`name` 经 Desktop 同款字符清洗）。
- 候选依次为 `<name>`、`<name> 2`、`<name> 3`…：
  - 已登记的镜像项目 → 复用。
  - 同路径已有同名项目 → 复用。
  - 同路径被不同名项目占用 → 跳过，尝试下一个候选。
  - 目录存在但不是项目 → 复用该目录。
  - 路径不存在 → 创建目录后建项目。
- 目录通过 Desktop renderer 服务 `appServices.workspaceFiles.createDirectory({hostId, path})` 创建；home 通过 `appServices.executionPaths.readHomeDirectory(hostId)` 获取。

## 创建项目

- 通过 `appServices.projects.createRemote({appearance:null, hostId, label, remotePath, reuseExisting:true})` 创建远程项目。该调用与 Desktop 内部 `create_project` 工具同源。
- 若目标机已有同名但不同路径的项目，不复用；按候选规则新建。
- 兼容层：在目标 Host 调用 `project/create {name, roots:[{path}], metadata:{}, idempotencyKey:<remoteProjectId>}`；失败只写日志，不影响主流程。使用 remote project id 作为幂等键，未来 Desktop 迁移时不会重复建项目。
- 创建后等待侧栏出现 `data-app-action-sidebar-project-id="<id>"`，再点击该项目行的原生新对话按钮。

## 模型预选

- 选择时记录 `pending`：`hostId → {modelId, reasoningEffort}`，TTL 60 秒。
- 新 Composer 挂载且 model target 为 `default` 时，通过 adapter 的 `applyCodexModel` 写入 draft：
  - `findScopedDraftModelBinding` + `createScopedDraftModelWriter` 设置 `modelSettings.model`；
  - `reasoningEffort` 使用模型 `defaultReasoningEffort`（为空时保留当前值）。
- 写入失败时保留默认模型，不阻塞对话打开。

## 项目组

- 组名等于源项目名。
- 源项目与镜像项目加入同名组；组不存在则创建。
- 一个项目只能属于一个组；任一项目已在其他组时跳过本次自动分组，并 toast 一次。
- `replace` 使用当前 revision；冲突时重新读取并重试一次。

## 存储

```text
~/.codexhost/project-mirrors/mirrors.json
```

```json
{
  "formatVersion": 1,
  "revision": 1,
  "projects": {
    "local-source-id": {
      "hostId": "remote-ssh-discovered:colab",
      "remoteProjectId": "…",
      "remotePath": "/root/Documents/ChatGPT/demo",
      "label": "demo",
      "createdAt": "…",
      "updatedAt": "…"
    }
  },
  "acknowledged": { "local-source-id": true }
}
```

Host 只提供本地 RPC：

- `codexhost/project-mirror/list`
- `codexhost/project-mirror/upsert`（revision + `acknowledge` / `record` / `record:null`）

## 失败与降级

| 失败点 | 行为 |
| --- | --- |
| 机器离线/无路由 | 菜单中置灰；不创建 |
| home/dir 读取失败 | toast，结束 |
| `createRemote` 返回 null（用户取消信任确认） | toast，结束 |
| 项目已创建但侧栏未出现（5s） | toast「项目已创建，请稍后手动打开」 |
| 原生新对话按钮不存在/禁用 | toast，项目保留 |
| 模型写入失败 | 新对话保留默认模型 |
| `project/create` 失败 | 仅日志，继续 |
| 自动分组失败/冲突 | toast，项目与对话不受影响 |

## 已知限制

- 原生模型菜单没有公开 DOM 契约；注入依赖「触发按钮附近的可见浮层」探测，Desktop 改版可能失效。失效时只隐藏「其他机器」，不影响原生菜单。
- 菜单被 React 整体替换时可能丢失注入节点；当前只监听菜单自身 childList 并尽量重挂。
- 首台机器的目录会触发 Desktop 的文件夹信任确认（如果尚未信任）。
- 不处理项目改名后的重新识别；登记表以 projectId 为准，改名不影响镜像，但启发式入口需要重新确认。
