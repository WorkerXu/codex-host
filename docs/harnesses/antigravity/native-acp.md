# Antigravity 原生 ACP 接入

反重力适配器通过 `agy acp` 长连接接入，最低 CLI 版本为 1.5.8。
不再使用 Print Mode、stream-json 协议或私有问题 Hook；会话工作目录直接传给原生进程。
旧会话仍以原生 conversation ID 恢复，模型、思考选项与权限模式由原生 ACP 确认。

原生 `session/request_permission` 与表单 `elicitation/create` 分别映射到现有审批和问题卡片。
权限模式及危险跳过权限的进程重开边界见
[权限与交互](antigravity-tool-approval.md)。取消或关闭会话时先关闭待答交互，再结束 Turn。

历史恢复使用只读的原生 SQLite/Transcript 数据，避免通过 ACP 重放触发模型行为。
fork、跨目录 fork 与末轮回退由适配器操作原生会话数据；失败返回明确错误。
模型目录、原生子任务、使用量和请求计时仍由适配器解释，Host 使用公共契约呈现。
未确认的思考 Token 不计入可见输出 TPS；计费 Token 保持原生数值。

原生会话空闲时的后台文字归属于最近已完成的一轮，并与读取历史中的重放文字去重。
后继 Turn 开始后，适配器停止向旧轮追加新的后台文字。Host 只保留最新完成轮和仍有
未结束后台 Item 的投影，避免在长会话中持续积累。

本次回移仅包含适配器及必需的公共类型、计时解析、后台输出投影；保持现有 Desktop、
SSH peer、钉钉与项目归属实现。Web/手机端、Relay、Agent 会话切换和 MemHub 不在范围内。

验证：反重力包的 ACP 传输、交互、历史、fork/rollback、使用量和子任务测试，
以及 Host 后台输出、委派与计时测试。真实 CLI 冒烟另记录于部署报告。
