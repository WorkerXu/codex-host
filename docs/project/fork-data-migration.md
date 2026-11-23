# fork v0.17.4 → v0.22.0 数据迁移

适用于从 fork `4a30bc41` 的数据布局切换到上游 `v0.22.0` 的 oracle-main 和 Mac。甲骨文 Web 使用 oracle-main 的 Thread，Mac 本地 Thread 继续由 Mac Desktop 打开。每台机器沿用自己的原生 Codex 与 Harness 数据目录、用户和项目绝对路径。

## 数据对照

表中「SSH」是 oracle-main 的 `~/.codexhost/remote/data`，「共享」是两台机器各自的 `~/.codexhost`。Mac 本机已经用共享根位置存储数据。

| 数据 | fork 位置与格式 | 新底座位置与格式 | 处理方式 |
| --- | --- | --- | --- |
| 原生 Codex 会话、归档、状态数据库及项目归属 | 两机各自的 `CODEX_HOME`（默认 `~/.codex`），包括会话 JSONL、原生 SQLite、全局状态 | 同路径，原生 app-server 负责列表、恢复、项目和官方分区 | 直接复用 |
| 外部 Thread 和 Turn 映射 | SSH / Mac 本机的 `mapping-store/threads`、`backups`，每 Thread 一份 V1 JSON | 共享 `mapping-store`，同格式、同 Thread/Turn ID 和原生引用 | 需要转换（oracle-main 移交目录，记录原样）。Mac 直接复用 |
| Thread 元数据 | `mapping-store/thread-metadata` 的 V1 JSON | 随 Mapping Store，允许上游附加字段 | 需要转换（oracle-main 随目录移交）。Mac 直接复用 |
| 委派关系和项目路由 | `mapping-store/delegations` 的 V1 JSON，部分带 `desktopProject` | 随 Mapping Store，兼容字段保留。上游 Web 从委派记录识别父子关系 | 需要转换（oracle-main 随目录移交）。Mac 直接复用 |
| 外部置顶和分区位置 | `mapping-store/sections/placements.json`，V1 JSON，保存目标分区和排序锚点 | 随 Mapping Store。Web 置顶使用 Host 的原生分区接口 | 需要转换（oracle-main 随目录移交）。Mac 直接复用 |
| 原生置顶和分区定义 | 原生 Codex 状态和 Desktop 配置 | 保留同一原生 home、Desktop 配置及远程主机身份 | 直接复用 |
| Claude Code 历史 | `${CLAUDE_CONFIG_DIR:-~/.claude}/projects`，主会话与 Subagent JSONL | 同目录，现有 Adapter 读取 | 直接复用 |
| Grok 历史 | `${GROK_HOME:-~/.grok}/sessions`，原生 JSONL 及会话元数据 | 同目录，现有 Adapter 读取 | 直接复用 |
| CodeBuddy 历史 | `${CODEBUDDY_CONFIG_DIR:-~/.codebuddy}/projects`，原生 JSONL | 同目录，现有 Adapter 校验原生 ID、工作目录与派生来源 | 直接复用 |
| Antigravity 历史 | `~/.gemini/antigravity-cli/`，原生 SQLite | 同目录，上游 ACP Adapter 读取 | 直接复用 |
| 旧 Antigravity Hook 副本 | SSH 的 `antigravity-history/`，投影 JSON 和 Hook 工作目录 | ACP 读取原生数据库，旧副本保留在 SSH 目录 | 不需要 |
| Harness 偏好和显示设置 | `harness-preferences-v1.json`、`harness-display-settings-v1.json` | 共享根同名 JSON，由共享 Host 与 Web 读取 | 需要转换（若 SSH 有文件则移交）。Mac 直接复用 |
| 每 Thread 工作目录 | SSH / Mac 的 `thread-folders/<Thread ID SHA-256>.json`，含 `folders`、`appliedFolders` 和变更记录 | 共享 `thread-folders/`，T6 沿用原名和格式 | 需要转换（oracle-main 移交目录）。Mac 直接复用 |
| 自定义模型价格 | SSH / Mac 的 `pricing.json`，模型覆盖对象 | oracle-main 的共享根与 SSH 根都具有定价读者，Mac 继续原地读取 | 需要转换（oracle-main 向共享根复制，SSH 留用原文件）。Mac 直接复用 |
| 用量测量 | `usage-measurements-v1/`，原生 Session 对应的 JSON/旧 JSONL 快照 | 共享根同名目录，上游还支持新的 Thread 级快照 | 需要转换（若 SSH 有文件则移交）。Mac 直接复用 |
| 用量统计、价格缓存、Harness 可用性缓存 | `usage-statistics/`、`pricing/`、用户级 `cache/harness-availability.json` | 统计和价格缓存按 Host 重建，T0 沿用用户级可用性缓存 | 不需要 |
| SSH peers | 用户级 `~/.codexhost/peers.json` | T0 沿用文件及 `mac` / `oracle-main` 别名 | 直接复用 |
| 钉钉设置与已看状态 | `~/.config/codexhost/dingtalk-settings.json`、`~/.codexhost/dingtalk-dispatch.json`、`dingtalk-viewed.json`，JSON | T2 沿用各自用户目录；派发设置和 Agent 工作项目归 Mac | 直接复用 |
| 钉钉派发状态和登录 | Mac 旧 `dingtalk-dispatch-state.json`；消息及状态由当前 fork 保留在内存；登录由 Mac 的 dws 管理 | 旧状态文件原地保留，进程状态重建，dws 沿用原登录 | 不需要 |
| Jarvis 设置与项目偏好 | Mac `~/.config/codexhost/jarvis-settings.json`；Desktop localStorage 的 `codexhost.jarvis.projects.v1.<hostId>` | T3 沿用文件、Desktop profile 与 Host 标识 | 直接复用 |
| 模型服务设置和凭据 | Mac `~/.config/codexhost/model-service.json`；`openai-api-key`、`gemini-api-key` 为单行文本（0600） | T3 沿用原位置与权限，Mac 本机读取 | 直接复用 |
| Skills Hub | `~/.codexhost/skills-hub/` 的源和安装记录 JSON，技能文件留在 Harness 或项目目录 | T4 沿用同目录与原生技能位置 | 直接复用 |
| MCPHub / MemHub | Mac `~/.config/codexhost/hub-remote.json`（可选）、`mcphub-admin-key`；服务端数据与设置归 India | T4 沿用 Mac 配置及 SSH 转发，服务数据留在原服务器 | 直接复用 |
| Codex 智能体 | Mac 的 `CODEX_HOME/agents/*.toml` 与原生配置 | T2 沿用原生 home 和文件身份；钉钉派发继续引用原 Agent | 直接复用 |
| 代码仓库 | Mac `~/.config/codexhost/gitlab-token`（0600），已克隆 Git 仓库留在各自项目目录 | T6 沿用 Mac 凭据和项目路径 | 直接复用 |
| 旧项目镜像、项目分组与分区显示偏好 | Mac 上旧版镜像记录、`project-groups/groups.json` 及 Desktop profile 中的旧分区显示偏好 | 数据留在原位供旧版使用；当前版本使用 Desktop 原生分区和项目 | 不需要 |
| Web 本地状态 | Mac `~/.codexhost/web/`，包含 workspace JSON、附件、服务设置及认证/推送材料。oracle-main 盘点未见 Web 根 | 默认 `<共享根>/web`，Web 数据与 Mapping Store 分开；oracle-main 初始化自己的入口 | 不需要 |
| Web 旧独立置顶及会话 | 旧 `web/workspaces.json` 的独立置顶和 `web-codex/` 隔离来源 | 共享模式从 Host 取置顶和历史，旧文件原地保留 | 不需要 |
| 旧交接记录、更新和运行状态 | SSH `thread-handoffs/`、`remote-update.json`、更新暂存、日志、锁；用户目录的 `runtime/` 等 | 旧数据留在原目录，服务建立自己的运行记录。Pi 的内置扩展由 Adapter 生成 | 不需要 |

工具只处理表中列入转换的目录和设置。它先备份这些文件的完整副本，包括原 Mapping Store 的备份、隔离区和锁，然后把预备副本原子放入共享根。旧 Mapping Store 和其他已移交的数据原件收在备份的 `retired/`，避免 SSH 和共享 Host 各持一份同 ID 的映射。共享 Mapping Store 启动时建立自己的锁。自定义价格的两份文件切换后分别归各自 Host。

## 部署顺序

以下是部署阶段的操作手册。源码验收使用副本。两台机器从同一合入提交构建和切换，保留旧安装包、SSH 入口和更新前的服务配置。

1. **停服务。** 确认两台机器没有运行中的 Turn。退出 Mac Desktop，断开到 oracle-main 的 Desktop SSH 会话，停两机的 codexhost 共享 Host 和 oracle-main 的 SSH listener。若 Web 已试运行，先停 Web。暂停会自动拉起这些进程的单位，检查进程已退出再操作数据。用独立的 SSH 或控制台执行，避免迁移指挥会话随 listener 一起结束。
2. **备份。** 在各自机器上以私有权限保存冷备份。范围包括原生 Codex 会话、归档、状态数据库及其 SQLite 边车文件、相关原生 Harness 历史、codexhost 数据与设置、Mac 的 Desktop profile、oracle-main 的 wrapper/manifest 和启动环境。凭据保留在各自机器和原权限下，运行描述和令牌目录跳过。脚本备份只覆盖对应表里迁移的文件；冷备份供整机回滚，尤其是 Mac 原地复用的资料。
3. **迁移 oracle-main。** 在 SSH listener、共享 Host 和 Web 全部停机时，使用 v0.22.0 合入版本中的脚本。备份必须位于两个数据根之外、与两个数据根同一文件系统，且路径尚未创建。重复运行时用原备份路径。

   ```sh
   umask 077
   t1_backup_parent="$HOME/.codexhost-migration"
   mkdir -p -m 700 "$t1_backup_parent"
   t1_backup="$t1_backup_parent/t1-$(date -u +%Y%m%dT%H%M%SZ)"
   t1_script="tools/migrate-fork-data/run.mjs"

   node "$t1_script" dry-run --source "$HOME/.codexhost/remote/data" \
     --shared "$HOME/.codexhost" --backup "$t1_backup"
   node "$t1_script" apply --source "$HOME/.codexhost/remote/data" \
     --shared "$HOME/.codexhost" --backup "$t1_backup"
   ```

   目标已经有同名数据时，先保留两侧冷备份，停在原地核对，确定哪一份是有效数据后才继续。apply 中断时维持停机，用同一备份路径继续 apply 或执行 rollback。遇到残留 `.fork-data-migration.lock`，确认迁移进程已经退出后用 `rmdir` 移除空锁目录。

4. **迁移 Mac。** 安装后的本机共享 Host 继续使用当前 macOS 用户的 `~/.codexhost`、相同的 `CODEX_HOME` 及 Desktop profile。工具给相同的 `--source` 和 `--shared` 会报告原地复用。保留 Mac 上原来的 SSH 主机 ID、原生项目设置和 Agent 文件名。
5. **启动。** 按 T0 的发行和远程安装流程切到新构建。oracle-main 的 `codexhost remote install --shared-data "$HOME/.codexhost"` 明确选定共享根。SSH 安装仍为独立的 listener 记录设置 `CODEXHOST_DATA_DIR=~/.codexhost/remote/data`，共享外部桥使用 `CODEXHOST_SHARED_DATA_DIR=~/.codexhost`。oracle-main 的 Web 启动单位使用 `CODEXHOST_DATA_DIR=$HOME/.codexhost`，并与 listener 使用同一原生 `CODEX_HOME` 和 Harness 环境。Web 的实际启动参数及入口来自部署阶段。先验证 SSH/共享 Host 所选根和原生 Codex 路径，再恢复 Desktop 连接并启动 Web。
6. **核对。** 在 Mac Desktop 检查本地与 oracle-main SSH 列表、已归档列表、项目、分区和置顶；在 oracle-main Web 检查其本机的同一批 Thread，逐个 Harness 打开旧历史。用户授权后各选一条空闲会话发送短消息，确认 Thread ID 和原生 Session ID 保持一致，再从另一入口读取新回合。原生 Codex 核对旧会话、项目和官方锁，避免两个入口同时给同一个原生 Thread 发消息。T2/T3/T4/T5/T6 合并后逐项核对设置。下面列出的五条 CodeBuddy 需要在放行前确认恢复方案或验收范围。

### 回滚

1. 按部署步骤重新停两台机器的写入者。先冷备份切换之后的状态，尤其是新写入的原生会话、SQLite/边车文件和 Mac 的本机记录。保留旧版与新版的安装文件。
2. oracle-main 对原来的备份路径执行 `node tools/migrate-fork-data/run.mjs rollback --source "$HOME/.codexhost/remote/data" --shared "$HOME/.codexhost" --backup "$t1_backup"`。它恢复迁移前 SSH 原件，同时把共享 Host 的状态和尚在 SSH 根的新数据收进 `rollback/shared/` 与 `rollback/ssh/`；完整初始快照在 `original/`。再次执行保持结果。再迁移时使用新的备份路径。
3. 恢复两台机器的旧安装和启动环境、oracle-main 的旧 SSH 入口，停用新 Web 的入口和自动启动。对 Mac 原地共享的数据先核对旧版读取能力。如需用冷备份恢复，将切换后的数据单独保留再恢复旧状态，以便确认新会话如何找回。
4. 先启动旧 Host，核对两个 Desktop 的原生入口与历史。在决定如何并回上线后生成的数据前保留全部备份。

## 副本验证记录

在私有 0700 临时目录，用两台机器的数据副本执行。Mac 数据经 SSH 只读提取，模型服务凭据只核对了名称、源码格式和权限。验证用 Node 22 运行 v0.22.0 的 Mapping Store、Host 列表/置顶投影及 Adapter 历史读者，无需启动服务。

| 检查 | oracle-main 副本 | Mac 副本 |
| --- | --- | --- |
| dry-run / apply | Mapping Store、工作目录和用户定价文件进入计划，apply 后再次执行报告空变更 | 同一数据根，两种模式均报告原地复用 |
| Mapping Store | 105 条 ready，零条隔离；列表投影 46 条普通、55 条归档，另有 4 条原生 Subagent；74 条委派（34 条带旧项目字段） | 1 条已归档 CodeBuddy 可列出；19 条委派（7 条带旧项目字段）；零条隔离。1 条无原生 Session 的 Antigravity `creating` 中间态由现有恢复流程清理 |
| 组织数据 | 4 条外部分区位置，0 条外部置顶；工作目录副本字节一致 | 0 条外部分区位置；上游读到 Harness 偏好 revision 1 和 19 条显示设置 |
| 历史 | Claude Code 40 条（含 4 条 Subagent）、Grok 8 条、Antigravity 13 条、CodeBuddy 40 条读出历史回合 | 已归档的 CodeBuddy 查不到原生 JSONL。默认 CodeBuddy 项目目录不存在，已检查 Mac 启动环境中的额外配置路径 |
| 回滚 | 将原始目录恢复到 SSH 位置，保留共享目录状态和两边可用的价格覆盖 | 原地复用没有目录变更 |

oracle-main 的 4 条未归档 CodeBuddy 会话，JSONL 均存在，但原工作目录已不存在。旧 fork 和新底座都要求 Adapter 校验目录身份，副本历史读取返回 `ENOENT`。Mac 那条归档 CodeBuddy 有原工作目录，仍需要找到对应的原生 transcript 才能核对历史。迁移保留这五条映射及原生引用，需要确认从哪里恢复原工作目录和历史，或是否允许它们作为上线验收例外。副本验证覆盖数据读取，Desktop/Web 的真实路由、原生 Codex 历史与发送续聊留待部署验收。
