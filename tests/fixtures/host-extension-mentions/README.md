# Web 提及示例

只在隔离 Host 中安装此目录并启用，清单同时提供旧的 `demo` 平铺来源、`two-step` 两步来源和 `multi` 多选来源。

- 平铺来源直接搜索 Alpha、Beta、中文条目。输入 `@slow` 时通过开始 + 轮询等待 15 秒返回，用于检查 Host 无总截止。
- 选择「两步选择」或「多选提及」打开面板，第一步故意等待 15 秒；每次后端调用立即返回 pending，后端进程不会因 10 秒 invoke 规则被杀。
- 第二步可用方向键／Enter 选一个；多选来源可选多个后点击「插入所选提及」。第二步 Esc 返回第一步，第一步 Esc 关闭并返回输入框。
- 搜索框修改会取消旧工作；编辑原草稿、关闭面板、切换会话或停用扩展也取消。状态用 `fixture/status` 查看（PID、活动工作数、取消次数），不含凭据。
- 提交后 Host 将记号替换为 `[Demo mention] ...`；`host-extension-data/mention-sample/mentions.log` 记录实际展开输入和输出，`cancel.log` 记录取消。

所有数据均为合成示例；不调用网络、模型或业务 CLI。
