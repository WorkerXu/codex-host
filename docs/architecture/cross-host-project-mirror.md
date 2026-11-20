# 跨机同名项目（Cross-host Project Mirror）

本功能让「只填名字」创建的原生项目，在 Agent/Harness 选择器里提供「其他机器」入口：选中某台机器的 Harness 后，codexhost 在该机器创建同名项目，打开该项目的空白新对话并预选该 Harness（模型使用其默认值）。源项目可以是本机项目，也可以是另一台机器上的同名项目；后者的「其他机器」里会出现本机（「此计算机」）。

## 边界

- 源项目必须是单 root、位于默认项目目录下、basename 与项目名匹配的项目：
  - 本机项目：父目录等于 `defaultProjectParent`（默认 `~/Documents/ChatGPT`）。
  - 远程项目：父目录以 `/Documents/ChatGPT` 结尾（远端 home 与本机不同，无法比较绝对路径）。
- 目标机器包含本机和所有已连接的其它机器，但排除源项目所在机器。
- 只在「新对话」Composer 中提供入口；已有对话不显示。
- 不迁移草稿、附件、引用；不自动发送。
- 目标机必须是已连接的 SSH Host；离线时机器置灰。
- 不写 `.codex-global-state.json`；项目创建走 Desktop 自己的 renderer 服务。

## 入口

1. 用户点击原生项目行的「新对话」。
2. 打开 Composer 右下角的 Agent/Harness 图标按钮（模型名右侧、麦克风左侧）。该按钮和弹框都由 codexhost 创建：
   - 根：`[data-codexhost-agent-control]`
   - 触发：`button[aria-haspopup="menu"][aria-controls="<composerId>-agent-menu"]`
   - 菜单：`<div id="<composerId>-agent-menu" role="menu" popover="auto">`
3. Composer Agent 菜单平铺已安装的本机 Agent。菜单打开时在末尾追加 `data-codexhost-cross-host-agent-menu` 分组：
   - 按机器分组，机器名优先用 Desktop 的 `displayName`（如 `oracle-sg`）；离线置灰。只作为残留远程项目存在、没有 Desktop 显示名且离线的 Host 不显示，避免暴露原始 Host ID。
   - 展开机器后列出该机器的 Harness：Codex 固定第一项，其余来自目标 Host 的插件目录，并按该 Host 的 availability 只保留 `ready`（未安装/不可用不显示）。
   - 行高、内边距、字体和图标复用 Agent 选择器原生行；机器行带服务器图标与状态点，Harness 行缩进一级并带各自图标。
   - 列表加载中/失败用一条与原生行同色的次要文字展示，不再放右侧徽标；滚动由整个弹框承担。
4. 已有对话中 Agent 触发按钮为 `disabled`，菜单不会打开；因此该分组只出现在新对话草稿里。
5. 模型菜单不再注入任何分组。

## 只填名字识别

- 启发式：`rootPaths.length === 1`，父目录等于 `defaultProjectParent`，basename 等于 `sanitize(name)` 或 `sanitize(name) <n>`。
- 不需要首次确认：只要判定为只填名字项目，分类信息就立即出现在「其他机器」里。
- 识别不确定或项目已改名时不提供该入口，而不是猜测。

## 目标路径

- 远程目标：`<目标机 home>/Documents/ChatGPT/<name>`（`name` 经 Desktop 同款字符清洗）。
- 候选依次为 `<name>`、`<name> 2`、`<name> 3`…：
  - 已登记的镜像项目 → 复用。
  - 同路径已有同名项目 → 复用。
  - 同路径被不同名项目占用 → 跳过，尝试下一个候选。
  - 目录存在但不是项目 → 复用该目录。
  - 路径不存在 → 创建目录后建项目。
- 目录通过 Desktop renderer 服务 `appServices.workspaceFiles.createDirectory({hostId, path})` 创建；home 通过 `appServices.executionPaths.readHomeDirectory(hostId)` 获取。`ProjectMirrorDesktopServices` 保持这套嵌套形状，不拍平成顶层方法。
- 本机目标（远程 → 本机）：不自行拼路径。已有同名只填名字本机项目时直接复用；否则调用 Desktop 的本地创建，由 Desktop 按自己的规则创建 `~/Documents/ChatGPT/<name>`（必要时编号为 `<name> 2`）。

## 创建项目

- 远程目标：`appServices.projects.createRemote({appearance:null, hostId, label, remotePath, reuseExisting:true})`。该调用与 Desktop 内部 `create_project` 工具同源。
- 本机目标：`appServices.projects.createLocal({appearance:null, initializeDefaultWorkspaceGitRepository:false, name, setActive:false, sources:[]})`。`sources` 为空时 Desktop 自己创建默认项目目录；返回 `{projectId, rootPaths}`。`setActive:false` 不改变用户当前选中的项目。
- 若目标机已有同名但不同路径的项目，不复用；按候选规则新建。
- 兼容层：在目标 Host 调用 `project/create {name, roots:[{path}], metadata:{}, idempotencyKey:<remoteProjectId>}`；失败只写日志，不影响主流程。使用 remote project id 作为幂等键，未来 Desktop 迁移时不会重复建项目。
- 创建后等待侧栏出现 `data-app-action-sidebar-project-id="<id>"`，再点击该项目行的原生新对话按钮。等待使用 `MutationObserver` 观察侧栏，不做固定间隔轮询。

## 进度反馈

- 点击「其他机器」里的 Harness 后立即（同一事件循环内，远小于 100ms）在 Composer 上方显示一张紧凑状态卡：`data-codexhost-project-mirror-progress`，`role="status"`、`pointer-events:none`，不抢焦点也不拦截信任弹窗的点击。
- 步骤文案：先「正在 <机器> 上准备项目…」；确认需要新建项目后切到「正在 <机器> 上创建项目…」→「加入分区…」→「打开新对话…」；结束时显示「已在新对话中打开」约 1.6 秒后自动消失，失败显示中文原因约 8 秒。
- 信任提示「接下来 Desktop 会请你确认信任这个文件夹」只在创建步骤显示：只有真正调用 `createRemote` 才会触发 Desktop 原生信任弹窗，复用已有项目时不会出现，也就不会显示该提示。等待用户确认的时间属于创建步骤，不会被跳过或代为确认。本机目标（`createLocal`）不显示该提示。
- 卡片宽度按内容自适应，上限 360px，并随窗口缩放/滚动重新定位；上方空间不足时翻到 Composer 下方，始终留在视口内。
- 层级使用 Desktop 自己的 `--toast-z-index`（`--max-app-overlay-z-index - 1`），低于模态遮罩层，保证信任弹窗和遮罩永远在卡片之上。
- 若原 Composer 节点已被 Desktop 重建，重新定位前会按 `[data-codex-composer-root]` 找当前可见的 Composer；找不到时保持上一次位置，不会按全 0 矩形跳到左上角。
- 本机目标的准备/创建文案分别为「正在本机准备项目…」「正在本机创建项目…」。

## 自动分区与登记

- 分区加入和登记表写入在项目创建成功后立即并行启动，不阻塞新对话打开；任一步失败都在对话打开后通过既有提示/诊断报告。
- `chooseMirrorDestination` 返回它实际探测到的目录状态，避免创建前再次 `fs/getMetadata` 重复一次远程往返。

- 镜像项目与源项目放进同一个 Desktop 原生分区。运行期按窗口实际暴露的接口选路径：
  - 有 `appServices.savedCustomSections` 时，使用 `applySavedCustomSectionCommand`：源项目已在某分区就把远程项目的 `codex:project:<remoteProjectId>` 移入该分区，否则新建以项目名命名的分区并同时包含两个项目；命令返回的 transition 在 `local` 和目标 Host 上补齐分区副本（`createSection` + `saveReplica`，已有 `hostSectionIds` 时跳过）。
  - 没有该服务时（当前 Desktop），分区只存在持久化 atom `sidebar-custom-sections-v3` 中。此时调用侧栏模块导出的原生命令：`Jn(scope, name, itemKeys)` 对应「新建分区…」，`f2(scope, sectionId, itemKey)` 对应「移到分区」，两者与项目 `···` 菜单及拖拽共用同一代码路径；当前分区的读取走同一模块导出的 `QV` atom。`scope` 是已提交 React 树里 Sidebar 组件的 AppScope。
  - 原生命令模块按导出形状发现，AppScope 按 `AppScope` 标记发现；不写死 chunk 文件名或 module id。
  - 分区状态由 Desktop 自己持久化和广播；codexhost 不直接写 atom、全局状态文件或 app-server 分区状态。
- 分区服务不可用、原生命令未产生预期变更或副本创建失败时，提示「项目已创建，但未能自动加入同一分区」，新对话仍照常打开；不留下半写入的侧栏状态。

## Harness 预选

- 点击目标项目的原生新对话按钮时，记录机器、项目和所选 Harness，60 秒内有效。
- 目标机器和项目的可见空白草稿挂载后，走现有 Agent 切换：
  - 目标 Harness 和草稿已选 Harness 一致时，直接使用当前草稿。
  - 其他 Harness：目标 Host 报告 `ready` 后执行 `switchComposerAgent`；模型与推理强度由 `inspectHarness` 的 catalog 默认值/新对话偏好自动应用。
- 项目打开后，如果切换未完成，后续草稿渲染最多每 800ms 重试一次，直到期满或用户开始填写草稿。

## 存储

```text
~/.codexhost/project-mirrors/mirrors.json
```

```json
{
  "formatVersion": 1,
  "revision": 1,
  "projects": {
    "source-project-id": {
      "hostId": "remote-ssh-discovered:colab",
      "remoteProjectId": "…",
      "remotePath": "/root/Documents/ChatGPT/demo",
      "label": "demo",
      "createdAt": "…",
      "updatedAt": "…"
    }
  }
}
```

Host 只提供本地 RPC：

- `codexhost/project-mirror/list`
- `codexhost/project-mirror/upsert`（revision + `record` / `record:null`）

旧版本写入的 `acknowledged` 字段仍可读取，下一次写入时被丢弃；它不再影响任何行为。

## 失败与降级

| 失败点 | 行为 |
| --- | --- |
| 机器离线/无路由 | 菜单中整行置灰；不创建 |
| home/dir 读取失败 | 状态卡显示中文原因，结束 |
| `createRemote` 返回 null（用户取消信任确认） | 状态卡显示中文原因，结束 |
| `createLocal` 返回 null（用户取消） | 状态卡显示中文原因，结束 |
| 项目已创建但侧栏未出现（5s） | 状态卡「项目已创建，但侧栏尚未显示，请稍后手动打开」 |
| 原生新对话按钮不存在/禁用 | 状态卡「该项目当前不可用，可能已离线」，项目保留 |
| 自动分区失败 | 对话打开后提示「项目已创建，但未能自动加入同一分区」，不阻塞 |
| Harness 切换失败/超时 | 新对话保留当前 Harness |
| `project/create` 失败 | 仅日志，继续 |

## 诊断

`window.__codexhostProjectMirrorV1.status()` 返回：

```ts
{
  pickerDetected: boolean;   // Agent 菜单打开钩子是否触发
  projectEligible: boolean;  // 最近一次打开时是否判定为 name-only 新对话
  peersLoaded: number;       // Harness 目录加载成功的机器数
  lastError: string | null;  // 最近一次失败原因
  projectSource: "composer" | "catalog" | null;
  projectReason: "unknown" | "eligible" | "no-project" | "missing-project" | "not-name-only" | "catalog-error";
  machineCount: number;
}
```

项目判定优先读 Composer 根节点 React fiber 上的 `selectedProject`；只有缺失时才回退到 Host catalog 的 `selected-project`。因此 `projectSource` 可用于判断是否命中了稳定的 Composer 上下文；`projectReason` 给出不适用的具体原因（项目缺失、非 name-only、目录读取失败等）。

## 已知限制

- Agent 选择器由 codexhost 创建，DOM 契约稳定；但若未来重做该选择器，需要同步更新 `data-codexhost-agent-control` / `<composerId>-agent-menu`。
- 目标 Host 的 `codexhost/harness/plugins/list` 需要 codexhost Host Runtime；旧版 Host 会显示「列表不可用」，仅保留 Codex。
- 首台机器的目录会触发 Desktop 的文件夹信任确认（如果尚未信任）。
- 不处理项目改名后的重新识别；登记表以 projectId 为准，改名不影响镜像，但启发式入口需要重新确认。
