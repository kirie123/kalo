# P0-1 Job Runtime + P0-2 Channel 设计文档

日期：2026-08-17
前置：《2026-08-17-personal-agent-roadmap.md》§2（Job Runtime）、§3（Channel）

后台任务分三层：协议层（生命周期/接口）、后端层（具体注册表实现）、工具层（模型可见工具），协议与实现分离。

本阶段把"起一台长跑任务、看它、拿指标、能停"抽成公共层（P0-1），并给 gateway 开一条统一的消息进出通道（P0-2）。

---

## 0. 设计取向

1. **抽共同的，不堆定制**。P0-1 的 before 图像是 experiment-runner SKILL 里那套手搓流程（[experiment-runner.ts](../../kalo-harness/packages/coding-agent/src/extensions/kalo-skills/experiment-runner.ts)）：`Start-Process -WindowStyle Hidden` / `ssh nohup` 启动即返回 → 拿 PID → `sleep 300` 轮询 → `tail` → `nvidia-smi` → 手写 `queue.md`/`status`。骨架进 base，**nvidia-smi、OOM、队列语义一行都不进代码**——它们是用户写的脚本/正则/SKILL 文案。

2. **文件即状态，但状态由工具写，不由模型手写**。这正是 experiment-runner 现在的毛病：让模型自己维护 status 文件。

3. **工具是可插拔的真工具**。`pi.registerTool` 是扩展的公开能力（harness 自带的 skill 扩展就用它注册了 `use_skill`，见 [skill/index.ts](../../kalo-harness/packages/coding-agent/src/extensions/skill/index.ts)）。kalo-skills 不注册工具只是它自身的选择，不是限制。所以 job 管理做成真工具，模型直接调，不用 bash 去 cat 状态文件。

4. **进程独立**。gateway 自身崩溃会自动重启（MAX_RESTARTS=5，指数退避），并在桌面退出/解绑时被 Rust 杀掉。因此 **job 进程绝不能是 gateway 的子进程**——Windows 下 `CREATE_BREAKAWAY_FROM_JOB` 脱离，任务活过 gateway 重启与桌面关闭。状态落盘，gateway 启动后重新核对。

---

## 1. 三层拆分

后台任务拆成三个包，协议与实现分离，这就是"可插拔"的来源：

| 层 | 职责 | 挂载点 |
|---|---|---|
| 协议层 | 生命周期、owner 隔离、快照形状。不含任何执行逻辑 | `ctx.jobs` |
| 后端层 | 一个具体注册表实现：`jobs-local`（进程本地） | 注册到 `ctx.jobs` |
| 工具层 | 面向模型的三个工具 + 完成通知 | 注册到 `ctx.tools` |

我们要的是**平行的第二个后端**：`jobs-gateway`，实现同一份注册表接口，但任务托付给 gateway 那个活得比会话久的进程。工具层完全不动——它只认接口，不认后端。

```
协议层  JobRegistry / JobStart / JobHooks / JobSnapshot
           ├── jobs-local     进程内，会话结束即止（临时命令）
           └── jobs-gateway   守护进程，活过会话/桌面/gateway 重启（训练、回测、抓取）
工具层  job_output / job_list / job_kill  ← 对两个后端一视同仁
```

### 1.1 协议层要点

```
JobStatus = running | stopping | completed | killed | failed
JobStart  = { kind, label, owner?, outputLimitBytes?, run(): JobHooks }
JobHooks  = { cancel(reason?), done: Promise<JobOutcome>, readOutput?() }
JobSnapshot = { id, kind, label, status, detail?, startedAt, finishedAt?, reported, ownerSession? }
```

- `kind` 由生产方定义，同时是 id 前缀（`<kind>-N`）。注册表把它当不透明命名空间。
- `owner` 是活着的 agent；访问用它的 session id 做围栏——**谁起的谁能看能停**；agent 释放时连带取消并等待。
- `JobSnapshot` 每次调用返回新对象，绝不外泄活的注册表状态。
- `reported` 位标记终态是否已通知过，用于抑制重复通知。

### 1.2 关键修正：没有 `job_start` 工具

我原先列了五个工具（`job_start/status/logs/stop/metrics`）。最终只留三个，且没有 start——**这是对的**。

模型不"启动一个 job"。模型是"跑一个命令 / 派一个 subagent"，而这件事恰好在后台。启动由**生产方**在自己需要时调 `ctx.jobs.start()`：bash 工具发现命令是长跑就注册一个 job，subagent 工具派活时注册一个 job。这样 job 与 kind 无关，也不需要为每种长跑活计新开工具。

对我们：gateway 后端的生产方就是"跑一条命令"这件事本身，由 bash 工具或一个薄生产方触发，`kind: "gateway"`。

### 1.3 工具层：三个工具

| 工具 | 行为 |
|---|---|
| `job_output(job_id, wait?, timeout_ms?)` | 默认非阻塞读。流式任务返回下一个增量；最终输出型任务终止后返回结果。响应尾部带 `[status: ...]`。`wait: true` 最多等到配置上限，超时后运行中任务保持存活 |
| `job_list()` | 调用方可见的任务，格式 `<id> [<kind>] <status> — <label>` |
| `job_kill(job_id, reason?)` | 立即请求取消，原因原样转发。已终止任务返回非消费式快照 |

- 每个任务只有**一个消费游标**，流式读取不重复已消费内容。
- 公共快照省略 `ownerSession` 与内部 `reported` 位。

### 1.4 不轮询，用完成通知

这条是硬约束，直接解决 experiment-runner 的 `sleep 300`。系统提示词区段原文：

> Track every background job id you start. You are notified in-session when a job finishes — do not busy-poll or sleep on one; keep working on independent steps and do not duplicate a running job's work. Before giving a final answer, collect every still-relevant job with job_output (set wait: true only when you are genuinely blocked on it), and job_kill jobs that stopped mattering.

投递按 owner 当时的状态分两条通道：

- **忙的 owner → 注入**：通知进 next-step inbox，inbox 非空时 turn 不能结束。多个任务同时结算只花掉一步，不是各占一轮。
- **闲的 owner → 唤醒**：follow-up 开一轮，否则无人领取的通知等于模型永远不知道任务完成了。

唤醒有界：每 owner 最多 `maxConsecutiveWakes`（默认 3）轮由唤醒开启，超出降级为注入；领到任何用户撰写的消息才恢复预算。**设界是因为这条链会自激**——被唤醒的一轮可能又起一个后台任务，它的完成又唤醒同一个 owner。

配置默认值：`waitTimeoutMs 30000` / `maxWaitTimeoutMs 600000` / `completionDelivery wakeup` / `maxConsecutiveWakes 3`。

---

## 2. gateway 后端（jobs-gateway）

协议层与工具层直接复用，**我们的增量全在这一层**。

### 2.1 job 记录

```
{
  id, kind: "gateway", label,
  cwd, cmd, env?,
  logPath,                     日志绝对路径（脱离进程自己重定向）
  gate?:    { script, intervalSec },        前置门控
  health?:  { script, intervalSec },        运行中周期检查
  rules?:   [{ match, metric? }],           日志正则 → 抽指标
  status, pid, exitCode?, startedAt, finishedAt?, ownerSession?
}
```

`gate` / `health` / `rules` 全是**用户作者的 bash 片段与正则**，代码里不出现任何领域词。

### 2.2 gate 与 health 是两件不同的事

（这两个我上一版混成了一个，按 roadmap §2 原义分开。）

- **`gate` = 发车前的门**。任务先排 `queued`，gateway 周期跑那段 bash，**退出码 0 才真正启动进程**，否则继续等待重试。典型用法"显存够了再开训"——但那句 `nvidia-smi --query-gpu=memory.free` 写在技能里，不在代码里。
- **`health` = 跑起来之后的周期检查**。非零退出码视为异常，标记异常并按规则通知。

一句话：gate 决定**要不要开始**，health 决定**跑着的这个是否还正常**。

### 2.3 状态存储

- 位置 `~/.kalo/agent/jobs/`，与 `schedules.json` 平级，遵循 pi_config.rs `agent_dir()` 模式。
- 每任务一文件 `<jobId>.json`；原子写（tmp + rename），沿用 scheduler.ts 的 load/save 约定。
- 唯一写者是 gateway 后端。模型与 Channel 都不直接写 JSON。
- gateway 启动时扫目录恢复，对 `running` 的**重新核对 PID**：活着保持，死了按 exitCode 落终态。`logPath` 留着继续 tail。

### 2.4 日志与 metrics

- 日志由脱离进程自己重定向到 `logPath`，避免 gateway 死掉或管道缓冲丢日志。gateway 只读不写。
- metrics：`rules` 里形如 `{ match: "loss *= *([0-9.]+)", metric: "loss" }`，命中即把一行 JSON 追加到 `<jobId>.metrics.jsonl`。**只抽取保存，不做聚合**——聚合是复盘层的事。
- 训练 loss、回测净值、抓取进度共用这一套，同一个面板画。

### 2.5 进程与生命周期

- spawn 加 `CREATE_BREAKAWAY_FROM_JOB`（0x01000000）`| CREATE_NO_WINDOW`（0x08000000），脱离 gateway 的进程组。
- 周期 tick（注入时钟，沿用 scheduler 模式）：① queued 任务复查 gate；② running 任务 PID 存活探针；③ health 到点复查；④ 日志增量 tail → 跑 rules。
- gateway 重启：重建后端 → 扫目录 → 核对 running 真实性 → 恢复轮询。**以落盘为准**。
- 独立模块，不混进 scheduler.ts；两者共用 deps 注入约定。

---

## 3. P0-2 Channel

### 3.1 接口

一条统一进出通道：收消息、推进度、问答。第一个载体是 Feishu（已有 `feishu.ts`），但接口与载体解耦。

```
send(msg, ctx)              推一条消息
updateText(msgKey, text)    原地改（进度滚动）
ask(msg, { choices })       问一个问题并等回答
onCommand(handler)          注册命令处理器
```

### 3.2 命令语法

- `/status` —— job 快照（走 `job_list`）+ scheduler 状态
- `/stop <jobId|name>` —— 走 `job_kill`
- `/ok` —— 双确认的第二道闸

解析在 Channel 层统一做；Feishu 只负责剥掉 @ 与格式后把纯文本交上来。

### 3.3 自然语言

不是命令、也不在待确认状态 → 当自然语言请求 → 走已有的 `session_request` OutMessage 握手开 headless pi 会话（Rust `handle_session_request` 已实现：spawn PiProcess `source="gateway"` → `session_started` → `wait_for_engine` 探测 → 盲发 prompt → 事件经 `event`/`session_exit` 回流）。渲染走现有 ProgressRenderer。

### 3.4 安全

1. **只认配对的 open_id**：`im.message.receive_v1` 进来先核 `sender === boundOpenId`。
2. **白名单 + 双确认**：会改东西的操作（起任务、停任务、写文件、跑命令）先回一个待确认项，只有 `/ok` 才执行。`/status` 只读，免确认。
3. `/ok` 只作用于最近一个待确认项，且 60s 过期。
4. 解绑后不做任何 ingest。

---

## 4. NDJSON 协议增量

gateway 后端要被 Rust(UI) 与 Channel 驱动，在 [protocol.ts](../../kalo-desktop/gateway/src/protocol.ts) 两侧加枚举，与 scheduler 同型。

**InCommand（Rust → gateway，main.ts `handleCommand` 加 case）**

```
| { cmd: "job_start"; label; cwd; cmd; env?; gate?; health?; rules? }
| { cmd: "job_list" }
| { cmd: "job_output"; id; tail? }
| { cmd: "job_kill"; id; reason? }
| { cmd: "job_metrics"; id; tail? }
```

**OutMessage（gateway → Rust，gateway.rs `handle_gateway_line` 加 match 臂）**

```
| { type: "job_status"; jobs: JobInfo[] }      单个与全部共用
| { type: "job_output"; id; text }
| { type: "job_metrics"; id; entries }
| { type: "job_error"; message }
```

`send()` 保持唯一 stdout 写者。前端统一任务面板（`JobsCenter.tsx`）消费 `job_status`，但面板本身不在本阶段范围。

---

## 5. 测试

沿用 scheduler.test.ts 约定（bun:test、deps 注入、临时目录、注入时钟、落盘 round-trip、waitFor 轮询、T0 基准、工厂函数）：

1. `job_start` → running：落盘正确，进程脱离 spawn 成功（无害命令）
2. `job_kill` → killed：进程终止，exitCode 记录，快照非消费式
3. gate 未通过 → 保持 queued 并重试；通过后才 spawn
4. health 失败 → 标记异常
5. rules 命中 → metrics.jsonl 追加，断言抽取值
6. 持久化 round-trip：存盘 → 新后端载入 → 状态一致（模拟 gateway 重启）
7. PID 已死的 running 记录 → 重启后转终态
8. owner 围栏：非 owner 不可见/不可停
9. 完成通知：忙 owner 走注入，闲 owner 走唤醒，唤醒预算耗尽后降级
10. Channel：`/status`、`/stop x`、`/ok`、自然语言分流、非绑定账号拒绝、`/ok` 60s 过期
11. **测试里不许出现 nvidia-smi / OOM / arXiv / ticker**

---

## 6. 落地顺序

1. 本文档确认 → 进 2
2. 协议层 + 工具层（`job_output` / `job_list` / `job_kill` + 完成通知 + 提示词区段）
3. `jobs-gateway` 后端：脱离 spawn、store、tick、gate/health、rules → metrics
4. 测试 1–8
5. `channel.ts` + 测试 10
6. feishu.ts 接入 ingest + 双确认
7. Rust gateway.rs 两侧 match 臂
8. 联调

每步独立可合。先只到 1。

---

## 7. 原则复核（对照 roadmap §7）

- ✅ 抽共同的：协议/后端/工具三层，领域逻辑全在用户内容层
- ✅ 状态由工具写，不由模型手写
- ✅ 工具可插拔：`jobs-local` 与 `jobs-gateway` 平行，工具层不变
- ✅ 不轮询：完成通知取代 `sleep 300`
- ✅ 无 Inbox、无 `~/.kalo/investing/`、无 nvidia-smi 进 base
- ✅ 本阶段不碰检索（仍是纯关键词、零向量）
- ✅ job 进程脱离 gateway，桌面关闭与 gateway 重启都杀不死任务

