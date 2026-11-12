# 跨机同名项目（Cross-host Project Mirror）A 阶段调研报告

- 日期：2026-11-12
- 仓库：`/home/ubuntu/work/codex-host-mirror`
- 分支：`feat/project-mirror`，基线 `602f1fa4`
- 目标机器：Mac（macOS），Codex Desktop `26.1027.61615`，内置 Codex CLI `0.166.0-alpha.5.1`；5 台远程 Host 的 app-server 均为 `0.163.0`
- 调研方式：只读阅读仓库源码；SSH 到 Mac 读取 `~/.codex/.codex-global-state.json`、`~/.codex/state_5.sqlite`、`~/.codexhost/project-groups/groups.json`、远程 Host 的 `~/.codex/state_5.sqlite`；通过 loopback CDP（`127.0.0.1:49332`）执行只读 `Runtime.evaluate`，调用只读 RPC（`project/list`、`model/list`、`config/read`、`fs/getMetadata`）并读取 React fiber 上的原生 props；按字节偏移读取 `ChatGPT.app/Contents/Resources/app.asar`。
- 只读声明：本阶段没有修改仓库代码、没有 commit、没有点击/输入/创建项目、没有修改 Mac 或任何远程机器上的文件与 Codex 状态。唯一写入是本报告；分析用的临时文件都在本机 `/home/ubuntu/asar-copy`。

> 说明：Desktop 是压缩后的产物，没有 source map。下文对 Desktop 内部实现的引用使用 **`app.asar` 字节偏移 + 符号/片段**（当前文件大小 674,615,301 字节）；偏移会随 Desktop 升级漂移，符号名和调用结构才是判断依据。仓库代码使用 **文件:行号**。

---

## 0. 结论速览

| # | 问题 | 一句话结论 |
| --- | --- | --- |
| 1 | 「只填名字」项目的本质 | **本机**：Desktop 在 `~/Documents/ChatGPT/<清洗后的名字>` 建目录（父目录可用 `defaultProjectParent` 覆盖），重名时追加 ` 2`、` 3`；状态只记 `local-projects` 的 `name + rootPaths`，**没有任何“自动建目录”标记**，只能靠路径模式启发式判断。**远程**：新建项目弹窗根本不允许只填名字，必须填远程绝对路径；但 Desktop 内部另有一条 `create_project` 工具路径，会建 `<home>/<name>-<uuid>`。 |
| 2 | 项目由谁管理 | 本机项目已迁到 app-server（`project/list` 返回 10 条，与 `local-projects` 一一对应）；**远程项目仍只存在 Mac 的 `remote-projects`**，5 台远程 app-server 的 `projects` 表全空、`project/list` 全返回 `[]`。app-server 有完整 `project/*` RPC（list/read/create/import/update/move/delete + `project/changed`、`thread/project/updated` 通知）。 |
| 3 | 程序化创建远程同名项目 | 首选 **Renderer 内调用 Desktop 自己的 `workspaceFiles.createDirectory` + `projects.createRemote`**（`create_project` 工具就是这么做的）；次选打开原生弹窗预填路径后提交；`app-server project/create` 只能写目标机数据库、**不会出现在 Desktop 侧栏**，只能作为未来兼容层。 |
| 4 | 跨 Host 服务商/模型 + 新对话 | `__codexhostHostRoutingV1.knownHostIds()` + `forHost(id).manager.sendRequest("model/list")` 已在现场验证可用（local/india/oracle-tokyo/oracle-main 各 39 个，tencent 12 个，colab 8 个）；打开目标项目的新对话用项目行里的原生按钮 `.click()`；模型用 `findScopedDraftModelBinding` + `createScopedDraftModelWriter`/`route.policy.select` 写入 draft；草稿可从 `electron-persisted-atom-state["composer-prompt-drafts-v2"]` 读出，再用 ProseMirror `insertText` 写进新 Composer。 |
| 5 | 项目组联动 | 直接复用 `codexhost/project-groups/list` 与 `…/replace`（revision 全量替换，冲突 `-32082`）。同名组存在就追加成员，不存在就新建；一个项目只能属于一个组（schema 强制），跨组时要“移动或跳过”。 |
| 6 | 边界 | 离线/目录缺失/同名不同路径/一端改名删除都要显式处理；最安全的原则是“只增不删”：镜像项目与组都不自动删除对方，缺失成员标记 `missing`。 |
| 7 | 兼容性风险 | 最大风险是 Desktop 把远程项目也迁到 app-server（迁移脚手架已存在）导致 `remote-projects` 语义变化；其次是项目服务对象/Renderer 内部 API、draft memo 布局、ProseMirror controller、侧栏 DOM、`model/list` 形状。策略是能力探测 + 每步独立降级 + fail-open。 |
| 8 | 推荐方案 | **Renderer companion + 本地 Host 只读目录**：不直接改 `.codex-global-state.json`；用 Desktop 自己的 renderer 服务创建远程项目，用原生项目行新建对话，再写 draft 的模型与文本，最后 best-effort 建组。按契约、只读目录、建项目、开对话、建组、测试共 7 个 commit（第 2–8 项）。 |

---

## 0.1 B 阶段拍板与 spike 结论（2026-11-12）

### 拍板

1. 远程目录：`<目标机 home>/Documents/ChatGPT/<名字>`，递归创建；重名规则同本机（目录存在但不是项目→复用，已是该项目→`reuseExisting`，属于别的项目→追加 ` 2`、` 3`）。
2. 同时写目标机 app-server `project/create`，`idempotencyKey = <remoteProjectId>`；失败只记日志，不影响主流程。
3. 已存在同名项目组→直接追加成员；该项目已在别的组→跳过并 toast 一次。
4. 「只填名字」识别：启发式（`<defaultProjectParent>/<name>( \d+)?`、单 root、basename 匹配）+ 首次确认 + codexhost 自有登记表（mapping-store 旁独立文件，不写 Desktop 状态）。
5. 不迁移任何草稿/上下文；目标项目里打开空白新对话。
6. 不自动发送。
7. 推理强度用所选模型的默认值。
8. 入口是**聊天框右下角的模型选择器**（原生 Codex 模型下拉）末尾的「其他机器」分组；**不改 Agent 图标选择器**，只在「只填名字」项目的新对话 Composer 中出现。

### Spike：Renderer 服务对象可达（路径 A 成立）

通过 `__codexhostLoadedModulesV1` 找到已加载的 `app://-/assets/rpc-*.js`，该模块直接导出：

```js
appHost, appServices, setAppHost, setAppServices
```

现场只读验证（CDP `Runtime.evaluate` + dynamic import）：

| 服务 | 验证结果 |
| --- | --- |
| `appServices.projects.createRemote` | `typeof === "function"` |
| `appServices.workspaceFiles.createDirectory` | `typeof === "function"` |
| `appServices.executionPaths.readHomeDirectory(hostId)` | `local → {homeDirectory:"/Users/coderxu"}`；`colab → {homeDirectory:"/root"}` |
| `appServices.projects.createRemote({})` | 返回 `Invalid remote project create request`（方法存在，参数校验拦截，未创建任何项目） |
| `appServices.workspaceFiles.createDirectory({})` | 返回 `The "path" argument must be of type string`（方法存在，未创建目录） |

结论：

1. 不需要走路径 B（原生创建远程项目弹窗）；实现可以直接调用 Desktop 自己的 `createRemote` / `createDirectory`，与内部 `create_project` 工具同源。
2. 服务对象不是 `window` 全局，而是已加载模块的 live export；发现方式与仓库现有 `loadCodexNativeServices` 一致（扫描 `__codexhostLoadedModulesV1` 的模块导出，按 shape 匹配）。
3. `readHomeDirectory` 可在 renderer 直接取目标机 home，用于拼接 `~/Documents/ChatGPT/<name>`；不必在目标机执行命令。
4. 原生模型下拉是 Desktop React 组件，扩展通过“点击原生模型按钮后，在打开的菜单末尾追加 own 分组”的方式接入；追加失败时整体 fail-open（不显示「其他机器」），不影响原生模型选择。

---

## 1. 「只填名字」项目的本质（Q1）

### 1.1 本机创建链路

Desktop 主进程里负责“只填名字时自动建目录”的是 `createDefaultWorkspaceRoot`（`app.asar` 偏移 `11294014`，`sanitizeDefaultProjectName` 在 `11293565`）：

```js
async createDefaultWorkspaceRoot(e, t) {
  if (rsL(this.host)) throw Error("Creating a default workspace is only supported for local hosts");
  let r = this.sanitizeDefaultProjectName(e),
      n = this.settingsStore?.getEffective(Szl.defaultProjectParent.key)
          ?? join(app.getPath("documents"), "ChatGPT");
  if (!isAbsolute(n)) throw Error("Default project parent must be an absolute local path");
  let i = await this.findAvailableDefaultWorkspaceRoot(n, r, void 0);
  return await PCQ.mkdir(i, { recursive: true }, this.appServerClient), t && await this.initializeDefaultWorkspace(i), i
}
```

关键点：

1. **父目录**默认是 `app.getPath("documents")/ChatGPT`，即 `~/Documents/ChatGPT`；可被设置项 `defaultProjectParent` 覆盖（同一段代码 + `settings-store` 的 `requirements.application.storage.defaultProjectParent`）。
2. **名字清洗**：替换控制字符和 `<>:"/\|?*` 为 `_`，去掉结尾空格/点，空名回退到默认名（现场目录可见 `New project`、`New project 2`…），Windows 保留名加 `_` 前缀。
3. **重名不覆盖**：`findAvailableDefaultWorkspaceRoot` 依次尝试 `<name>`、`<name> 2`、`<name> 3`…（偏移 `11294014` 内）。
4. **可选 git init**：`initializeDefaultWorkspace` 在设置允许时对新目录执行 `git init`。
5. 该函数在非本地 Host 上**直接抛错**：`Creating a default workspace is only supported for local hosts`。这是“远程不能只填名字”的第一条硬证据。

调用入口在 IPC `electron-create-new-workspace-root-option`（偏移 `11281203`）：

```js
case "electron-create-new-workspace-root-option": {
  let r = await this.createDefaultWorkspaceRoot(t.projectName ?? eeR, t.initializeGitRepository),
      n = t.projectName ?? eeR,
      i = this.projectsManager.hasProjectNamed(n) ? void 0 : n;
  await this.projectFolderPicker.createOrSelectProject(e, r, i);
  break
}
```

`projectsManager.createLocal`（偏移 `11769341`）在 `sources.length === 0` 时才会走 `createDefaultWorkspaceRoot`；一旦用户选了源文件夹，就走 `sources` 分支，不创建目录。

### 1.2 现场数据（本机）

`~/.codex/.codex-global-state.json` 的 `local-projects` 共 10 条。两条典型的“只填名字”项目：

```json
"762aba51-d16c-4628-a025-03786236d74a": { "name": "colab",    "rootPaths": ["/Users/coderxu/Documents/ChatGPT/colab"] }
"28b31213-9441-403d-abc7-dc3508997984": { "name": "codexhost","rootPaths": ["/Users/coderxu/Documents/ChatGPT/codexhost"] }
```

目录也真实存在：

```text
~/Documents/ChatGPT/colab       (含 .git)
~/Documents/ChatGPT/codexhost   (含 .git)
```

对照“用户选的源文件夹”项目：

```json
"local-26b1d86411393cf7872733d98484a92d": { "name": "Downloads", "rootPaths": ["/Users/coderxu/Downloads"] }
"3106b9bd-9323-429d-890e-fba7269c7546": { "name": "安心买",     "rootPaths": [11 个 /Users/coderxu/Downloads/...] }
```

### 1.3 状态里怎么记录

- 本地项目：顶层 `local-projects`（对象，key 为 legacy project id），字段只有 `id`、`name`、`rootPaths`、`createdAt`、`updatedAt`，可选的 ChatGPT 关联字段。
- 远程项目：顶层 `remote-projects`（数组），字段 `{id, hostId, remotePath, label}`；顺序在 `project-order`。
- 迁移映射：`app-server-project-id-by-legacy-project-id-by-host`、`app-server-projects-migration-by-host`。
- 现场 `app-server-project-id-by-legacy-project-id-by-host` 只有 **一个 host key**：`local:/Users/coderxu/.codex`；`app-server-projects-migration-by-host` 也只有同一个 key，`projectsMigrated: true`，`threadAssignmentsMigrated: false`，`pending 274`。**没有任何远程 host 的迁移记录。**
- app-server 侧 `project/list` 返回的项目 `metadata` 一律是 `{}`（本机 10 条全部为空对象），**没有“自动创建”标记**。

### 1.4 能否可靠区分“自动建目录”和“用户选的源文件夹”？

**不能 100% 可靠区分。** 理由：

- 状态里没有 source 字段，也没有创建方式字段；
- 用户可以手动把 `~/Documents/ChatGPT/foo` 选为源文件夹，结果与自动创建同形；
- 用户可以在创建后改名，`name` 与目录名不再一致；
- 自动创建会 `git init`，但用户文件夹也可能有 `.git`，不能当标记。

可行的**启发式**（建议采用并加上自有登记表）：

```text
rootPaths.length === 1
&& dirname(rootPaths[0]) === defaultProjectParent（默认 ~/Documents/ChatGPT）
&& basename(rootPaths[0]) === sanitize(name)   // 或 basename 以 `${name} ` 开头且后缀是数字
```

补充：`createDefaultWorkspaceRoot` 在目录重名时会生成 `<name> 2`，此时 `basename != name`，启发式需要允许 `^<name>( \d+)?$`。

建议 codexhost 自己维护一份“镜像登记表”（放到现有 `mapping-store`，不要写 Desktop 状态），记录 `hostId + remotePath + sourceProjectId`。启发式只用于**首次识别**，识别不确定时让用户确认，而不是静默处理。

### 1.5 远程世界的真实规则（重要修正）

现场把 5 台远程都验证了一遍：

| Host id | 显示名 | app-server `project/list` | `~/.codex/state_5.sqlite` 的 `projects` 表 |
| --- | --- | --- | --- |
| `remote-ssh-discovered:oracle-main` | oracle-sg | `[]` | 0 行 |
| `remote-ssh-discovered:colab` | colab | `[]` | 0 行 |
| `remote-ssh-codex-managed:99831a21-…` | india | `[]` | 0 行 |
| `remote-ssh-codex-managed:a0ed298e-…` | oracle-tokyo | `[]` | 0 行 |
| `remote-ssh-codex-managed:967b5332-…` | tencent | `[]` | 0 行 |

同时 `remote-projects` 只有 2 条：

```json
{ "id": "9935bfaa-…", "hostId": "remote-ssh-discovered:colab",       "remotePath": "/root/逆向",        "label": "逆向" }
{ "id": "b285194d-…", "hostId": "remote-ssh-discovered:oracle-main", "remotePath": "/home/ubuntu/codex", "label": "codex" }
```

其中 `/root/逆向` 在 colab 上**实际不存在**（`fs/getMetadata` 返回 `No such file or directory (os error 2)`），但侧栏仍然显示该项目。这证明：**远程项目是 Mac 本地的元数据，允许指向不存在的目录。**

远程“只会填名字”时，Desktop 的行为分两条完全不同的路径：

1. **新建项目弹窗（用户手动）**：切到远程设备后，弹窗标题和说明变成 “Choose folder path / Enter a folder path on {host} to use for this project.”（懒加载 chunk `webview/assets/create-project-dialog-5d973a8dd7a1.js`，`app.asar` 偏移 `246766357`，23,012 字节；`workspaceRootDialog.title.pick`）。提交时调用：

   ```js
   projects.createRemote({ appearance, hostId, label, remotePath })
   ```

   （chunk 内偏移约 `11638`；主进程 `ProjectsManager.createRemote` 在 `app.asar` `11780039`）。`createRemote` 的入参 schema 是 `{appearance, hostId, label, remotePath, reuseExisting?}`（`11763802` 附近的 `eh8`），`remotePath` 必填。**没有“只填名字”分支。**

2. **Desktop 内部的 `create_project` 工具（模型/App Action 调用）**：这是一个真正的“只填名字 + 自动建目录”远程路径（`app.asar` 偏移 `313944068`，函数 `Eu`；调用方在 `313945140`）。下面按原逻辑改写变量名，便于阅读：

   ```js
   let { homeDirectory } = await query.snapshot(ya, { hostId }).getOrFetch();
   o = posix.join(homeDirectory, `${sanitizeDirectoryName(name)}-${crypto.randomUUID()}`);
   let createDirectory = services.workspaceFiles.createDirectory;
   if (createDirectory == null) throw Error("Remote project creation is not supported by this host.");
   await createDirectory({ hostId, path: o });
   let project = await projects.createRemote({ appearance: null, hostId, label: name, remotePath: o });
   ```

   注意目录名是 `<name>-<uuid>`，**不是** `<name>`；因此“已存在就复用”无法直接用它。

**结论**：需求里的“在远程也只填名字、自动建同名目录”不是现有弹窗能力，但 Desktop 内部具备全部原语（跨机 `createDirectory` + `createRemote`），我们可以按同样的语义实现，只是把目录规则改成确定性的同名目录。

---

## 2. 项目归属与 app-server project RPC（Q2）

### 2.1 app-server 的 project RPC

从活着的 Host 直接发一个不存在的方法，返回的合法方法表里包含（local 0.166 与 remote 0.163 都一致）：

```text
project/list, project/read, project/create, project/import,
project/update, project/move, project/delete
```

通知：

```text
project/changed            { changeType: "created"|"updated"|"deleted", projectId }
thread/project/updated     { threadId, projectId|null }
```

协议 schema（用本机工作区的 `codex-cli 0.163.0` 执行 `codex app-server generate-json-schema --experimental` 生成；远程 Host 同为 0.163，方法名已在其 app-server 上实测）：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `project/list` | `{cursor?, limit?, sortKey?: "position"\|"recencyAt", sortDirection?}` | `{data: Project[], nextCursor?}`，分页上限 100 |
| `project/read` | `{projectId}` | `{project}` |
| `project/create` | `{name, roots: [{path}], metadata?: Record<string,string>, idempotencyKey}` | `{project}` |
| `project/import` | 同上 + `threads?: string[]` | `{project}` |
| `project/update` | `{projectId, name?, roots?, metadata?}` | `{project}` |
| `project/move` | `{projectId, beforeProjectId?}` | `{}` |
| `project/delete` | `{projectId}` | `{}` |

`Project` 字段：`{id, name, roots, metadata, position, createdAt, updatedAt, recencyAt}`（Unix 秒）；`metadata` 是 `string → string` 的 map。

本机 app-server 的 `projects` / `project_roots` 表结构（`~/.codex/state_5.sqlite`）：

```sql
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
                       position INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
CREATE TABLE project_roots (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                            position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, position));
CREATE TABLE project_idempotency_keys (key TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
```

`project_idempotency_keys` 是未来去重的关键：Desktop 迁移时用 legacy project id 作为 `idempotencyKey`（见 2.3）。

### 2.2 本机：app-server 已是权威

- `local-projects` 10 条，`project/list` 10 条，id 通过 `app-server-project-id-by-legacy-project-id-by-host` 一一映射（例如 `28b31213-… → 01a1c8bf-…`）。
- Desktop 的 `HostAppServerProjects` 类负责双向同步：`initializeProjects`（`app.asar` `11748686`）在连接建立时拉 `project/list`，按 `APP_SERVER_PROJECT_ID_BY_LEGACY_PROJECT_ID_BY_HOST` 复原映射；`writeAppServerProject`（`11744526`）在本地项目变更时调用：

  ```js
  project/create 或 project/import { name, roots: [{path}], metadata, idempotencyKey: legacyProjectId }
  project/update  { projectId, name, roots, metadata }
  ```

- 版本门：`initializeProjects` 里 `if (!supports(connection.appServerVersion, "projects")) { projectSupport = "unsupported"; return }`。本机 0.166 通过；远程 0.163 的 `project/list` 实测可用，但 Desktop 并没有为远程执行迁移（见下）。

### 2.3 远程：Desktop 本地 legacy state 是权威

证据链：

1. 5 台远程的 app-server `projects` 表全空、`project/list` 全 `[]`。
2. `app-server-projects-migration-by-host` 只有 `local:/Users/coderxu/.codex` 一个 key。
3. 侧栏里 2 个远程项目来自 `remote-projects`，其 id 是 UUID（legacy 风格），不是 ULID（app-server 风格）。
4. `ProjectsManager.createRemote`（`11780039`）只写 `REMOTE_PROJECTS` 和 `PROJECT_ORDER`，不调用 app-server。
5. 远程项目允许指向不存在的目录（`/root/逆向`），进一步说明它只是本地元数据。

所以对远程 Host：**“项目”在 Desktop 侧等于 `remote-projects` 里的一条记录；目标机 app-server 里没有对应实体。** 需求里“在那台机器的 Codex 里创建项目”如果按 Desktop 的现状理解，就是“在目标机建目录 + 在 Mac 侧栏建远程项目记录”；如果按 Codex 协议理解，才需要额外调用 `project/create`。这两件事目前是分离的。

### 2.4 Desktop「创建项目」弹窗的调用链

| 用户操作 | 实际调用 | 证据 |
| --- | --- | --- |
| 本机 + 只填名字 | `createDefaultWorkspaceRoot` → `mkdir` → `projectsManager.createLocal({name, sources: []})` → 写 `local-projects`，再异步同步到 app-server `project/create` | `11294014`、`11769341`、`11744526` |
| 本机 + 选文件夹 | `pickProjectSources` → `createLocal({name, sources})` | `11769341` |
| 远程 + 填路径 | `projects.createRemote({hostId, label, remotePath})` → 只写 `remote-projects` + `project-order` | `11780039`、dialog chunk `11638` |
| 远程 + 路径不存在 | 先 `workspaceFiles.createDirectory({hostId, path})`，再 `createRemote` | dialog chunk 内偏移 `11198`（`app.asar` `252941017`）；`313943915` |
| 远程 + “添加新项目”按钮 | `ProjectFolderPicker.createOrSelectProject` 检测到非本地 Host，直接给 renderer 发 `remote-workspace-root-requested`，打开远程路径弹窗 | `11191599` |

结论：**弹窗在“远程设备 + 只填名字”这个组合下没有调用，因为它不允许这个组合。** 现场能复现的最小差异是：远程模式一定要求 `remotePath`。

---

## 3. 程序化创建远程同名项目的可行路径（Q3）

### 3.1 路径对比

| 路径 | 做法 | 结果是否与手动一致 | 可靠性 | 风险 |
| --- | --- | --- | --- | --- |
| **A. Renderer 服务（首选）** | 在 renderer 里调用 `workspaceFiles.createDirectory({hostId, path})` + `projects.createRemote({appearance:null, hostId, label, remotePath, reuseExisting:true})` | **一致**：`create_project` 工具与弹窗最终都走 `createRemote` | 高（前提是拿到服务对象） | 服务对象 `Yi`/host-services 是模块级，不在 `window` 上；需要 B 阶段定位稳定取用点 |
| **B. 原生弹窗（次选）** | `dispatchHostMessage({type:"open-create-remote-project-modal", hostId, initialDirectoryPath})`，等弹窗挂载后填路径并点击“创建” | **完全一致**（就是用户手点） | 中 | 需要驱动 React 输入与本地化按钮；会打断用户 |
| **C. app-server `project/create`（兼容层）** | 目标 Host `fs/createDirectory` + `project/create {name, roots, metadata, idempotencyKey}` | **不一致**：目标机有项目记录，但 Desktop 侧栏不会出现 | 中（RPC 可用） | 当前 Desktop 不消费远程 app-server projects；未来迁移可能产生重复 |
| **D. 直接写 `.codex-global-state.json`（拒绝）** | Host Runtime 改文件 | 不一致 | 低 | Desktop 内存态会覆盖；无广播；可能损坏状态 |

### 3.2 推荐路径 A 的调用序列

```text
1) 目标 Host：fs/getMetadata({path})                     // 判断目录/项目是否存在
2) 目标 Host：fs/createDirectory({path, recursive:true})  // 仅在不存在时
3) renderer：projects.createRemote({ appearance:null, hostId, label:name,
                                     remotePath:path, reuseExisting:true })
4) 等侧栏出现 projectId 对应的项目行（MutationObserver）
5) （可选，兼容层）目标 Host：project/create({ idempotencyKey: <remoteProjectId>,
                                               name, roots:[{path}], metadata:{} })
```

第 3 步的 `reuseExisting:true` 正好满足“已存在就复用”：`createRemote` 内部按 `(hostId, canonical(remotePath))` 查重，已存在直接返回旧记录（`11780039`）。

第 5 步用 `idempotencyKey = <remoteProjectId>`：如果 Desktop 未来把远程也迁移到 app-server，迁移代码会用同一个 legacy id 作为 key（`11744526` 的 `idempotencyKey: t.id`），从而命中 `project_idempotency_keys` 返回同一条，不会重复建项目。

### 3.3 路径 A 的未决点（B 阶段第一个 spike）

`create_project` 工具与创建弹窗都通过 renderer 的服务对象访问 `workspaceFiles` / `projects`：

- `Yi?.workspaceFiles.createDirectory`（`app.asar` `313943915`、`252951778`）
- `projects.createRemote`（`313945140`、dialog chunk `11638`）
- 服务对象在模块作用域（`Yi`），不在 `window` 上；现有扩展已经能通过 React fiber 读取 `composerController`、request manager 等私有对象，同样的办法是否够用需要实测。

如果拿不到服务对象，退回路径 B（原生弹窗），不要退回路径 D。

### 3.4 目标机目录规则

三种候选：

| 规则 | 例 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 字面镜像本机 | `~/Documents/ChatGPT/<name>` | 与 Mac 上看到的路径结构一致 | Linux 服务器通常没有 `Documents`；需要递归创建 |
| 复用本机已有习惯 | `<home>/codex/<name>` | oracle-main 已有 `/home/ubuntu/codex` 项目，语义自然 | 与其他机器不统一 |
| 目标机 `home` 下平铺 | `<home>/<name>` | 简单 | 污染 home；与本机差异大 |

必须用**确定性路径**（不能用内部工具的 `<name>-<uuid>`），否则无法实现“已存在就复用”。建议做成 per-host 配置，默认值待拍板（见 8.4）。

重名规则复用本机语义：目录已存在但不是项目 → 视为可复用；目录已存在且已是项目 → `reuseExisting`；目录存在但属于别的项目 → 追加 ` 2`、` 3`。

---

## 4. 跨 Host 列出服务商/模型并在目标项目新建对话（Q4）

### 4.1 现有 Agent 选择器的定位

`renderer-agent-picker.ts` 是 **Harness 级**选择器（Codex / Claude Code / …），不是模型选择器；它按 Composer 挂载，`mountRendererAgentPicker(composerId, enabledAgents, …)`（`packages/renderer-extension/src/renderer-agent-picker.ts:196`）。真正的模型选择：

- 原生 Codex：Desktop 自己的 Model 菜单，扩展不接管。
- 外部 Harness：扩展自己的 `renderer-model-picker.ts`。
- 每个 Composer 属于哪个 Host：`renderer-binding-probe.ts:784-787` 的 `activeModelHostId()` → `modelControl.currentHostId(composer)`。

所以“在 Agent/模型选择器里看到其他机器”不能靠往 Desktop 原生菜单里插项（它是 React 组件，没有扩展点）；需要扩展自己的入口（建议放在 Agent 选择器里的 “Other machines” 分组，或模型按钮旁的独立 chip）。这是产品形态问题，见 8.4。

### 4.2 列出其他 Host 的服务商与模型（已现场验证）

每个 Host 的客户端已经在 renderer 里可用：

- `packages/desktop-control/src/renderer-host-routing.ts:202-213`：`knownHostIds()` / `forHost(hostId)`。
- `packages/renderer-extension/src/renderer-host-clients.ts:23-164`：`createRendererHostClients(readRouting)` 为每个 Host 建 `RendererModelClient`。
- `packages/desktop-control/src/renderer-host-discovery.ts:78-128`：从 Composer 的 fiber props `executionTargetHostId` / `permissionsHostId` 和 registry 里发现 Host。

现场通过 CDP 直接调用（只读）：

```js
const routing = window.__codexhostHostRoutingV1;
routing.knownHostIds()
// ["local","durable",
//  "remote-ssh-codex-managed:967b5332-…",  // tencent
//  "remote-ssh-codex-managed:99831a21-…",  // india
//  "remote-ssh-codex-managed:a0ed298e-…",  // oracle-tokyo
//  "remote-ssh-discovered:colab",
//  "remote-ssh-discovered:oracle-main"]
await routing.forHost(hostId).manager.sendRequest("model/list", {});
```

结果：

| Host | 模型数 | 示例 model id |
| --- | --- | --- |
| local | 39 | `eshetang/gpt-6.1-sol` |
| india | 39 | `eshetang/gpt-6.1-sol` |
| oracle-tokyo | 39 | `eshetang/gpt-6.1-sol` |
| oracle-main | 39 | `eshetang/gpt-6.1-sol` |
| tencent | 12 | `gpt-6.1-sol` |
| colab | 8 | `gpt-6.1-sol` |

每个模型字段：`id, model, displayName, description, hidden, isDefault, defaultReasoningEffort, supportedReasoningEfforts[], serviceTiers[], additionalSpeedTiers[], inputModalities[], …`。

服务商（provider）来自 `config/read` 的 `model_providers`：

| Host | 默认 `model_provider` | 配置的服务商 |
| --- | --- | --- |
| local | `magpie` | `magpie`（Magpie (Oracle Singapore)）、`eshetang`（OpenAI） |
| colab | `eshetang` | `eshetang` |
| tencent | `eshetang` | `eshetang` |

`model/list` 不返回 provider 字段，且传 `{modelProvider}` 不过滤（实测三种入参都返回 39 条）。可行的归属规则：

```text
model id 含 "/" → provider = 前缀
否则 → provider = 该 Host 的 config.model_provider
```

这正好能解释 `displayName` 里的 `· eshetang` 后缀。展示层按 `机器 → 服务商 → 模型` 分组即可。

### 4.3 在目标项目打开新对话

复用现有项目组 companion 的做法（`packages/renderer-extension/src/renderer-project-groups.ts:670-690`）：

```js
const row = projectRowForUnit(projectUnitForId(section, projectId));
const button = newChatButton(row);          // renderer-project-groups-dom.ts:235
button.click();                             // 原生“在 <label> 中开始新聊天”
```

现场 fiber 证据：远程项目行对应的原生组件 props 里带着完整项目身份：

```json
{ "groupId":"9935bfaa-…", "projectId":"9935bfaa-…", "projectKind":"remote",
  "hostId":"remote-ssh-discovered:colab", "hostDisplayName":"colab",
  "label":"逆向", "path":"/root/逆向" }
```

点击后 Composer 的 `executionTargetHostId` 就是该 Host（`renderer-host-discovery.ts:98` 读取的同一属性），模型目录自然来自该 Host。

限制：项目行必须已经在侧栏 DOM 中（CSS 隐藏不影响程序化 `.click()`；折叠项目的按钮仍在项目行里，见 `docs/architecture/cross-host-project-groups.md:116-121`）。新建对话按钮不依赖对话列表，所以 `show-all=false` 的分页不是问题。

### 4.4 预选服务商/模型

对原生 Codex draft，现有适配器已经实现了“把指定模型写进 draft”：

- `packages/renderer-extension/src/versioned-renderer-adapter.ts:1071` 创建 `createScopedDraftModelWriter()`。
- `:1103` 用 `findScopedDraftModelBinding(composer, draftId)` 找绑定。
- `:1108-1112` 先 `route.policy.select(model, draftId, creationModes)`，再 `draftModels.apply(draftId, binding, model)`。
- `packages/desktop-control/src/renderer-scoped-draft-model.ts:150-184` 写入 `modelSettings.model`、`isManuallyChanged: true`、`modelSettingsPersistAsDefault: false`；不改全局默认。

细节：

1. **模型 id 用 `model/list` 返回的完整 id**。远程 `id` 不带 provider 前缀时，provider 由目标 Host 的 `config.model_provider` 解析；如果用户选的是非默认 provider 的模型，id 必须带前缀（`provider/model`）。
2. **推理强度**：`draftModels.apply` 保留旧 `reasoningEffort`，可能不被新模型支持。建议在写模型后把 `reasoningEffort` 显式设为该模型的 `defaultReasoningEffort`（需要扩展 `apply` 或在 `route.policy.select` 里带 effort）。
3. 只有 `modelTarget[0] === "default"`（新对话 draft）才允许写；`conversation` 目标不允许改模型（`renderer-binding-probe.ts:671-683`）。这与“先在目标项目开新对话、再选模型”的顺序一致。
4. 写入失败时保持默认模型并提示用户，不要回滚用户选择。

### 4.5 草稿迁移

Desktop 的草稿就在 `electron-persisted-atom-state` 里：

```text
composer-prompt-drafts-v1:  { "client-new-thread:<uuid>": "纯文本", ... }
composer-prompt-drafts-v2:  { "client-new-thread:<uuid>": { prompt: string | ProseMirror doc, ... }, ... }
```

读取：`packages/host-runtime/src/desktop-project-catalog.ts:99-101` 已经支持从顶层或 `electron-persisted-atom-state` 取值（`value = root[key] ?? atom[key]`）。把 `composer-prompt-drafts-v2` 加进 catalog 的只读投影即可，不需要新文件通道。

写入目标 Composer 有两条路：

- **ProseMirror（首选）**：`findNativeComposerController(editor)` + `view.state.tr.insertText()`（`renderer-native-composer-controller.ts:52-100`）。先 `delete(0, size)` 再 `insertText(text)`，等新 Composer 挂载后执行。
- **draft atom（备选）**：`window.electronBridge.sendMessageFromView({type:"persisted-atom-update", key:"composer-prompt-drafts-v2", value, deleted:false, recordUpdate:true})`；主进程 handler 在 `app.asar` `11262833`。适合纯文本和需要跨重启保留的场景。

v1 只迁移纯文本；`agentMention`、图片、附件、技能引用不迁移（ProseMirror doc 可以序列化，但写回需要构造 schema 节点，风险高）。这一点要写进用户提示。

---

## 5. 项目组联动（Q5）

### 5.1 现有 RPC 与存储

- 契约：`packages/shared-contracts/src/project-groups.ts:4-6`（`codexhost/project-groups/list|replace`、`codexhost/desktop-projects/catalog`）。
- Host 实现：`packages/host-runtime/src/app-server-host.ts:3333-3360`。
- 存储：`~/.codexhost/project-groups/groups.json`，`formatVersion:1` + `revision`，原子写（`packages/mapping-store/src/project-groups.ts:99-132`）。
- 现场：Mac 上文件存在，`revision: 7`，1 个组“跨机前端”，成员是本机“安心买” + 远程 `oracle-main` 的 `/home/ubuntu/codex`。`window.__codexhostProjectGroupsV1.status()` 返回 `active`。
- 项目组只由**本地 Host** 提供：远程调用返回 `-32601 "Project groups are available on the local Host only"`（`app-server-host.ts:3334-3340`）。

### 5.2 自动建组/加成员

```text
groups = (await rpc.list()).groups
group  = groups.find(g => g.name.trim() === projectName.trim())
if (!group) {
  group = { id: uuid(), name: projectName, order: maxOrder+1, collapsed:false,
            members: [], createdAt: now, updatedAt: now }
}
// 成员唯一性：schema 要求一个项目只能属于一个组
ensureMember(group, { projectKind, projectId, hostId, remotePath|rootPaths, label })
await rpc.replace({ revision, groups })
```

关键约束：

- `projectGroupsSchema` 用 `${kind}\0${projectId}` 全局去重（`shared-contracts/src/project-groups.ts:50-82`），重复会导致 `replace` 参数校验失败。
- `replace` 是**全量替换**，必须带上当前 `revision`；冲突返回 `-32082`（`mapping-store/src/project-groups.ts:120-131`）。`renderer-project-groups-rpc.ts:30-48` 已封装。
- 组成员解析有 fallback：远程成员按 `hostId + remotePath` 匹配（`renderer-project-groups-model.ts:185-209`），所以即使未来 projectId 迁移，组也不会立刻失效。

### 5.3 同名组/冲突规则建议

| 情况 | 建议 |
| --- | --- |
| 已存在同名组，且成员不冲突 | 追加镜像项目成员（保留原有顺序） |
| 已存在同名组，但镜像项目已在另一个组 | 默认**跳过**并提示；用户确认后才“移动”（从旧组删除） |
| 存在多个同名组 | 合并到一个（保留 order 最小的），删除其余；这一操作不可自动做，需确认 |
| 组名与项目名大小写不同 | 视为同名（`trim` + 大小写不敏感），但保留用户已有写法 |
| `replace` 冲突 | 重新 list 后重试一次；仍失败则只完成项目和对话，不建组 |

项目组是“锦上添花”，失败不能阻塞前两步。

---

## 6. 边界与异常（Q6）

| 场景 | 建议行为 |
| --- | --- |
| **目标机离线/未连接** | 在 picker 里禁用该机器（用 `routing.forHost(hostId) === null` 或连接状态）；不建目录、不建项目、不建组；保留当前草稿 |
| **目标机在线但 `fs` RPC 不可用** | 视为不支持镜像，提示“该机器的 Codex 版本不支持跨机建项目” |
| **目标目录已存在、无项目记录** | 直接复用目录，创建 `remote-projects` 记录（`reuseExisting:false` 也可，因为按 path 查重会返回旧记录） |
| **目标目录已存在、有项目记录** | `reuseExisting:true` 复用，不重复建组 |
| **目标机已有同名但不同路径的项目** | 不静默复用。弹窗让用户选“复用已有（路径 A）/新建同名目录（路径 B）”；默认新建 |
| **目标机已有同路径但不同 label 的项目** | 按路径复用，保留原 label；组名用源项目名，成员 label 用实际 label |
| **目录重名（非项目）** | 追加 ` 2`、` 3`，项目名保持用户输入（与本机语义一致） |
| **Mac 侧项目改名** | 只影响展示；组按 projectId/路径匹配，刷新后 label 更新；镜像登记表同步 label |
| **Mac 侧删除项目** | 组里标记 `missing`，不自动删除远程目录/项目；提供“清理镜像”动作 |
| **远程侧删除项目** | 同上，Mac 侧记录可能仍在（Desktop 不会联动），标记缺失 |
| **一端改名导致组内 label 不同** | 以 Desktop catalog 的 label 为准，组配置只是快照 |
| **重复点击/并发创建** | 用 `idempotencyKey`/`reuseExisting` + 本地 in-flight 锁；组操作用 revision 冲突兜底 |
| **项目行尚未出现在侧栏** | 等 MutationObserver，超时 5s 后提示并保留状态（项目已建，新对话未开） |

---

## 7. 兼容性风险与降级（Q7）

| 风险 | 表现 | 概率 | 降级 |
| --- | --- | --- | --- |
| 远程项目迁移到 app-server | `remote-projects` 不再被读取，或迁移时重复建项目 | 中 | 用 `idempotencyKey = remoteProjectId` + 按 path 查重；迁移后以 app-server projectId 重新登记 |
| Renderer 服务对象不可达 | 拿不到 `workspaceFiles` / `projects.createRemote` | 中 | 退回原生弹窗（路径 B）；再不行提示手动创建 |
| Draft memo 布局变化 | `findScopedDraftModelBinding` 返回 null，模型写不进去 | 中高（代码注释已标注 26.1021） | 打开新对话后用原生模型菜单人工选择；或只完成建项目/建组 |
| ProseMirror controller 变化 | 草稿写不进去 | 中 | 提示用户手动粘贴；源草稿不删除 |
| 侧栏 DOM 契约变化 | 找不到项目行/新对话按钮 | 中 | 使用 `data-app-action-sidebar-*` 能力探测，失败即提示 |
| `model/list` 形状变化 | 模型列表为空或字段缺失 | 低 | 按 Host 显示“模型不可用”，只允许建项目 |
| `project/*` 版本门 | 远程 0.163 以下不支持 | 低（实测 0.163 支持） | 跳过兼容层，只做 Desktop 侧 |
| hostId 变化（alias 改 UUID） | 组/登记表失效 | 中 | 以 `remotePath + label` 做二次匹配；hostId 变更时提示重新绑定 |
| 并行项目组改造（另一 worktree） | 组块渲染变化，RPC 不变 | 中 | 只依赖 `project-groups/list` 与 `…/replace` 契约，不依赖 DOM 组块 |

**分层降级原则**：

1. 建目录失败 → 中止，不建项目。
2. 建项目失败 → 中止，草稿留在原 Composer。
3. 打开新对话失败 → 项目保留，提示“已创建项目，请手动打开”。
4. 模型写入失败 → 新对话保留默认模型，提示。
5. 草稿迁移失败 → 原草稿不删，提示手动复制。
6. 建组失败 → 前 4 步结果保留，提示。

---

## 8. 推荐方案与 commit 拆分（Q8）

### 8.1 目标流程（用户视角）

1. 用户在本机“只填名字”项目的 Composer 里点开扩展的 Agent/模型选择器。
2. 选择“其他机器 → 服务商 → 模型”。
3. 扩展在后台完成：目标机建同名目录（不存在时）→ 在 Desktop 创建同名远程项目 → 侧栏出现 → 打开该项目的新对话 → 预选模型 → 把当前草稿搬过去。
4. 扩展自动把源项目和镜像项目加入同名项目组。
5. 用户继续输入并发送；对话在目标机运行。

### 8.2 模块归属（遵守仓库边界）

| 能力 | 归属 |
| --- | --- |
| 源项目识别、镜像登记、路径规则 | `packages/host-runtime`（只读 catalog + `mapping-store`），新增 `project-mirror-service.ts` |
| 镜像/模型 RPC 契约 | `packages/shared-contracts` |
| 跨 Host 模型目录、picker UI、建项目、开新对话、写 draft、建组 | `packages/renderer-extension` |
| 每 Host 客户端 | 复用 `packages/desktop-control` 的 routing（不新增 Host 语义） |
| 组存储/RPC | 复用现有 `project-groups`，不改 |

不要在 `shared-contracts` 里引入 Node 依赖；不要写 `.codex-global-state.json`；不要在 Rust 侧加项目逻辑。

### 8.3 commit 拆分

1. `docs: add cross-host project mirror proposal`（本报告；可选，不提交也可）
2. `feat(shared-contracts): define project mirror contracts`
   - 镜像请求/结果、Host 能力、路径规则 schema；`desktop-projects/catalog` 增加草稿投影（只读）。
3. `feat(host-runtime): add project mirror registry`
   - `~/.codexhost/project-mirrors.json`（或并入 mapping-store）+ `codexhost/project-mirror/list|upsert`，仅本地 Host。
4. `feat(renderer-extension): list cross-host model catalogs`
   - 用 routing 遍历 Host，拉 `model/list` + `config/read`，按 机器/服务商 分组；picker 入口（先只读展示）。
5. `feat(renderer-extension): create mirror project on target host`
   - `fs/getMetadata`/`fs/createDirectory` + `projects.createRemote`（含 fallback 弹窗）+ 等待侧栏。
6. `feat(renderer-extension): open mirrored thread with model and draft`
   - 原生新建对话按钮 + `route.policy.select`/`draftModels.apply` + 草稿搬迁 + reasoning effort。
7. `feat(renderer-extension): auto-join mirror project group`
   - `project-groups/list|replace` 合并逻辑 + 冲突重试。
8. `test: cover mirror path rules, group merge, failure degradation` + 架构文档更新。

每个 commit 都应可独立回滚；2–3 是纯增量，4 只读，5–7 逐步接管写操作。

### 8.4 需要拍板的问题

1. **远程目录规则**：默认 `~/Documents/ChatGPT/<name>`（字面镜像）还是 `<home>/codex/<name>`（贴合 oracle-main 现状）？是否允许 per-host 覆盖？
2. **是否同时写目标机 app-server 的 `project/create`**：写了更“名副其实”，但当前 Desktop 不消费，未来迁移有重复风险（可用 `idempotencyKey` 去重）。建议默认写、可关闭。
3. **同名组已存在时的合并规则**：直接追加成员，还是必须用户确认？项目已在别的组时，移动还是跳过？
4. **“只填名字”项目识别**：严格路径启发式（误判少、漏判多），还是启发式 + 首次用户确认 + 自有登记表？建议后者。
5. **草稿迁移范围**：v1 只迁纯文本，还是也迁 `agentMention`/图片/附件？后者工作量和风险都高。
6. **是否自动发送**：推荐只搬运草稿、不自动发送，让用户确认。
7. **模型预选的推理强度**：用模型默认 effort，还是保留用户原来的 effort（可能不被支持）？
8. **入口形态**：放进 Agent 选择器的“其他机器”分组，还是模型按钮旁独立 chip？两者都不改 Desktop 原生菜单。

---

## 附录 A：关键证据索引

### A.1 `app.asar` 偏移（Desktop 26.1027.61615，674,615,301 字节）

| 偏移 | 符号/内容 |
| --- | --- |
| `11191599` | `ProjectFolderPicker.createOrSelectProject`；非本地 Host → `remote-workspace-root-requested` |
| `11281099` | IPC `electron-create-new-workspace-root-option` → `createDefaultWorkspaceRoot` |
| `11293565` | `sanitizeDefaultProjectName` |
| `11294014` | `createDefaultWorkspaceRoot`（本地限制、默认父目录、重名 ` 2`） |
| `11262833` | 主进程 `case "persisted-atom-update"` |
| `11763802` | `createRemote` 入参 schema `eh8`（`remotePath` 必填） |
| `11769341` | `ProjectsManager.createLocal`（`sources.length===0` → 默认工作区） |
| `11780039` | `ProjectsManager.createRemote`（只写 `REMOTE_PROJECTS` / `PROJECT_ORDER`） |
| `11744526` | `writeAppServerProject`（`project/create`、`project/import`、`project/update` + `idempotencyKey`） |
| `11748686` | `initializeProjects`（版本门、legacy↔server id 迁移） |
| `11751074` | `storeProject` / `listProjects`（`project/list` 分页） |
| `246766357` | `webview/assets/create-project-dialog-5d973a8dd7a1.js`（23,012 字节；远程路径模式） |
| `252941457` | 弹窗远程提交：`projects.createRemote` 或直接写 `REMOTE_PROJECTS` |
| `252941017` / `252951778` | 创建弹窗代码的另一份打包：`workspaceFiles.createDirectory({hostId,path})`（与 chunk 内 `11198` 同源） |
| `313944068` | `Eu`：远程“只填名字”内部实现（`<home>/<name>-<uuid>` + `createDirectory` + `createRemote`） |
| `313945140` | `create_project` 工具：远程走 `Eu`，本地走 `createLocal` |
| `377285570` | Renderer `persisted-atom-update` 派发 |

### A.2 现场只读观测

- `~/.codex/.codex-global-state.json`
  - `local-projects` 10 条；`remote-projects` 2 条（colab `/root/逆向`、oracle-main `/home/ubuntu/codex`）。
  - `app-server-project-id-by-legacy-project-id-by-host` 只有 `local:/Users/coderxu/.codex`。
  - `app-server-projects-migration-by-host` 只有 `local:/Users/coderxu/.codex`。
- Mac `~/.codexhost/project-groups/groups.json`：`revision: 7`，1 个组“跨机前端”，成员“安心买” + `oracle-main:/home/ubuntu/codex`。
- 5 台远程 `~/.codex/state_5.sqlite`：`projects`、`project_roots`、`project_idempotency_keys` 均 0 行。
- CDP `routing.knownHostIds()`：`["local","durable", tencent, india, oracle-tokyo, colab, oracle-main]`。
- CDP `project/list`：local 10 条；5 台远程全部 `[]`。
- CDP `model/list`：local/india/oracle-tokyo/oracle-main 39；tencent 12；colab 8。
- CDP `config/read`：local 两个 provider（`magpie`、`eshetang`）；colab/tencent 只有 `eshetang`。
- CDP `fs/getMetadata`：`/root/逆向` 不存在；`/home/ubuntu/codex` 存在；远程均无 `~/Documents`。
- CDP fiber props：远程项目行携带 `{projectKind:"remote", hostId, projectId, label, path}`。

### A.3 仓库文件

| 文件 | 用途 |
| --- | --- |
| `packages/renderer-extension/src/renderer-host-clients.ts:23-164` | 每 Host 客户端 |
| `packages/desktop-control/src/renderer-host-routing.ts:202-213` | `knownHostIds` / `forHost` |
| `packages/desktop-control/src/renderer-host-discovery.ts:78-128` | Host 发现 |
| `packages/renderer-extension/src/renderer-binding-probe.ts:784-787` | Composer 当前 Host |
| `packages/renderer-extension/src/versioned-renderer-adapter.ts:1071-1130` | draft 模型写入 |
| `packages/desktop-control/src/renderer-scoped-draft-model.ts:18-118` | draft 绑定查找 |
| `packages/renderer-extension/src/renderer-native-composer-controller.ts:52-100` | Composer ProseMirror 访问 |
| `packages/renderer-extension/src/renderer-project-groups.ts:670-690` | 原生新对话按钮点击 |
| `packages/renderer-extension/src/renderer-project-groups-rpc.ts:30-48` | 组 RPC 客户端 |
| `packages/shared-contracts/src/project-groups.ts:38-82` | 组/成员 schema 与唯一性 |
| `packages/host-runtime/src/app-server-host.ts:3333-3360` | 组 RPC 实现 |
| `packages/host-runtime/src/desktop-project-catalog.ts:97-127` | 项目目录只读投影 |
| `packages/mapping-store/src/project-groups.ts:120-132` | revision 全量替换 |

---

## 附录 B：本阶段未验证 / B 阶段第一个 spike

1. **Renderer 服务对象取用**：如何在扩展里稳定拿到 `workspaceFiles.createDirectory` 与 `projects.createRemote`。候选：React fiber 上的 host-services context、创建弹窗 props、模块注册表。拿不到就走原生弹窗路径。
2. **`projects.createRemote` 的广播行为**：写 `remote-projects` 后，`global-state-updated` 是否足以让侧栏立刻出现；现场只能确认文件结构，不能确认广播时序。
3. **`project/create` 是否要求 roots 已存在**：Desktop 总是先 `mkdir` 再调，协议未明确；按“先建目录”实现即可，不需要测试。
4. **远程 `project/create` 后 Desktop 是否会在某次刷新中把它并入侧栏**：当前证据是不会；B 阶段可在测试 Host 上验证。
5. **草稿 v2 的 `prompt` 结构**：纯文本是字符串，富文本是 ProseMirror doc；v1 只处理字符串。
6. **推理强度写入 API**：`createScopedDraftModelWriter.apply` 目前不改 `reasoningEffort`，需要扩展或改用 `route.policy.select`。
