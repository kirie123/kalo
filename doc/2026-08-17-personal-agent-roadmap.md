# Kalo 个人 Agent 路线图（通用底座 + 提示层）

日期：2026-08-17
状态：规划中（代码中被引用的旧 `doc/kalo-personal-agent-roadmap.md` 已丢失，本文重建并接续）

## 0. 出发点与设计取向

Kalo 是一个人的 Agent，日常覆盖三件事：读论文/文章并沉淀 idea、在本机 4090 上跑训练实验、记录与复盘个人投资。

但**这三件事不该对应三套代码**。摊开看，它们只在三件事上真正需要引擎支持：

| | 知识线 | 实验线 | 投资线 |
|---|---|---|---|
| 长时间自己跑 | 批量抓取/精读 | 训练 | 数据拉取、回测 |
| 跑的时候要能管 | 进度 | loss / 显存 / 中断 | 行情 / 异动 |
| 事后要能找回来 | 论文笔记、idea | 实验结论 | 复盘结论 |

其余的一切——文件怎么放、目录怎么分、什么内容归到哪——**是提示层的事，不是功能**。模型完全有能力按 AGENTS.md / 技能里写的约定整理文件；把这些约定编译进代码只会得到一堆改不动的特例。

所以路线图分两层：

- **底座（写代码）**：长跑任务、双向通知、检索——三个与领域无关的原语（定时已有）。
- **提示层（不写代码）**：AGENTS.md 与技能里描述「怎么组织、怎么归档、怎么复盘」，随时可改。

判据：**能用提示 + 目录约定解决的，绝不写扩展**；反过来，**三条线都要用的机制必须沉到底座**，不许在技能里各写一遍。

## 1. 现状盘点

### 已有能力

| 层 | 能力 | 位置 |
|---|---|---|
| 记忆 | `memory_save/search/list`，索引注入系统提示，`/remember` | `kalo-harness/.../extensions/memory/` |
| 知识库 | `~/.kalo/knowledge/` + INDEX.md，rg 检索，桌面管理页 | `src-tauri/src/knowledge.rs`、`resources/knowledge-skill/` |
| 技能 | paper-reading / web-research / experiment-runner / math（内置分发，write-if-missing） | `.../extensions/kalo-skills/` |
| 联网 | `web_fetch` | `.../extensions/webfetch/` |
| 定时 | gateway Scheduler：cron `watch`（跑 bash，非空输出告警）/ `agent`（拉起 headless 会话） | `gateway/src/scheduler.ts` |
| 通知 | 飞书配对 + 长连 + 进度消息实时编辑（**单向 push**） | `gateway/src/{feishu,renderer}.ts` |
| 并发 | 引擎池、subagent、Jobs 中心 | `JobsCenter.tsx`、`.../extensions/subagent/` |

### 三个原语的缺口

| 原语 | 现状 | 缺口 |
|---|---|---|
| 长跑 | 技能里 `Start-Process` + `sleep` 轮询 | **跑在会话里，桌面应用关不得**；状态靠模型手写 markdown；无守护、无失败策略、无指标 |
| 通知 | 单向 push | 收不了指令，半夜没法批准或叫停 |
| 检索 | memory 关键词打分 + knowledge rg | 中文近乎失效；三处语料（memory / knowledge / 会话）三套检索，无统一入口；会话日志完全搜不了 |
| 定时 | Scheduler 已可用 | 够用，缺与长跑的联动 |

三条线的差距都落在这三格里：实验线卡在长跑 + 通知，知识线卡在检索，投资线则是「还没写提示」——不是缺功能。

### 借鉴的通用契约

不引入插件架构（pi 的扩展模型够用），只取通用契约：

| 契约 | 要点 | 用在 |
|---|---|---|
| job 注册表 | 长跑注册表：观察/取消/等待/完成通知，owner 隔离 | 长跑 |
| 大输出落盘 | 超大工具输出落盘，上下文只留预览 + 定位符 | 长跑（日志）、检索（长文） |
| 会话日志 FTS | 会话日志 SQLite FTS 检索 | 检索 |
| 超时与预算 | 每次调用的超时与预算 | 长跑（夜间无人看管） |
| 结果裁剪 | 无模型参与的工具结果裁剪 | 长跑（长循环控上下文） |

## 2. P0-1 长跑任务运行时（Job Runtime）

把「长时间自己跑的东西」从会话搬到常驻 gateway sidecar（它已常驻且持有通知通道）。**通用到与任务内容无关**：训练、回测、批量抓取，都只是一条命令。

```
job = {
  id, name, cwd, cmd,              # 一条命令，不关心它在干什么
  logPath,                          # stdout/stderr 重定向
  gate?:   string,                  # 前置门控：一段 bash，退出码 0 才发车，否则等待重试
  health?: { every, script },       # 周期健康检查：一段 bash，非零退出码视为异常
  rules?:  [{ match, action }],     # 日志模式 → retry / stop / notify
  status, pid, exitCode, startedAt, owner
}
```

- 进程由 sidecar 拉起并守护（存活检查、退出码捕获、日志重定向），**会话只是观察者**——关掉聊天窗口不影响任务。
- `gate` / `health` / `rules` 都是用户写的 bash 与正则。**代码里不出现 nvidia-smi、不出现 OOM**：显存门控只是实验技能里的一段 `nvidia-smi --query-gpu=memory.free` 脚本；「等开盘」只是一段 date 判断。
- 失败分级由 `rules` 表达而非硬编码：匹配到某模式就重试 N 次 / 停下通知 / 只记一笔。每次自动处置进 job 事件流，事后可审计。
- 指标：日志里的 `key=value` 行由运行时统一抽成时间序列（`metrics.jsonl`）。训练 loss、回测净值、抓取进度，同一套面板画。
- owner-fenced 语义：谁起的谁能停，完成通知回到发起方（会话或通知通道）。
- 模型侧五个工具：`job_start / job_status / job_logs / job_stop / job_metrics`。**真相由工具写，不由模型手写 markdown**——这是对现有 experiment-runner 技能最重要的修正。
- 桌面 Jobs 中心从「运行中会话 + 定时任务」升级为统一任务面板（日志尾巴、指标曲线、停止/重跑）。

## 3. P0-2 通知通道双向化（Channel）

现状飞书单向 push。抽一层通道接口——`send(msg) / ask(msg, options) / onCommand(handler)`——飞书是第一个实现，日后换 IM 不动上层。

- 上行指令与领域无关：`/status`、`/stop <job>`、`/resume <job>`、`/ok`（批准待确认动作），以及**自然语言 → 起一个 headless 会话**。
- `ask` 用交互卡片（同意/拒绝按钮），避免半夜打字。job `rules` 停下时、agent 要批准时，都走这一个口子。
- 安全：只认配对绑定的账号；shell 执行与写操作走白名单 + 二次确认。

## 4. P1 检索原语（关键词路线，不用 embedding）

三处语料目前三套检索，会话日志根本搜不了。合成一个入口，**纯关键词/全文，不引入向量**：

- **统一索引** `~/.kalo/index.sqlite`：SQLite **FTS5**，覆盖 memory、knowledge、会话日志。每库一张表、按 mtime 增量更新，建法见《2026-08-18-recall-fts5.md》。
- **中文匹配用 trigram tokenizer**（FTS5 内置）。中文失效的根因是按空格切词，trigram 把「梯度累积」切成三字窗口，子串命中即可召回——不需要分词器，也不需要 embedding。英文继续走 porter/unicode61，两个索引列并存。
- **单一工具** `recall(query, scope?, limit?)`：FTS 命中 + 现有关键词打分排序。现有 `memory_search` 与技能里手写的 rg 命令都收敛到它，rg 保留作为无索引时的兜底。
- 增量索引：文件 mtime + 会话追加位点，改动即更新，无需重建。
- 长文走 spill：命中只回预览 + 定位符，要全文再取。

检索定死纯关键词路线，不引入向量。若日后某条线确实需要"按语义"找东西（比如「想不起原词只记得意思」反复出现），那件事属于那条线的提示层/SKILL 文案去描述，不要把它变成 base 层的能力。

## 5. 提示层：三条线只写提示

底座齐了之后，三条主线都是 AGENTS.md 与技能里的文字。**本节不产生任何新扩展、新 Rust 代码、新内置目录。**

- **知识线**：paper-reading / web-research 已存在，改造点只有一个——把手写 rg 换成 `recall`。arXiv 追更 = 一个 cron agent 任务 + `web_fetch`，纯 prompt。旧卡片定期回顾同理。
- **实验线**：experiment-runner 重写为「怎么用 `job_*` 工具」；显存门控写成 `gate` 脚本，OOM 降 batch 重试写成 `rules` 条目，指标行约定成 `key=value`。技能变薄，可靠性来自运行时。
- **投资线**：**不建内置目录、不做 market_data 工具**。在 AGENTS.md 里写清怎么组织交易记录与复盘（放哪、什么格式、多久回看一次），模型据此建目录、写文件、整理归档。行情用 python 脚本临时写（akshare 或公开接口，无 key），跑得久就丢给 job；盯盘用 Scheduler `watch` + 通道推送。定位是记录与复盘，不做投资建议，不自动下单。

同一判据回看现有代码：`knowledge.rs` 里写死的四个域（cards / training-notes / investing / math）也属于「编译进代码的领域特例」，应改为用户可配置列表——低优先，但方向一致。

## 6. 排期

| 阶段 | 内容 | 依赖 | 解锁 |
|---|---|---|---|
| P0-1 | Job Runtime + 守护 + 指标抽取 | — | 实验线可用；离开电脑任务照跑 |
| P0-2 | 通道双向化 | — | 三线共用的「批准 / 叫停 / 问一句」 |
| P1-R | 统一 `recall`（FTS5 + trigram） | — | 三处语料一个入口，中文可搜 |
| P1-S | 三条线提示与技能改写 | P0、P1-R | 三条主线真正跑起来 |
| P2 | spill、token 预算、结果裁剪、知识域可配置 | — | 长循环与夜跑的稳定性 |

**建议起手**：P0-1 + P0-2 一起做——都在 gateway sidecar，改动集中，且是「睡觉时也能跑」的全部前提。

## 7. 原则

- 文件即状态，但**状态由工具写，不由模型手写**。
- 领域知识只出现在提示与目录约定里；代码里不该出现 nvidia-smi、arXiv、股票代码这类词。
- 三条线都要用的机制沉底座，只有一条线用的留提示层。
- 用户可编辑的一切（技能、记忆、卡片、配置）write-if-missing，绝不覆盖。
- 自动化分级：能自动的自动，不确定的问，问不到的停——停下时保留完整现场。
- 无 key 优先：公开接口 + 本地索引，个人工具不该引入账号依赖。
