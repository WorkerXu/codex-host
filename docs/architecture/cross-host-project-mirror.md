# 跨机同名项目（Cross-host Project Mirror）

本功能让本机「只填名字」创建的原生项目，在 Agent/Harness 选择器里提供「其他机器」入口：选中某台远程机器的 Harness 后，codexhost 在该机器创建同名项目，打开该项目的空白新对话并预选该 Harness（模型使用其默认值），最后尝试把两端项目加入同名项目组。

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
2. 打开 Composer 右下角的 Agent/Harness 图标按钮（模型名右侧、麦克风左侧）。该按钮和弹框都由 codexhost 创建：
   - 根：`[data-codexhost-agent-control]`
   - 触发：`button[aria-haspopup="menu"][aria-controls="<composerId>-agent-menu"]`
   - 菜单：`<div id="<composerId>-agent-menu" role="menu" popover="auto">`
3. 菜单打开时在末尾追加 `data-codexhost-cross-host-agent-menu` 分组：
   - 按机器分组，机器名优先用 Desktop 的 `displayName`（如 `oracle-sg`）；离线置灰。
   - 展开机器后列出该机器的 Harness：Codex 固定第一项，其余来自目标 Host 的 `codexhost/harness/plugins/list`，过滤 `kind === "usage"`。
   - 列表加载失败时仍保留 Codex，并标注「列表不可用」。
4. 已有对话中 Agent 触发按钮为 `disabled`，菜单不会打开；因此该分组只出现在新对话草稿里。
5. 模型菜单不再注入任何分组。

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

## Harness 预选

- 选择时记录 `pending`：`hostId → {agentId}`，TTL 60 秒。
- 新 Composer 挂载且 model target 为 `default` 时，调用现有 draft agent switch：
  - 目标 Harness 是 `codex`：无需切换，默认对话已是 Codex。
  - 其他 Harness：等待目标 Host 的 availability 变为 `ready`（按需刷新，最多约 2.5 秒），再执行 `switchComposerAgent`；模型与推理强度由 `inspectHarness` 的 catalog 默认值/新对话偏好自动应用。
- 切换失败时保留默认 Codex 对话，不阻塞项目打开；之后再次渲染会按 800ms 间隔重试，直到 60 秒 TTL。

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
| Harness 切换失败/超时 | 新对话保留默认 Codex，不阻塞 |
| `project/create` 失败 | 仅日志，继续 |
| 自动分组失败/冲突 | toast，项目与对话不受影响 |

## 诊断

`window.__codexhostProjectMirrorV1.status()` 返回：

```ts
{
  pickerDetected: boolean;   // Agent 菜单打开钩子是否触发
  projectEligible: boolean;  // 最近一次打开时是否判定为 name-only 新对话
  peersLoaded: number;       // Harness 目录加载成功的机器数
  lastError: string | null;  // 最近一次失败原因
  projectSource: "composer" | "catalog" | null;
  projectReason: "unknown" | "eligible" | "no-project" | "remote-project" | "missing-project" | "not-name-only" | "catalog-error";
  machineCount: number;
}
```

项目判定优先读 Composer 根节点 React fiber 上的 `selectedProject`；只有缺失时才回退到 Host catalog 的 `selected-project`。因此 `projectSource` 可用于判断是否命中了稳定的 Composer 上下文；`projectReason` 给出不适用的具体原因（远程项目、非 name-only、目录读取失败等）。

## 已知限制

- Agent 选择器由 codexhost 创建，DOM 契约稳定；但若未来重做该选择器，需要同步更新 `data-codexhost-agent-control` / `<composerId>-agent-menu`。
- 目标 Host 的 `codexhost/harness/plugins/list` 需要 codexhost Host Runtime；旧版 Host 会显示「列表不可用」，仅保留 Codex。
- 首台机器的目录会触发 Desktop 的文件夹信任确认（如果尚未信任）。
- 不处理项目改名后的重新识别；登记表以 projectId 为准，改名不影响镜像，但启发式入口需要重新确认。
