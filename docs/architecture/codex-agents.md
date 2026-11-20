# Codex 智能体

Codex Desktop 设置中的「智能体」管理 Mac 本机 Host 的 `CODEX_HOME/agents/*.toml`。未设置 `CODEX_HOME` 时使用 `~/.codex`。名称、描述和开发者指令为必填。模型和推理强度可选，留空时沿用父会话配置。表单通过官方 `model/list` 获取模型和支持的推理强度。无法读取目录时，仍可手动输入模型和强度。

每张卡片可打开编辑抽屉。卡片菜单支持编辑、复制和删除。新建和复制生成随机 TOML 文件名，编辑保留原文件名。保存保留未知 TOML 键，重新序列化时会丢弃注释和键顺序。损坏的单个文件显示在已跳过的文件列表，其他智能体仍可使用。

## Host 接入

`codexhost/codex-agents/list|read|save|delete|catalog` 由 Mac 本机 Desktop Host 提供。`save` 和 `delete` 校验文件名及 revision，拒绝路径穿越、符号链接和过期编辑。新文件以 0600 权限原子写入，编辑保留已有权限。共享 Host 使用同一个本机 Codex 配置目录处理各个 Desktop 连接。

## 钉钉派发设置

编辑抽屉保存智能体的启用开关、回复位置、分区和工作项目。项目选择器把原生分区的项目列表与本机 Desktop 项目目录匹配，只显示该分区中的本机项目。只有一个时自动选中。卡片显示配置缺项和本次 Host 运行期间最近的派发状态。

`codexhost/dingtalk-dispatch/get|set|status` 保存或读取这些设置和状态。设置沿用 `~/.codexhost/dingtalk-dispatch.json`，以智能体文件名为键。读取时裁剪已删除智能体的设置。旧版配置中的启用状态和回复位置保留，已停用的事件类型和阈值字段会被清理。

手动派发、项目归属和进度卡的行为见[钉钉工作台](dingtalk.md#智能体手动派发)。
