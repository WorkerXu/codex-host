# 委派线程的提问与回答

委派方可以读取目标 Thread 的待答问题，再通过原请求提交答案。Desktop 和委派 CLI 共用待答状态，避免同一问题被重复提交；回答回执只确认提交，任务结果仍应通过 `thread read` 或 `wait` 判断。

## 使用方式

`thread read` 与 `thread wait` 在 JSON 和 compact 输出中保留 `pendingQuestions`。每项包含不透明的 `interactionId`、`kind`、提问的 `turnId` 和原始 `request`，可能包含 `expiresAt`。空数组表示当前没有问题；旧 Runtime 未返回该字段时，CLI 不补造空数组。`wait` 遇到待答问题立即返回 `timedOut=false`。

将原生回答结果写入 JSON 文件，再执行：

```sh
codexhost thread answer <thread> --interaction <interactionId> --answers-file <file>
```

| kind | 文件内容 | 交付方式 |
| --- | --- | --- |
| `requestUserInput` | 原请求的结果，例如 `{"answers":{"decision":{"answers":["Continue"]}}}` | 沿原生 server request 或现有 Adapter `interaction.respond` 通道提交；选项标签由现有投影器还原为原生值 |
| `requestUserInputAsync` | 单个问题的 `{"answer":"Continue"}` | 使用 Codex 原生异步问题回复格式；活跃时 steer 当前 Turn，空闲时恢复 Thread 后开始一个 Turn |

命令支持现有 SSH peer 的 `--host` 和带 Host 的 Thread 链接。回答文件只在调用机器读取，JSON 通过已有 `peer-exec` 白名单路由 `/v1/thread/answer` 传给目标 Host；不依赖新的远程服务。未知的远程 Host 不回退到本机回答。控制 HTTP 接口仍只监听 loopback 并校验现有 Runtime token。

## 所有权与生命周期

- 同步问题由 `QuestionInteractions` 持有，原生请求 ID、问题解释和答案校验仍属于原通道。Desktop 回复与 CLI 回答在提交前竞争同一个一次性认领；失败后不自动重发。过期、`interaction.closed`、Turn 结束、Thread 关闭和 Runtime 退出都会撤销请求。
- 多选共享卡片保留现有独立 RPC，不同时暴露成单选问题；审批不属于 `pendingQuestions`。
- Codex 异步问题来自带 `delivery=async` 的 `agentMessage.questions`，使用原生 `questionItemId`。Host 在原生输出与最近五轮历史中观察问题和用户回复，不从普通文本猜问题。
- 异步问题允许在提问 Turn 结束后回答。提交前再读近期原生历史，撤销已由 Desktop 回答的问题。所有共享同一 `OfficialRuntimeScope` 的 Host 共用认领状态；结果未知时保留认领，只有原生明确的参数拒绝（`-32600` / `-32602`）才允许显式重试。原生进程换代后清空状态，旧交互 ID 不再有效。
- 原生 Desktop 的直接输入仍走原通道，不能承诺与所有原生客户端之间的全局原子互斥。Host 的防重覆盖其拥有的请求和异步问题提交入口。
- `QUESTION_NOT_PENDING` 表示未知、已认领、已回答、取消、过期或已撤销的交互；调用方应重新读取，不应将回答改成普通 `thread send`。

## watch

运行中的 Thread 出现问题时，一次性 watch 返回 `needsInput` 通知，包含问题的 Turn 与交互 ID。注册时问题已存在则返回 `alreadyNeedsInput` 和问题本身，不再发重复通知。终态优先于问题，因此已结束 Turn 的异步问题仍可通过 read/answer 处理，但 watch 先报告 Thread 的终态。回答后重新注册 watch，等待下一个问题或任务结束。

watch 的已有送达语义不变：通知向空闲的接收方启动新 Turn，忙时等待并重试；watch 状态只存在内存，重启后丢失。详见 [Thread watch](thread-watch.md)。
