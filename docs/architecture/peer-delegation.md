# 跨机器委派（Peer over SSH）

本文描述当前实现：`codexhost` 通过本机 `~/.ssh/config` 别名，把委派 CLI 的一次控制请求交给另一台机器上的 Host Runtime。它不经过 Codex Desktop 中转，因此远端机器只需要运行 `codexhost` 和 Host Runtime，不需要 Desktop 连接。

## 目标与边界

- 让 `delegate start`、`harness list|inspect`、`thread read|send|cancel|wait` 可以用 `--host <peer 名或 Host ID>` 指向另一台机器。
- Thread 链接 `thread://<id>?hostId=<x>` 中的 Host ID 可以自动解析到对应 peer。
- 复用每台机器已有的本机控制 API，不新增远程 RPC 协议，也不开放任意 URL 转发。
- 第一版不跨机注册 `thread watch` / `thread watches`，跨机 `delegate start` 不建立父子关系。
- SSH 是唯一的授权边界：能通过 SSH 以该用户身份执行命令，就能使用该用户的 Host Runtime。

## 组件

```
codexhost CLI (机器 A)
  │  --host mac / thread://...?hostId=...
  ▼
peer-config (peers.json) ──► 找到 ssh 别名与远端命令
  │
  ▼
ssh -o BatchMode=yes ... mac codexhost peer-exec
  │  stdin: {"route":"/v1/thread/read","body":{...}}
  ▼
peer-exec (机器 B，隐藏子命令)
  │  读取 ~/.codexhost/runtime/control-<pid>.json
  ▼
本机 Host Runtime 控制 API (127.0.0.1 随机端口, Bearer token)
```

- `packages/host-runtime/src/runtime-control-file.ts`：发布和发现本机控制入口。
- `packages/host-runtime/src/peer-exec.ts`：远端代理入口与路由白名单。
- `packages/host-runtime/src/peer-config.ts`：`peers.json` 解析、校验和 Host ID 解析。
- `packages/host-runtime/src/peer-transport.ts`：SSH 启动、stdin/stdout 传输、超时与输出上限。
- `packages/host-runtime/src/peer-cli.ts`：`codexhost peer list|add|remove|test`。

## 本机控制入口

Host Runtime 启动控制服务后，在固定用户目录下写入：

```
~/.codexhost/runtime/control-<pid>.json
```

```json
{
  "formatVersion": 1,
  "endpoint": "http://127.0.0.1:54321",
  "token": "<64 hex characters>",
  "pid": 12345,
  "startedAt": "2026-11-11T07:00:00.000Z"
}
```

固定用户目录是 `~/.codexhost`，可以用 `CODEXHOST_USER_DIR` 覆盖（测试隔离用）。它**不跟随** `CODEXHOST_DATA_DIR`：Desktop 通过 SSH 启动的远端 Runtime 通常带 `CODEXHOST_DATA_DIR=~/.codexhost/remote/data`，而普通 SSH 会话没有这个变量；如果控制文件放在数据目录，`ssh <别名> codexhost peer-exec` 将永远找不到它。控制目录还可以用专用变量 `CODEXHOST_RUNTIME_CONTROL_DIR` 单独覆盖。

测试保护：在 Vitest 进程中，如果没有设置 `CODEXHOST_USER_DIR` 或 `CODEXHOST_RUNTIME_CONTROL_DIR`，发布和读取控制文件都会跳过真实 home，避免测试污染用户目录。

实现约束：

- 目录权限 `0700`，文件权限 `0600`。文件通过同目录临时文件 + `rename` 原子发布。
- 每个进程一个文件，按 PID 命名，而不是共享一个 `control.json`。共享指针在一个 Runtime 崩溃或重启时会留下悬空记录，也可能被后启动的进程覆盖；按 PID 分开后，读者只需选择“最新且 PID 仍存活”的记录，多个 Runtime 可以同时存在且互不覆盖。
- 读取方用 `process.kill(pid, 0)` 校验 PID；`ESRCH` 表示已退出，权限类错误视为仍存活。失效记录不会被读者删除，避免读者产生写副作用。
- 正常关闭时删除自己的记录；如果同一路径已被另一个进程替换（PID 复用），只比较 token，不删除别人的文件。
- 控制入口发布失败只写一条诊断日志，不阻止 Host Runtime 启动；此时本机委派仍可用，只是 peer 调用不可用。
- 读取时要求 `endpoint` 是 loopback HTTP 地址，防止被篡改的文件把 token 发给外部主机。

多个 Runtime 同时存活时，`peer-exec` 选择 `startedAt` 最新的记录；时间相同则选择 PID 较大的。已知限制：如果最新启动的 Runtime 没有 Harness 目录（例如仅负责远程监听），`harness list` 可能失败；本机委派不受影响。

## peer-exec

`codexhost peer-exec` 是隐藏子命令，只用于远端调用，不提供给普通用户。

- 从 stdin 读取一个 JSON 对象：`{"route":"/v1/thread/read","body":{...}}`。
- `route` 必须属于控制 API 白名单：
  `/v1/harness/list`、`/v1/harness/inspect`、`/v1/delegate/start`、
  `/v1/thread/send`、`/v1/thread/cancel`、`/v1/thread/read`、
  `/v1/thread/wait`、`/v1/thread/list`。`/v1/thread/watch` 和 `/v1/thread/watches` 第一版不跨机，不在白名单内。
- 不接受 URL、endpoint、token 或路由参数；所有连接信息只从本机控制文件读取。
- 请求体上限 2 MiB，与 Host Runtime 控制服务一致。
- 正常响应和 Runtime 错误响应都原样写到 stdout；`{"error":{"code","message","details?"}}` 保持原格式，退出码为 1。
- 本机没有存活的控制文件、控制端点不可达或响应不可解析时，也在 stdout 写出同格式错误并退出 1。退出码只是给普通 OpenSSH 客户端参考；调用方以 stdout 为准。

## peers.json

```json
{
  "formatVersion": 1,
  "peers": {
    "oracle-main": {
      "ssh": "oracle-main",
      "hostIds": ["remote-ssh-discovered:oracle-main"],
      "command": "/opt/codexhost/bin/codexhost"
    }
  },
  "self": {
    "hostIds": ["remote-ssh-discovered:mac"]
  }
}
```

- 文件位于 `~/.codexhost/peers.json`，权限 `0600`。`CODEXHOST_USER_DIR` 可以移动这个固定用户目录；`CODEXHOST_DATA_DIR` 不影响它。
- `ssh` 必须是本机 `~/.ssh/config` 里的别名，且能非交互认证（连接参数强制 `BatchMode=yes`）。SSH ControlPath 也位于 `~/.codexhost/ssh/%C`，与 peers.json 使用同一个固定用户目录，因此 Desktop 托管远端和普通 SSH 会话看到的是同一份配置。
- `hostIds` 是 Desktop 视角的 Host ID。解析优先级：peer 名 → `self.hostIds` → peer 的 `hostIds` → 特殊值 `local`。
- `self.hostIds` 是**本机自己**在 Desktop 视角下的 ID。命中时按本机处理，不会走 SSH。用 `codexhost peer self add|remove <hostId>` 维护，`codexhost peer self` 查看。
- 同一个 Host ID 同时出现在 `self` 和某个 peer 中会被视为配置错误，避免同一链接有两个目标。
- `thread://<id>?hostId=<x>` 与 `--host <x>` 使用同一套解析。若某个 peer 显式配置了 `hostIds: ["local"]`，该 peer 会接管 `local` 链接；否则 `local` 保持本机行为。
- 第一个 Host ID 用作输出链接里的 `hostId`；没有配置 Host ID 时退回 peer 名。
- `command` 可选。远端非交互 shell 的 `PATH` 通常不包含 `codexhost`，此时用绝对路径覆盖；该值必须是单个路径或命令词，不允许空白或 shell 元字符。

`codexhost peer add` 会拒绝重复的 peer 名、保留名（`local`、`__proto__` 等）以及被其他 peer 或 `self` 占用的 Host ID。

## SSH 传输

每次 peer 请求执行：

```
ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o ControlMaster=auto \
  -o ControlPath=~/.codexhost/ssh/%C \
  -o ControlPersist=60 \
  <ssh-alias> \
  <command 或 codexhost> peer-exec
```

- 使用 `child_process.spawn`，所有参数以数组传递，不拼本地 shell 字符串。
- 请求体通过 stdin 写入，stdout 只承载响应 JSON。
- `ControlMaster` 复用连接，降低连续 `send`/`read`/`wait` 的握手开销。
- 超时：`harness`/`read`/`send`/`cancel` 默认 30 秒；`delegate start` 60 秒；`thread wait` 为本次切片 `timeoutMs` 加 30 秒余量。超时后发送 `SIGKILL` 并返回 `RUNTIME_UNREACHABLE`。
- stdout 上限 8 MiB，超过返回 `RESPONSE_TOO_LARGE`；stderr 只保留前 64 KiB，错误详情里最多带 2 KiB 摘录。
- 响应判定以 stdout 为准。stdout 是合法错误信封 `{"error":{"code","message","details?"}}` 时一律按错误返回，与 SSH 退出码无关：Tailscale SSH 等实现不把远端退出码传回本地（远端失败时本地仍是 0），只看退出码会把错误体当成成功响应。退出码非 0 且 stdout 不是错误信封时，返回 `RUNTIME_UNREACHABLE`（`reason: "peer_command_failed"`）。
- SSH 子进程的 environment 会删除 `CODEXHOST_RUNTIME_ENDPOINT` 和 `CODEXHOST_RUNTIME_TOKEN`。即使 `~/.ssh/config` 配置了 `SendEnv CODEXHOST_*`，本机 token 也不会被转发。

## CLI 路由

| 命令 | `--host` | Thread 引用 hostId | 说明 |
| --- | --- | --- | --- |
| `harness list` / `harness inspect` | 是 | 不适用 | peer 上执行枚举/检查 |
| `delegate start` | 是 | 不适用 | 跨机不传 parent，不支持 `--watch true` |
| `thread read` | 是 | 是 | peer 优先；未配置 peer 时保留 Desktop 远程读回退 |
| `thread send` / `thread cancel` | 是 | 是 | 未配置 peer 的非本地 Host 直接报错 |
| `thread wait` | 是 | 是 | 按切片等待；未配置 peer 的非本地 Host 直接报错 |
| `thread watch` / `thread watches` | 明确报错 | 明确报错 | 第一版仅本机 |
| `thread list` | 否 | 否 | 不跨机 |

未指定 `--host`、`--host local`，或 hostId 解析为本机时，保持原有本机 Runtime 行为。

## 跨机父子关系

跨机 `delegate start` 时，远端没有本机父 Thread：

- CLI 在 peer 请求体中加上 `origin: {kind: "peer", hostId, threadId?}`；`hostId` 取本机 `self.hostIds` 的第一个 ID，未配置时用 `local`，`threadId` 是源机器上调用方 Thread（如果已知）。
- 目标 Runtime 的 Registry 看到 `origin` 时不再按父 Thread 匹配会话：优先交给带 Harness catalog 的注册，其次交给唯一的注册；0 个、1 个或多个活跃 Thread 都走同一条路径。
- Coordinator 看到 `origin` 时完全不调用父推断，使用 `peer-origin:<encoded-hostId>[:<encoded-threadId>]` 作为 delegation 记录的 `parentHostThreadId`。这个值是持久化的来源元数据，不会解析成真实 Thread；子 Thread 实际是顶层对话，返回结果不含 `parentThreadId`。
- 本机 CLI 的正常路径不发送 `origin`，原有 `CODEXHOST_THREAD_ID` / 唯一活跃 Thread 推断保持不变。
- 显式 `--parent-thread` 与 peer 目标同时出现会被拒绝，避免产生一个远端不存在的父引用。
- `--watch true` 会被拒绝，并提示改用在 start 之后执行 `thread wait <thread> --host <peer>`。
- 响应中的 `deepLink` 改写为 `thread://<id>?hostId=<encoded>`；`next.read` / `next.wait` 自动追加 `--host <peer>`。
- `thread send` / `cancel` 的完整 JSON 增加 `hostId` 字段，compact 输出的链接使用该 Host ID，保证后续命令能路由回同一 peer。

任务正文不添加额外来源说明。

## 安全边界

- **SSH 即授权边界**：能通过该 SSH 别名以目标用户身份执行命令的人，就能调用该用户的 Host Runtime。peer 配置本身不做额外身份认证。
- **token 只在本机**：token 只存在于 `0600` 的控制文件、Host Runtime 内存和本机回环 HTTP 请求头中。它不进入 SSH 参数、stdin 请求体、stdout 或 `peers.json`。
- **不转发任意目标**：CLI 不能指定 URL 或 endpoint；`peer-exec` 只能访问本机控制文件里的 loopback 地址，且路由受白名单限制。
- **输入校验**：SSH 别名不能以 `-` 开头，避免被当作 ssh 选项；远端 `command` 不允许空白和 shell 元字符；peer 名只允许安全字符，防止生成 `next` 命令时注入。
- **SSH 命令拼接**：OpenSSH 会把远端命令参数用空格拼接后交给远端 shell。由于别名和命令已经过字符白名单校验，且请求体只走 stdin，正常配置下不存在本地 shell 注入面。仍应把 `peers.json` 视为用户信任的本地配置。

## 已知限制

- 不支持跨机 `thread watch` / `thread watches`；需要等待结果时用 `thread wait --host`。
- 跨机子 Thread 不会出现在本机 Desktop 的父子树中；它属于远端 Runtime。
- 只支持通过 SSH 主动连接，不支持反向连接、主机密钥自动接受或密码/交互式认证。
- 每次调用启动一个 ssh 进程（连接由 ControlMaster 复用），没有常驻隧道或流式进度推送。
- `--cwd` 原样传给远端；相对路径按本机 cwd 解析，跨机时应传远端存在的绝对路径。
- 多个 Runtime 同时存活时只取最新存活者；不保证它一定是 Desktop 正在使用的那个。
- 响应大小上限 8 MiB；超出时返回 `RESPONSE_TOO_LARGE`，与现有远程读上限一致。
- 未配置 peer 的非本地 `thread send` / `cancel` / `wait` 不会回退到 Desktop；只有 `thread read` 保留 Desktop 回退。

## 验证

单元测试覆盖：

- 控制文件的原子写入、权限、清理、并发 PID、失效 PID、非法 endpoint 和同路径替换。
- `peer-exec` 的路由白名单、stdin 解析、原样透传、结构化错误、缺失/不可达 Runtime。
- `peers.json` 的解析、校验、Host ID 唯一性、peer 名/Host ID/`self`/`local` 解析，以及 `peer self add|remove|list`。
- SSH 传输的参数数组、stdin、超时、错误信封优先于退出码、非零退出、超大输出、token 不出现在 SSH environment。
- CLI 的 `--host` 路由、self Host ID 本地路由、Thread 引用自动路由、跨机 start 限制、Host 限定链接和 Desktop read 回退。
- 跨机 start 在目标机 0 个、1 个、多个活跃 Thread 下都成功创建顶层子 Thread，且 delegation 的 `parentHostThreadId` 是来源 sentinel，不是任何活跃 Thread；本地 start 的父推断保持不变。

测试通过注入的 spawn 模拟 SSH，不会建立真实连接。真实跨机连通性、主机密钥、远端 `PATH` 和远端 Host Runtime 状态需要在部署环境中另行验证。
