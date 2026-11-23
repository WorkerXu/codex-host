# fork 两机升级方案

## 从 v0.22.0 fork 升级到 v0.25.1

在维护窗口为 Mac 和 oracle-main 同时准备同一提交的产物。首次启动新版之前，各机冷备份实际 Host 数据根（通常为 `~/.codexhost`）、原生 Codex 和各 Harness 的会话／配置目录、fork 的 `~/.config/codexhost` 凭据目录，以及两处托管委派 Skill。备份与旧包单独保存，保持原有权限。以数据副本验收 Thread 历史、工作文件夹、peer、钉钉、Skills 和 MCP 后再安排切换。

- 已使用共享 Host 的机器直接读取现有 Mapping Store、peer、工作文件夹和 fork 配置。较早的 SSH 数据根迁移仍用[专用工具](../../project/fork-data-migration.md)。
- 检测到旧 Desktop 插件且新插件目录尚未创建时，Host 将插件本体、启用清单、设置和数据复制到 `host-extensions/` 与 `host-extension-data/`。旧目录保留。Web 与 Desktop 使用新目录。
- Harness 收藏和默认 Model 的引用可在目录就绪后规范化。首次改写已有偏好前，Host 将原文件保存到 `harness-preferences-v1.json.before-model-ref-migration-v1`。升级托管委派 Skill 时只替换可识别的副本。
- 回滚前，保存新版期间产生的 Thread 和配置。恢复两机配套的旧包和切换前备份。旧插件从原目录加载。若只恢复模型偏好，使用相应的冷备份或上述原文件副本。使用旧包启动前恢复对应版本的两处托管 Skill。

macOS 安装包与 npm 平台包包含 Tauri 原生壳和托盘，原生壳的运行资源需随 Launcher 一起打包。Linux 平台包用于共享 Host 和 Web。Android 伴侣应用有独立构建流程。macOS 和 Windows 常规启动通过选择页进入 CodexHost 窗口、官方 Codex Desktop 或系统浏览器。

## v0.17.4 到 v0.22.0 的数据根迁移

Mac Desktop 和 oracle-main 使用同一提交的产物。在数据副本完成 T1 的迁移预演，并完成两个平台的
验收后，进入同一次切换窗口。

| 机器 | 当前安装 | 升级产物 |
| --- | --- | --- |
| oracle-main | 全局 `@codexhost/cli@0.17.4`，以 `install-peer.sh` 替换 Host bundle 并修改 npm wrapper | fork 的 Linux npm 平台包和配套 CLI 包，包括 Host、Launcher、插件、Web 资源和 peer 入口 |
| Mac | fork 的 arm64 DMG | 同提交的 `Build macOS DMG` 工作流产物及 `SHA256SUMS` |

1. 在发布构建环境从同一提交制作 Linux 平台包、配套 npm CLI 包和 Mac DMG，记录提交及校验值。
   用互相匹配的 fork npm 产物组装安装副本，检查 `codexhost` 命令实际解析到这套 Linux 包。
   保留 0.17.4 已补丁的 Linux 完整安装与现有 Mac 应用，供回滚使用。
2. 在两机保存受影响的数据备份和各自的 `peers.json`。将旧 SSH 外部 Thread 按 T1 的结论迁移到
   共享 Host 支持的目录，验证会话 ID、历史、续聊和新数据写入位置。
3. 在维护窗口安装两机产物并完成受控切换。Linux 使用包含 peer 入口的 CLI 和整套匹配资源；
   Mac 校验 DMG 后替换应用，在该机的启动环境配置 `CODEXHOST_WEB_SERVICE=0`。
   使用现有 `mac`、`oracle-main` SSH 别名和 `peers.json`。检查两台机器上的 CLI 与 Runtime
   版本、原生 Codex、共享 Host、SSH peer 及跨机器 Thread 读写和 watch。
4. 按 Web 上线阶段在 oracle-main 单独启用 `codexhost web --background`，配置已约定的 nginx
   入口和用户服务，确认 Web 仅列出 oracle-main Thread。人工从手机验证登录、长连接和通知。
5. 发现数据或运行问题时暂停切换，保存新版期间产生的会话数据，再恢复两台机器的上一个配套版本、
   对应数据备份和旧版启动入口。核对版本与 Thread，复验双向 peer。

DMG 工作流只产生下载 artifact。fork Linux 包通过受控产物交付，升级时使用明确指定的文件和版本。
