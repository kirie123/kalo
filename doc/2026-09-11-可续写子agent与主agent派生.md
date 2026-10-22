# 可续写子 Agent、外部托管 Job 与主 Agent 派生

日期：2026-09-11
状态：第一期已实现；gateway external job 与 peer 派生仍未实现，第二、三期待定。

> 本次覆盖（2026-10-13）：[后台子 Agent 生命周期与可靠投递](2026-10-13-后台子agent生命周期与可靠投递.md) 源码已实现，未构建、未打包、未提交。该设计覆盖本文 §4 的后台生命周期、resume/并发槽位与权限恢复，以及 §3/§4 中拟议的子任务结果通知方式和桌面保活：运行中 resume 追加 followUp，复用当前 run；空闲续写才新建 run。权限落盘为 `<childId>.tools.json` + custom entry，旧会话无权限 metadata 按 `[]` 恢复，需工具时新建并赋权。所有结果 pending 至成功 assistant + settled ack，提供至少一次投递；notification 最多 3 批（busy 也计数），每批最多 20 条且整批总长不超过 12,000 字符。owner 仅限单进程，不支持同 session 双 engine 并写。
>
> 应用退出后子任务不存活；重开原会话恢复结果/中断，不自动重跑。保活仅限进程内，非 active 父会话没有引擎时不会自动开引擎。本次未实现 gateway external job、轮次 claimCompletions 或 peer 派生，下文相关接口与流程保留为待实现提案；`POST /jobs` 已有后台 bash 调用，必须保留，原“零调用方/删除路由”判断作废。§0 与第一期验证数字均为当时记录，本次验证状态见新设计。

把子 agent 从「一次性、跑完即弃」改造为「常驻、可唤醒续写」，把它纳入 job 可观测面并真正激活 owner 隔离，再在其上开一条受控的「主 agent 派生并行主 agent」通道，派生出来的主 agent 在 git worktree 里干活。

---

## 0. 现状核对

动手前把三处「文档说有、代码没有」的偏差钉死，后续设计以代码为准。

| 既有文档的说法 | 代码事实 |
|---|---|
| 生产方调 `ctx.jobs.start()` 注册 job（`2026-08-17-p0-job-runtime-channel.md` §1.2） | `ctx.jobs` 在 `kalo-harness` 中不存在。job 协议层只在 `kalo-desktop/gateway/src/jobs/types.ts`；引擎侧只有一份手抄的 `JobSnapshot`（`kalo-jobs/client.ts`）。引擎**没有任何创建 job 的能力** |
| 「subagent 工具派活时注册一个 job」 | 未落地。`extensions/subagent/index.ts` 与 job 运行时零耦合 |
| `job_start` Rust 命令零调用方（`2026-08-18-era-evolve-panel.md`） | 已有 6 个调用方（era 5 个 + `MarketEnvCard`） |

另有两项运行时事实，是本设计的直接前提：

1. **owner 围栏写了但从未激活**。`gateway-backend.ts` 的 `visible()` / `require()` 三分支完整，但 6 个生产方全部不传 `owner`，线上所有 job 都是无主 job —— 对任何 pi 会话可见、可 kill。
2. **子 agent 严格一次性**。`runChild()` 内 `await session.prompt(prompt)` 跑完整个 loop，取最后一条 assistant 文本回传，写一份只读 markdown 转录后 session 变为不可达等 GC。历史走 `SessionManager.inMemory()`，无 `.jsonl`，无法用 `fromFile` 加载续跑。

---

## 1. 目标与非目标

### 目标

1. 子 agent 跑完一轮后**不销毁**，保持可续写；因报错、idle watchdog 中止等原因中断的子 agent，主 agent 能唤醒它继续。
2. 主 agent 能向子 agent 的输入投递消息（等价于给它补一条 user prompt）。
3. 子 agent 以 `kind="subagent"` 出现在 `job_list` 中，复用统一的可观测面与完成通知。
4. 隔离做实：主 agent 只能看见**自己的子 agent** 与**其他主 agent 任务**；不能看见别的主 agent 的子 agent。
5. 主 agent 可以派生并行的主 agent，但必须经由 kalo-desktop 接口、每次经用户确认，且派生出的主 agent 在 git worktree 中工作。

### 非目标

- 不做「引擎重启后自动复活子 agent」。跨进程恢复作为**能力开放**（见 §4.4），但必须由主 agent 显式 `resume` 触发；引擎重启时不替用户决定哪些子 agent 该接着跑。
- 不做子 agent 递归派生（子 agent 仍然拿不到 `agent` 工具）。
- 不做 agent 间直接通信。所有消息流经主 agent。

---

## 2. 决策记录

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 子 agent 存活形态 | 常驻内存 + 可续写 | 引擎进程内维护 `Map<childId, ChildHandle>`，跑完不丢弃。比「独立 pi 子进程」省掉一整条 IPC 通道，比「重放式续写」省掉每轮重建 session 的开销与语义歧义 |
| D6 | 子 agent 会话存储位置 | 放在父会话所在的 cwd 桶下的 `subagent/<主会话id>/` | 与父会话物理相邻，删父会话时子 agent 跟着走，不产生孤儿；避免再造一个百桶量级的平铺目录。见 §4.4 |
| D2 | 子 agent 是否进 job 列表 | 进，`kind="subagent"` | 复用 owner 围栏与完成通知（inbox 注入 / 有界唤醒），不必为 agent 重写一遍同样的机制 |
| D3 | 主 agent 派生的限制 | 每次桌面端弹窗人工确认 | 派生主 agent = 授予完整工具面（含 `bash`、写文件）。这是本设计中唯一不可逆的放权点，用人工确认兜底 |
| D4 | worktree 归属 | **agent 自己跑 git 命令** | 用户决定。实现最简，代价见 §6，需配套三项兜底 |
| D5 | 本次交付范围 | 只写设计文档 | 契约先行 |

D4 与推荐方案（桌面端纳管）相反，风险与兜底在 §6 单独展开，实现时不得省略兜底部分。

---

## 3. 核心架构问题：外部托管 Job

**本节为后续 external job 提案，尚未实现。** 本次后台子 agent 使用引擎内运行记录与通知确认，不登记为 gateway command/external job。子 agent 若将来要出现在 `job_list` 里，第一反应是复用协议层的 `JobRegistry.start(spec)`：

```ts
JobStart = { kind, label, owner?, run(): JobHooks }
JobHooks = { cancel(reason?), done: Promise<JobOutcome>, readOutput?() }
```

**这条路走不通。** `run()` 返回的 `JobHooks` 是一组函数句柄，要求生产方与注册表处在同一个进程。但：

- job 注册表活在 **gateway 进程**（Bun sidecar）
- 子 agent 活在 **引擎进程**（pi sidecar）
- 两者之间只有 loopback HTTP，函数传不过去

另一条现成路径 `startCommand()` 也不适用：它 spawn 一个 detached 进程并要求 `cmd` / `logPath` 必填，而子 agent 根本不是进程。

因此引入 **第三种 job 形态：外部托管 job（external job）**。gateway 只持有元数据、状态与输出缓冲，实际执行由引擎进程负责，引擎通过 HTTP 主动上报。

### 3.1 三种 job 形态的分工

| 形态 | 执行者 | 状态来源 | 现有/新增 |
|---|---|---|---|
| command job | gateway spawn 的 detached 进程 | gateway 轮询 PID + tail 日志 | 现有 |
| in-process job | gateway 进程内的生产方 | `JobHooks` | 现有（死代码，保留） |
| **external job** | **引擎进程（子 agent / 派生主 agent）** | **引擎 HTTP 上报** | **新增** |

### 3.2 JobRecord 扩展

`gateway/src/jobs/store.ts` 的 `JobRecord` 目前 `cmd` 与 `logPath` 必填。改造：

```ts
export interface JobRecord {
  id: string;
  kind: string;
  label: string;
  /** 外部托管 job 的执行方标识；缺省表示 command job。 */
  runtime?: "external";
  /** command job 必填；external job 省略。 */
  cmd?: string;
  logPath?: string;
  cwd: string;
  // ... 其余字段不变
  ownerSession?: string;
  /** 新增：父 job id。子 agent 记录派生它的主 agent 会话所属的 job；用于 §5 的可见性收敛。 */
  parentJob?: string;
  /** 新增：external job 的输出缓冲（追加写，读时按游标切片）。 */
  outputPath?: string;
}
```

约束：`runtime === "external"` 的记录，gateway 的 `tick()` **跳过** PID 存活探针与 `launch()`；它的状态只由引擎上报驱动。若引擎在 `externalStaleMs`（默认 90s）内没有任何上报且状态仍为 `running`，标记 `detail="引擎失联"` 并置 `failed` —— 这是引擎进程崩溃时的兜底，避免僵尸 running。

### 3.3 新增 HTTP 面

`gateway/src/jobs/server.ts` 增三条路由，全部要求 `x-kalo-session` 头（即 caller 必须是 string，operator 不能代打）：

| 路由 | 语义 |
|---|---|
| `POST /jobs/external` | 注册一个 external job。body `{ kind, label, cwd, parentJob? }`，owner 强制取 `x-kalo-session`，**不接受 body 覆盖** |
| `POST /jobs/:id/report` | 上报状态与增量输出。body `{ status?, detail?, appendOutput? }`。仅 owner 可调 |
| `POST /jobs/:id/heartbeat` | 心跳，刷新 `lastReportAt` |

`kind` 白名单：external job 仅允许 `subagent` 与 `peer` 两种，其余拒绝。这防止引擎侧借这条通道注册任意 kind 的 job 混淆可见性规则。

对应地，引擎侧 `kalo-jobs/client.ts` 增 `registerExternal()` / `report()` / `heartbeat()` 三个方法。**注意**：这三个方法只供 subagent 扩展内部调用，不暴露为模型可见工具 —— 「没有 `job_start` 工具」的原则继续成立，模型仍然不能凭空把任意命令丢后台。

---

## 4. 可续写子 Agent（引擎侧）

### 4.1 句柄注册表

`extensions/subagent/index.ts` 内新增进程级注册表：

```ts
interface ChildHandle {
  id: string;               // 与 job id 同值，形如 subagent-3
  session: AgentSession;
  status: "running" | "idle" | "stalled" | "failed" | "closed";
  cwd: string;
  description: string;
  createdAt: number;
  lastActiveAt: number;
  turns: number;
  transcriptPath: string;   // 每轮追加，不再是一次性快照
  ownerSession: string;     // 派生它的主会话
}

const children = new Map<string, ChildHandle>();
```

与现有 `activeChildren` 信号量的关系需要分清，这是两个不同的量：

- **并发上限**（现有 `MAX_CONCURRENCY`，默认 6）：同时处于 `running` 的子 agent 数。空闲续写新建 run 并重新申请槽位；运行中 resume 追加 followUp，复用 run 与槽位。
- **常驻上限**（新增 `MAX_RESIDENT`，默认 16）：`Map` 中非 `closed` 的条目数。超限时按 `lastActiveAt` LRU 驱逐 `idle` 的条目，若全部在 `running` 则拒绝新建并明确报错。

常驻上限是必须的：`AgentSession` 持有完整消息历史，无上限的 `Map` 会让引擎进程内存单调增长。

因为历史已落盘（§4.4），**驱逐不丢失能力**：被驱逐的子 agent 仍可被 `resume`，只是要从文件重建 session（多一次磁盘读）。`MAX_RESIDENT` 因此是纯粹的内存缓存容量，可以调得激进。

### 4.2 工具契约

第一期扩展 `agent` 的 `resume` 参数；2026-10-13 源码进一步加入后台参数与 `agent_tasks`（list/output/cancel）：

```
agent(prompt, description?, tools?, resume?, run_in_background?)
```

`tools` 接受数组或逗号/空白分隔字符串；恢复权限以 `<childId>.tools.json` 与子会话 custom entry 为依据，不从 resume 参数扩权。旧会话无权限 metadata 时恢复为 `[]`，需要工具须新建子会话并显式赋权。

- `resume` 缺省 → 新建子 agent（现有行为）
- `resume: "subagent-3"` → 向该子 agent 投递 `prompt` 作为新的 user message 并继续跑

`resume` 分支的行为：

1. 查 `children`，不存在或 `ownerSession` 不匹配 → 报「未知子 agent」（与 job 围栏同样的措辞策略，不区分「不存在」与「无权限」）。
2. 状态为 `closed`（已驱逐）或不在 Map 中 → 按 §4.4 的路径规则找 `.jsonl`，`fromFile` 重建后继续；文件不存在才报「未知子 agent」。
3. 状态为 `running` → 走 `session.followUp(prompt)`，消息排队，当前轮结束后处理；复用当前 run/runId，不新建 run、监视器或槽位。
4. 状态为 `idle` / `stalled` / `failed` → 走 `session.prompt(prompt)` 开新一轮。**这是「中断后唤醒续写」的主路径**：上一轮因报错或 watchdog 中止而停下，历史仍在 session 里，补一条 user message 即可接着干。

两种投递方式的区别是硬语义，不能混用：`followUp` 只对正在跑的 session 有效（排进队列），`prompt` 只对停下的 session 有效（开新一轮）。实现时按 `status` 分派，不让模型选。

### 4.3 生命周期改造（external job 待实现提案）

以下 gateway report/claimCompletions 流程未落地；当前源码每次运行独立持久化终态与 pending 结果，并按顶部新设计确认投递。子会话仍可续写，常驻句柄与单次 run 的终态分开管理。

`runChild()` 的收尾从「丢弃」改为「归档并保活」：

```
一轮结束（正常 / stalled / 报错）
  → 追加写 transcript（按轮分节，不再覆盖）
  → 更新 handle.status = idle | stalled | failed
  → POST /jobs/:id/report { status: "running", detail: "第 N 轮结束，等待续写" }
  → session 留在 Map 中
```

关键点：**一轮结束不等于 job 结束**。job 的 `status` 只有在以下三种情况才进终态：

| 触发 | job 状态 |
|---|---|
| 主 agent 调 `job_kill` | `killed` |
| LRU 驱逐 / 主会话结束释放 | `completed` |
| 引擎失联超时（§3.2） | `failed` |

这与 command job 的语义差异要在 `job_list` 的呈现上区分开：子 agent 的 `detail` 字段承载「第 N 轮结束，等待续写」，让模型一眼看出它可以被唤醒，而不是误以为任务已完结。

**避免完成通知误报**：现有 drain 机制会把终态 job 推给主 agent。子 agent 每轮结束不进终态，所以不会每轮都触发唤醒；但主 agent 通常需要知道「这一轮跑完了」。方案：`report` 携带 `notify: true` 时，gateway 把该 job 放入一个**轮次通知队列**，走与完成通知同一条 `claimCompletions` 通道投递，但文案区分（「子 agent 一轮结束」而非「后台任务结束」）。有界唤醒预算 `MAX_CONSECUTIVE_WAKES` 对两类通知**共享计数**，否则子 agent 的轮次通知可以绕过唤醒上界形成自激。

### 4.4 历史落盘与恢复

**子 agent 的内核就是主 agent**：同一个 `AgentSession`、同一个 `SessionManager`，差别只在构造参数（工具集裁剪、`noExtensions`、历史存储形态）。所以「恢复历史」不需要任何新机制，只是把构造方式换掉：

```ts
SessionManager.inMemory(cwd)   // 现在：new SessionManager(cwd, "", undefined, false)
SessionManager.fromFile(path)  // 改后：现成静态方法，直接用
```

`fromFile` / `continueRecent` / `forkFrom` 均为 `SessionManager` 已有能力，无需新增。

#### 存储位置

会话目录当前按 cwd 分桶（`getDefaultSessionDirPath`），桶名是转义后的路径，桶内平铺 `.jsonl`：

```
~/.kalo/agent/sessions/--C--Users-fengqi-AppData-Local-Temp-pi-2753-1787021054884-gmkemg7g18--/
```

实测已有 104 个桶，桶名对人几乎不可读。因此**不得**另开一个 `~/.kalo/agent/subagent-sessions/` 平铺目录 —— 那等于把同样的「分不清」问题再复制一份。

子 agent 会话落在**父会话所在的那个桶**下：

```
~/.kalo/agent/sessions/<cwd 桶>/
├── <主会话>.jsonl
└── subagent/
    └── <主会话 id>/
        ├── subagent-1.jsonl
        └── subagent-3.jsonl
```

分两层的理由：一个 cwd 桶内有多个主会话，不按主会话 id 再分一层，子 agent 仍会混在一起。

#### 为什么不会污染会话列表

原设计避开 `sessions/` 是因为「桌面端把该目录下每个 `.jsonl` 都列为会话」。实测两侧扫描**均为非递归**，所以放进子目录天然安全：

| 扫描方 | 行为 |
|---|---|
| 引擎 `session-manager.ts:639` | 单层 `readdirSync(sessionDir)` |
| 桌面端 `sessions_store.rs:45,53` | 两层（root → cwd 桶），到桶即止，桶内只认 `.jsonl` 文件 |

`subagent/` 是目录不是 `.jsonl`，两边都会跳过。**无需新增任何过滤代码**。

这里有一条隐含约束要写进测试：若将来有人把任一侧扫描改成递归，子 agent 会成批泄露到会话列表。§9 给出对应的回归用例。

#### 恢复语义

落盘支持三个用途，按优先级：

1. **LRU 驱逐后的续写**（§4.1）。被驱逐的 handle 已不在内存，`resume` 时用 `fromFile` 重建 session 即可。这让 `MAX_RESIDENT` 从「硬上限」变成「内存缓存容量」，驱逐不再意味着能力丢失。
2. **跨引擎进程续写**。上一个引擎进程留下的子 agent，只要文件还在，`resume` 就能接着跑。
3. 事后审计。

不做自动重跑：引擎重启后恢复持久运行记录与待投递结果，无存活执行的 queued/running 转 interrupted；只有显式 `resume` 才继续子任务。「哪些子 agent 该接着跑」是主 agent 与用户的决定，不是进程启动的副作用。对应地，`resume` 一个不在内存的 childId 时：

- 先查 `children` Map，命中则直接用
- 未命中 → 拼出路径 `<cwd 桶>/subagent/<主会话 id>/<childId>.jsonl`，存在则 `fromFile` 重建并回填 Map
- 文件也不在 → 报「未知子 agent」

路径里的主会话 id 就是天然的围栏：别的主会话拼不出这个路径，也就拿不到别人的子 agent（与 §5 的 job 围栏互为冗余）。

markdown 转录改放到同一目录（`subagent/<主会话 id>/<childId>.md`），不再散在 `~/.kalo/agent/subagent-transcripts/`。它面向主 agent 用 `read`/`grep` 消费，与 `.jsonl` 的机器可读用途不重叠，两者放一起便于排查时对照。

---

## 5. 隔离模型

用户要求的隔离规则：

> 主 agent 查看 job 只能查看自己的子 agent 以及其他主 agent 任务，而其他主 agent 也不能通过 job 查看别的主 agent 的子 agent。

翻译成判定规则。设 caller 为主会话 id `S`：

| job 类型 | 可见条件 |
|---|---|
| `kind="subagent"` | `ownerSession === S`（只见自己的子 agent） |
| `kind="peer"`（派生的主 agent） | 对所有主会话可见 |
| command job（era 等） | 维持现状 |
| caller 为 `OPERATOR`（桌面端） | 全见 |

即在 `gateway-backend.ts` 的 `visible()` 中加一条分支：

```ts
private visible(rec: JobRecord, caller?: Caller): boolean {
  if (caller === OPERATOR) return true;
  if (rec.kind === "subagent") return rec.ownerSession === caller;  // 新增：子 agent 严格私有
  if (rec.ownerSession === undefined) return true;
  return rec.ownerSession === caller;
}
```

注意子 agent 分支必须放在无主 job 分支**之前**：子 agent 一律有主，但把判断前置可以让「忘记传 owner 的 subagent 记录」失败关闭（不可见）而非失败开放（全可见）。

### 5.1 激活现有围栏

现状所有 command job 无主，是因为 6 个生产方都不传 `owner`。本期**不改变 era / MarketEnvCard 的无主状态** —— 它们由桌面端面板发起，本就该对所有会话可见（用户在面板上点的，任何会话里问「装完了吗」都该答得上来）。

`POST /jobs`（command job 的 HTTP 入口）已有后台 bash 调用，必须保留；`x-kalo-session` 与 owner 的处理仍属于 command job 契约。external job 的后续方案不得以“零调用方”为由关闭此路由。

---

## 6. 主 Agent 派生（peer）

### 6.1 调用链

派生主 agent 不走引擎，走桌面端 —— 这样桌面端天然知情，且可以插入确认环节。

```
主 agent 调 spawn_peer(task, worktree_hint?)
  └─ 引擎：POST /jobs/external 之前，先发一条 channel 请求给桌面端
       └─ gateway → NDJSON {"type":"peer_request", requestId, ownerSession, task, cwd}
            └─ Rust gateway.rs 转 Tauri 事件 peer-request
                 └─ React 弹确认框：显示任务描述、目标 worktree、发起会话
                      ├─ 用户拒绝 → peer_reply {ok:false, reason}
                      └─ 用户同意 → 桌面端创建一个新的主会话（复用「新对话」路径）
                           └─ 该会话 cwd = worktree 路径
                                └─ 注册 external job kind="peer", owner=新会话 id
                                     └─ peer_reply {ok:true, jobId, sessionId}
```

要点：

- **确认框不可绕过**。引擎侧没有任何直接创建 peer 的通道；`POST /jobs/external` 的 kind 白名单虽然含 `peer`，但 gateway 对 `kind="peer"` 的注册请求**只接受来自 NDJSON（OPERATOR）的调用**，拒绝 HTTP caller。即引擎能注册 `subagent`，不能注册 `peer`。
- 派生出的主 agent 是**真正的主会话**，有完整工具面，在桌面端会话列表可见，用户可以随时点进去接管。这是 D3 要求「桌面端对该会话可见」的落点。
- 主 agent 观察 peer 只通过 `job_list` / `job_output`；**不能** `agent(resume:)` 一个 peer（`resume` 只认 `kind="subagent"`）。给 peer 发指令需要用户在桌面端操作，或走后续版本的显式通道。
- 并发上限：同一主会话最多 `MAX_PEERS`（默认 3）个活跃 peer，超限直接拒绝，不排队 —— 排队会让用户在确认框上看到一堆延迟弹出的请求。

### 6.2 worktree（D4：agent 自跑，含兜底）

用户选择让 agent 自己跑 `git worktree` 命令。这带来三个真实风险，对应三项**不可省略**的兜底：

| 风险 | 兜底 |
|---|---|
| 污染主仓库状态（在主工作区误执行 `git worktree add`，或 checkout 走主分支） | 确认框中**必须显示** `git worktree add` 的完整命令与目标路径，由用户过目。桌面端在同意后、创建会话前跑一次 `git -C <repo> worktree list` 校验目标路径确实是一个 worktree 且不等于主工作区，不通过则整个派生失败 |
| 清理无人负责，worktree 越积越多 | 桌面端「自动化」页增加 worktree 列表视图，展示每个 worktree 关联的 peer 会话与状态，提供手工删除。peer job 进终态时在 `detail` 写明「worktree 仍在：\<path\>」提醒 |
| 并行 peer 互相踩（同名分支、同路径） | 派生请求在桌面端排队串行处理；注册 peer job 时记录 `worktreePath`，同路径已有活跃 peer 则拒绝 |

命名约定（写进 `spawn_peer` 的工具描述，由模型遵守，桌面端校验）：worktree 路径 `../kalo-worktrees/<会话短id>-<slug>`，分支 `peer/<slug>`。放在仓库外同级目录，避免被主仓库的文件面板与 `rg` 扫到。

仓库的冲突处理纪律（只 `git add` 自己改过的文件、禁止 `git add -A`）对 peer **同样适用**，且更重要：多个 peer 并行时，`git add -A` 会把别的 worktree 的痕迹卷进来。这一条要写进 peer 会话的初始 prompt。

---

## 7. command job 与后续 external/peer 的边界

`POST /jobs` 是已有后台 bash 的 command job 入口，必须保留。原提案基于“零调用方”要求删除该路由的判断已经失效；不能再要求所有独立进程只由 OPERATOR 发起，否则会破坏后台 bash 的现有契约。

external job 与 peer 派生尚未实现。将来增加时，须单独定义 caller/owner 校验与 peer 确认约束，不能把 command job 启动能力等同于创建完整主会话的权限。拟议 `POST /jobs/external` 对 `kind="peer"` 的调用限制仍属于待实现设计；本次子 agent 只使用引擎内运行记录，不新增这些 HTTP 路由。

---

## 8. 实施分期

每期独立可验收、可回滚。

### 第一期：可续写子 agent（引擎侧自洽）—— 已完成

已交付（引擎侧自洽，未碰 gateway）：

| 文件 | 内容 |
|---|---|
| `extensions/subagent/children.ts`（新） | 会话路径规则、`ChildHandle` 注册表、唤醒围栏、LRU 驱逐 |
| `extensions/subagent/index.ts` | `createChild` / `reviveChild` / `runTurn` 三段拆分；`agent` 工具加 `resume` |
| `extensions/subagent/transcript.ts` | `writeTranscript` → `appendTranscript`，按轮追加 |
| `test/kalo-subagent-children.test.ts`（新） | 路径拼接 / 围栏 / LRU |
| `test/kalo-subagent-isolation.test.ts`（新） | 会话列表不泄露的回归守卫 |
| `test/kalo-subagent-transcript.test.ts` | 适配新 API + 追加语义用例 |
| `test/manual/subagent-live.ts`（新） | **真实模型**端到端：create → resume → 驱逐后 revive |
| `test/manual/subagent-recovery.ts`（新） | **真实模型 + 注入 500 故障**：失败恢复与并发死锁 |

验证：

- `npm run check` 无新增错误（`packages/ai/test` 的 12 条为改动前已存在的基线噪声，已 stash 对比确认）
- 单元测试 23 例全绿
- **真实模型（pz / claude-opus-5）跑通**：第 1 轮记暗号 → 第 2 轮 resume 准确回忆 → `forget()` 踢出内存后第 3 轮从磁盘 revive 仍准确回忆 → 未知 id 被拒 → 转录三轮追加且标题只一份 → 子会话未泄露到父桶
- **失败恢复跑通**（代理注入 500）：工具调用不抛错 → 失败原因回传主 agent → 故障恢复后 resume 同一子 agent → 上下文完整（暗号答对）
- **并发无死锁**（`KALO_SUBAGENT_CONCURRENCY=1`，唯一槽位被占时 resume）：6.6s 返回真实内容（修复前为 0.0s 返回空回复）

#### 实现中修正的五处设计偏差

1. **`SessionManager` 没有 `fromFile`**，实际方法是 `open(path, sessionDir?, cwdOverride?)`。§4.4 已改正。
2. **运行中 `resume` 不能重复申请并发槽位**。运行中的子 agent 已持有槽位，追加 followUp 复用当前 run；2026-10-13 源码明确区分空闲 resident resume，后者须新建 run 并申请槽位，不能仅因 Map 命中就跳过并发上限。
3. **子会话文件名不可预测**（只有真实跑模型才暴露）。原设计假定子会话落在 `<childId>.jsonl`，但 `SessionManager` 自己拼文件名为 `<时间戳>_<sessionId>.jsonl`（`session-manager.ts:953`）。后果：`hasPersisted` 永远返回 false，**驱逐后 / 引擎重启后的 `resume` 全部失效**。现改为 `findChildSessionFile()` 扫目录认 `_<childId>.jsonl` 后缀（并避免 `subagent-1` 误匹配 `subagent-10`）。
4. **失败不会抛异常**（真实注入故障才暴露）。原实现用 `try/catch` 捕失败，但 provider 报错不抛异常——它以 `stopReason: "error"` + `errorMessage` 的 assistant 消息落地，`prompt()` 正常 resolve。后果：主 agent 只能看到「(子 agent 未产生回复)」，**拿不到失败原因**，无法判断该原样重试还是改 prompt。现在同时读抛出值与 `stopReason === "error"` 的消息，`ChildOutcome.failed` 携带原因，`execute()` 新增失败分支。
5. **`followUp()` 只入队、不等完成**（真实并发场景才暴露）。resume 一个**正在跑**的子 agent 时，`followUp` 立即返回，`runTurn` 随即去读「本轮最后一条 assistant 消息」——那时候还不存在，于是 0.0s 内返回「(子 agent 未产生回复)」。现增 `waitForIdle()`，等 `agent_end` 且 `willRetry !== true`（重试中的 `agent_end` 不算结束）。

> 第 3/4/5 条单元测试都查不出来：路径是我自己拼的、异常是我假设会抛的、并发时序是我想象的。必须真跑模型 + 注入故障 + 真并发才能暴露。

#### 一道不在原设计的改动

一轮内报错不再抛成工具失败，而是记下原因、交回部分结果，子 agent 保持 `failed` 状态但可 `resume`。否则「因报错中断 → 唤醒续写」这条主路径在实现上永远走不到：异常会先把整个工具调用带倒。

### 第二期：external job + 隔离

- `JobRecord` 扩展、external 三条路由、引擎 client 三方法
- `visible()` 加 subagent 分支
- 子 agent 注册为 `kind="subagent"` job，轮次通知走共享唤醒预算
- 保留已有后台 bash 调用的 `POST /jobs`，external/peer 另设权限边界（§7）

验收：`job_list` 能看到自己的子 agent；另开一个会话确认看不到；引擎强杀后 job 90s 内转 `failed`。

### 第三期：peer 派生

- NDJSON `peer_request` / `peer_reply`、Rust 转发、React 确认框
- worktree 三项兜底、`MAX_PEERS`
- `spawn_peer` 工具

验收：派生请求弹框 → 拒绝则无副作用 → 同意则新会话出现在列表且 cwd 是 worktree；引擎侧直接 `curl` 注册 peer 被拒。

---

## 9. 测试边界

按桌面端测试约定，纯逻辑必须可单测，够到 Tauri IPC / 真实进程的部分隔离掉。

| 可单测（必须） | 隔离掉 |
|---|---|
| `visible()` 的四类 caller × 四类 job 判定矩阵 | 真实 HTTP 服务 |
| LRU 驱逐选择（哪个 handle 被驱逐） | 真实 `AgentSession` |
| `resume` 的 status → 投递方式分派表 | 真实模型调用 |
| 子 agent 会话路径拼接（cwd 桶 → `subagent/<主会话id>/<childId>.jsonl`） | 真实文件系统（用临时目录） |
| external job 失联超时判定（注入时钟） | 真实定时器 |
| worktree 路径校验（是否为 worktree、是否撞主工作区） | 真实 git 仓库（用 `git worktree list` 的输出样本做表驱动） |

两处易漏的反向用例，要显式写：

- 子 agent job **不传 owner** 时必须不可见（失败关闭，§5）
- `kind="peer"` 的 HTTP 注册请求必须被拒（§7）
- **会话列表不得包含子 agent**：在 cwd 桶下造出 `subagent/<id>/x.jsonl`，断言引擎与桌面端的会话枚举结果不变。这道用例防的是「将来有人把扫描改成递归」导致子 agent 成批泄露（§4.4）

---

## 10. 文档影响

实现落地时同步更新：

- `doc/kalo-subagent-design.md` —— **已更新**：顶部加演进指向；§3.1 工具契约加 `resume`；§3.2 的派生/历史/执行/回传/并发五条改写，补常驻上限与唤醒围栏；新增 §3.4 过程转录
- `doc/2026-08-17-p0-job-runtime-channel.md` —— §1.2 关于 `ctx.jobs.start()` 的设想标注为未落地，补 external job 作为第三形态
- `doc/2026-08-18-era-evolve-panel.md` —— 「`job_start` 零调用方」一句已过期，改为 6 个调用方
- `doc/README.md` —— 索引加入本文
- 若第三期 worktree 出现重复踩坑，按剧本库约定沉淀到 `doc/troubleshooting/`
