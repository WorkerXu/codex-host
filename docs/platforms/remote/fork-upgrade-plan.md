# v0.22.0 fork 两机升级方案

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
