# era 面板：自然语言配置 + 可视化与调试

日期：2026-08-18
状态：已实现（V-1 ~ V-4），V-0 与 V-5 未做，见文末「实现记录」
承接：`doc/2026-08-18-era-evolve-panel.md`（该文定了「era 就是一条普通 job」这条主干，本文补两件事）

## 需求

1. **尽量用自然语言做配置和设定，不要让用户自己写/准备前提。**
2. **有比较好的可视化和调试。**

第 1 条是真正难的那条。era 需要四样东西：`--task`（说清目标）、`--seed`（一个能跑的初始程序目录）、`--eval`（一条打分命令，最后一行 stdout 是分数）、`--budget`。前三样今天都得用户手写，其中 `eval.py` 是**评分契约**——era 的全部价值建立在它可信之上。

## 第一部分：自然语言配置

### 判断：不要做「自然语言 → 表单字段」的转译

最容易想到的做法是：用户说一句话，模型填好表单的十几个字段。这个做法解决的是错的问题。`--budget 20` 本来就不难填，难的是**没有 seed 目录、没有 eval.py**。把一句话变成一堆参数，用户面前还是空目录。

所以方向是：**让一次普通的 kalo 会话，把前提物料真的造出来**，产出物是磁盘上的文件，不是内存里的表单状态。

### 流程

```
[新建实验] → 描述框：「我想优化什么」（+ 可选：指一个已有目录/文件当起点）
   │
   ├─► 起一次普通 kalo 会话（cwd = 工作目录），技能 era-experiment-designer 驱动
   │      产出：<workdir>/seed/**  （能跑的程序 + eval.py + .era-fixtures）
   │            <workdir>/era-run.json（机器可读的 run 规格）
   │
   ├─► ★ 验证闸门（不可跳过）：面板亲自把 eval 在**未改动的 seed** 上跑一遍
   │      展示：基线分 / eval.py 全文 / 保护清单 / 机械核对表
   │      三个出口：[开始演化]  [让它改改]（回会话继续说）  [我自己改]
   │
   └─► job_run("era serve -q --out … --seed … --eval …")
```

### 为什么用「一次普通会话 + 技能」而不是前端里写死提示词

- **零新机制**：会话、模型、工具、审批、可回看的时间线，全是现成的。用户能看见 agent 是怎么写出这个 eval 的，出问题能接着聊。
- **符合既定原则**：领域逻辑住在用户可编辑的 SKILL 文本里，不编译进 base 代码。想换个写法就改 `~/.kalo/skills/era-experiment-designer/SKILL.md`。
- **可复用**：这个技能本质是「把一个模糊目标变成一个可自动打分的任务」，脱开 era 也有用。

会话是普通会话，只是**由面板预填第一条消息**（描述 + 工作目录 + 技能名）。用户可以中途接管、追问、要求换思路。

### 产出契约：`era-run.json`

技能的唯一硬约束是产出这个文件。小、显式、可手写：

```json
{
  "version": 1,
  "task": "把 solution.py 里的 solve(x) 拟合得更准",
  "seed": "seed",
  "eval": "python eval.py",
  "metricGoal": "max",
  "budget": 20,
  "evalTimeout": 300,
  "maxSteps": 20,
  "evalRepeats": 1,
  "holdoutEval": null,
  "evolves": ["solution.py"],
  "scoreMeaning": "负的 SSE，0 是完美拟合，越大越好"
}
```

- 字段与 era CLI 一一对应（`era/cli.py:59-123`），**没有任何 era 不认识的发明**，除了两个纯展示字段：
  - `evolves`：哪些文件是要被演化的。era 不需要它，面板用它做核对表和 diff 默认视图。
  - `scoreMeaning`：分数怎么读。用来在曲线的 Y 轴旁写一句人话，避免「-32900 是好是坏」这种困惑。
- 缺字段就用 era 的默认值；多字段就报错并展示原文，**不静默丢弃**。

技能同时必须在 `seed/.era-fixtures` 里列出评分脚本——否则变异 agent 可以改分器刷分（`era/workspace.py:35-38`）。这一条由闸门机械核对，不指望技能自觉。

### ★ 验证闸门

**这是整个设计里最重要的一屏，不可跳过。**

理由要说透：era 会花掉真金白银，围着 eval 爬二十次山。一个 agent 刚写完、没人跑过的 `eval.py`，如果分数算错了，整次搜索就是在优化一个 bug——而且看起来一切正常，分数还一路上涨。人只需要看一眼、点一下，就能挡掉这类事故。所以宁可多一屏。

闸门做的事，就是**把 era 第一步会做的事提前做一遍**：把 seed 原样复制到临时目录，`cd` 进去跑 `eval` 命令，取最后一行 stdout 解析成浮点数（与 `era/evaluate.py` 同口径）。

展示：

```
┌ 验证：先跑给你看 ─────────────────────────────────────────┐
│                                                          │
│  基线分   -32900.000000      （这就是 n0000 的分数）        │
│  耗时     0.4s   退出码 0                                  │
│  分数含义 负的 SSE，0 是完美拟合，越大越好                    │
│                                                          │
│  核对                                                     │
│   ✓ 最后一行能解析成数字            -32900.000000          │
│   ✓ 退出码为 0                                            │
│   ✓ 跑两次分数一致                  确定性，无需重复评测      │
│   ✓ 评分脚本已受保护                .era-fixtures: eval.py │
│   ✓ 待演化文件未被保护              solution.py            │
│   ✓ 耗时远小于超时                  0.4s / 300s            │
│                                                          │
│  [看 eval.py]  [看 solution.py]  [看 .era-fixtures]        │
│                                                          │
│  [开始演化]        [让它改改]        [我自己改]             │
└──────────────────────────────────────────────────────────┘
```

六条核对**全是机械判定，没有一条靠模型判断**：

| 核对 | 怎么判 | 不过会怎样 |
| --- | --- | --- |
| 最后一行是数字 | `parseFloat` 成功且有限 | era 直接判 eval 失败，一个节点都跑不出来 |
| 退出码 0 | `--eval` 非零退出 era 记 `eval_ok=false` | 全树评测失败 |
| 跑两次一致 | 跑第二遍比对 | 噪声评测会让搜索追随机数；提示改用 `--eval-repeats` + `--best-by lcb` |
| 评分脚本受保护 | `.era-fixtures` 存在且包含 `eval` 命令里出现的脚本 | **agent 可以改分器刷分** |
| 待演化文件未受保护 | `evolves` 与 fixtures 无交集 | 每次评测前被还原，改了等于没改，分数永远不动 |
| 耗时 vs 超时 | `duration * 3 < evalTimeout` | 中途大量超时，预算白烧 |

不过关的项标红并给出**一句话原因 + 一个动作**，但**不阻止**用户点「开始演化」——除了第一条（分数解析不出来时开始按钮禁用，因为那必然 100% 失败）。其余是警告不是拦截：用户可能就是知道自己在干什么。

三个出口：

- **开始演化** → 拼命令行 → `job_run`。
- **让它改改** → 回到那次会话，输入框预填「eval 有这个问题：…」，把核对表里失败项的原文带过去。
- **我自己改** → `FileViewerModal` / 系统编辑器（`files.rs:479 open_path` 已有），改完点「重新验证」。

闸门自身怎么跑：**也是一条 job**（短命的 command job，`label = "验证 <name>"`），不是新机制。这样超时、日志、失败都走同一套。

### 高级参数还在，只是不必看

era 的十几个旋钮（`--c-puct` / `--lcb-z` / `--holdout-when` / `--recombine-every` / `--ideas` …）保留为折叠的「高级」区，默认值来自 `era-run.json`，没写的用 era 默认。**自然语言配置不等于藏起参数**，等于不逼人一开始就懂它们。

### 明确不做的

- **不给模型一个「起 era」的工具**。产出物是文件，点「开始」永远是人的动作。预算是钱，eval 可信度要人过目。
- **不做「自然语言修改运行中的实验」**。跑起来之后只有停止。
- **不做自动重跑**。闸门不过、eval 失败，都停下来给人看。

## 第二部分：可视化与调试

### 组织方式：围着「出错的四种样子」排版

一次演化跑坏了，只可能是这四种之一。面板按这个分类组织，而不是按 era 的数据结构组织：

| 症状 | 数据在哪 | 面板给什么 |
| --- | --- | --- |
| **改写失败**：agent 没改成 | `mutation_ok` / `mutation_reason`，`.era/engine-stderr.log` | 节点标灰 + 原因；连续失败时顶部横幅 |
| **评测失败**：改了但跑不起来 | `eval_ok` / `eval_reason` / `returncode` / `stderr_tail`（`search.py:193-206`） | 节点标红 + stderr 尾巴 + 退出码 |
| **改了但没变好** | 父子 workspace 的 diff、`.era/instruction.md`、`last_agent_message` | diff + 「这次让它做什么」+ agent 最后一句 |
| **涨分但过拟合** | `score` vs `holdout_score`（`node.py:65-96`） | 双线曲线；gap 拉大时提示 |

### 主视图

```
┌ era-run-3   运行中 12/20 · $0.42 · 已跑 18m ────── [停止] [导出最优] [复制命令行] ┐
│                                                                                │
│  ⚠ 连续 3 个节点评测失败，原因都是 "ModuleNotFoundError: torch"  [看输出] [停止]  │
│                                                                                │
│  分数（负 SSE，越大越好）                                                        │
│   ─── best-so-far    ··· 各节点    ─ ─ holdout                                  │
│                                                                                │
│  搜索树                                     ┌ n0007 ─────────────────────────┐  │
│   n0000 seed        -32900                  │ 概览 | 改了什么 | 指令 | 评测输出 │  │
│   └ n0001 mutate    -18220  ×3              │      | 引擎轨迹                 │  │
│     ├ n0003 …       -6912   ×2              ├───────────────────────────────┤  │
│     ├ n0005 …       ✗ 评测失败               │ ...                            │  │
│     └ n0007 …       -5823 ★ ×2              │                               │  │
│       └ n0011 …     评测中…                  │        [打开目录] [复制JSON]   │  │
│                                             └───────────────────────────────┘  │
│  事件流  [全部 ▾] [只看失败]                                                     │
└────────────────────────────────────────────────────────────────────────────────┘
```

节点状态一眼可辨，共六种：`待变异` / `变异中` / `评测中` / `正常` / `评测失败` / `变异失败`。★ 当前最优，`×N` 访问数。

### 节点详情：五个标签

| 标签 | 内容 | 来源 |
| --- | --- | --- |
| **概览** | 分数（`--eval-repeats > 1` 时同时给 samples / std / sem / `selection_score`）、holdout、访问数、`rank_score` / `puct`、花费、`llm_steps` / `tool_calls`、算子 / donors / idea_id | `evaluated` + `backprop` 事件 |
| **改了什么** | 父节点 workspace 与本节点 workspace 的 diff，默认展开 `evolves` 里的文件 | 读两边文件，前端 diff（复用 `DiffView`） |
| **指令** | `.era/instruction.md` 全文——**这次到底让 agent 做什么** | `search.py:397` |
| **评测输出** | `stdout_tail` / `stderr_tail` / `eval_reason` / 退出码 / 耗时 | `evaluated` 事件 |
| **引擎轨迹** | `.era/engine-trace.jsonl`：变异 agent 的原始事件 | `trace.py:64` NodeTraceWriter |

「引擎轨迹」值得多说一句：era 起的是 kalo 自己的 pi（`--mode rpc`），所以这份 jsonl 里的事件**和桌面会话时间线是同一套词汇**。如果字段确实对得上（V-0 时核对），就直接喂给现有的时间线渲染，等于免费拿到「像看一次普通会话一样看这次变异」。对不上就退化成原始行列表——**不为此改任何现有渲染代码**。

### 调试的几个小东西（便宜但关键）

- **到处能复制原始 JSON 行**。折叠出来的树只要有一处不对，人要能立刻看见原始记录。
- **[打开目录]**：在文件管理器里打开节点 workspace（`open_path(reveal)` 已有）。
- **[复制命令行]**：把这次 run 的完整 `era serve …` 命令复制走，用户能在终端里原样复现、或改成 `era run` 重跑。**这是最好的逃生舱**——面板坏了不挡人干活。
- **失败横幅**：连续 3 个节点因**同一原因**失败 → 顶部横幅 + [看输出] + [停止]。判定就是把 `eval_reason` 的首行归一化后比对，不做聪明的聚类。
- **花费预估**：预算是「次数」不是钱。顶部显示 `已花 $0.42 · 按当前均价预计 $0.70`，均价 = 已完成节点的 `cost_usd` 均值。写明是**估算**。

### 曲线

`MetricChart`（上一份文档里的通用组件）要支持多序列：best-so-far 折线 + 各节点散点 + holdout 虚线。Y 轴旁挂 `scoreMeaning` 那句人话。这仍是通用组件——它只知道「几条 `{x,y}[]` 和一句副标题」。

## 需要的通用能力（在上一份文档的四项之外）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| `dir_diff_names(a, b, ignore[])` | **缺** | 返回两个目录间 增/删/改 的相对路径列表。纯通用，将来看任何「改动前后」都用得上 |
| `MetricChart` 多序列 | 上一份文档已列，这里加一条要求 | 折线 + 散点 + 副标题 |

`open_path` / `read_file_text` / `FileViewerModal` / `DiffView` 都已存在，直接用。

**harness、gateway、协议层仍然不动。** 唯一的新文本资产是一个技能文件，住在 `~/.kalo/skills/`，属于用户数据不属于代码。

## 改动清单（增量，叠加在上一份文档之上）

| 文件 | 改动 |
| --- | --- |
| `~/.kalo/skills/era-experiment-designer/SKILL.md` | 新增：产出 seed + eval + `era-run.json` 的技能（用户数据，随首次使用落盘） |
| `kalo-desktop/src-tauri/src/files.rs` | 新增 `dir_diff_names` |
| `kalo-desktop/src-tauri/src/main.rs` | 注册该命令 |
| `kalo-desktop/src/lib/pi-bridge.ts` | `dirDiffNames` 绑定 |
| `kalo-desktop/src/components/MetricChart.tsx` | 多序列 + 副标题 |
| `kalo-desktop/src/features/era/spec.ts` | 新增：`era-run.json` 解析 / 校验 / 拼命令行 |
| `kalo-desktop/src/features/era/gate.ts` | 新增：闸门的六条机械核对（纯函数） |
| `kalo-desktop/src/features/era/EraWizard.tsx` | 新增：描述框 → 起会话 → 等 spec |
| `kalo-desktop/src/features/era/EraGate.tsx` | 新增：验证闸门那一屏 |
| `kalo-desktop/src/features/era/EraNodeDetail.tsx` | 新增：五个标签的详情抽屉 |
| `kalo-desktop/src/features/era/EraPanel.tsx` | 主视图接入横幅 / 曲线 / 详情 |

## 边界情况

- **会话没产出 `era-run.json`**：面板说「还没看到规格文件」，给 [回到会话] [手动填表]。**不自动重试、不自动追问**。
- **`era-run.json` 是坏 JSON / 版本不认识**：展示原文 + 报错位置，不猜。
- **seed 里已经有 `.era`**：那是别的 run 的残留，era 会拒绝；闸门提前拦下并提示换目录。
- **eval 需要 GPU / 网络而当前不可用**：闸门就会失败，stderr 尾巴直接显示原因——这正是闸门存在的意义。
- **eval 跑很久**（比如训练一个小模型）：闸门用户可 [跳过验证]，但要点掉一个「我知道没验证过」的确认。这是唯一的跳过口，且必须显式。
- **seed 特别大**（GB 级数据）：era 每个节点都要复制整个 workspace。闸门算一下 seed 体积，超过 200 MB 就警告并提示用 `.era-hidden` 或把数据放在 seed 外面用绝对路径引用。
- **两次评测分数不一致但用户就要这么跑**：警告不拦，并提示 `--eval-repeats 3 --best-by lcb`。
- **父节点 workspace 已被删**（用户手工清理）：「改了什么」显示「父目录不在了」，其余标签照常。
- **`engine-trace.jsonl` 极大**（agent 跑了几十步）：只读尾部 N KB，顶上标「已省略前面 X KB」+ [打开文件]。
- **中断的 run**：`.era/instruction.md` 可能存在但没有 `evaluated`，节点停在「变异中」——如实显示，标 run 为「已中断」。
- **多次实验共用一个 workdir**：`era-run.json` 只有一份。规格文件带 `name`，输出目录按名字分开；同名则拒绝并提示改名。

## 分期（并入上一份文档的 V 序列）

| 阶段 | 内容 | 可验收 |
| --- | --- | --- |
| V-0 | `era run --agent-bin <kalo pi.exe>` 手工跑通 `examples/poly`；**顺带核对 `engine-trace.jsonl` 的事件字段与桌面时间线是否同源** | 通路成立 |
| V-1 | `job_run` + `read_text_since` | 桌面能起 era job |
| V-2 | fold + 树面板（只读） | 树实时长出来，能停止 |
| **V-3** | **spec.ts + gate.ts + 闸门那一屏**（手填 spec 也能走） | 拿 `examples/poly` 手写一份 `era-run.json`，闸门六条全绿，点开始能跑 |
| **V-3.5** | **向导：描述框 + 技能 + 等 spec** | 只说一句「拟合 f(x)=1+2x+3x²」，全程不写文件，跑出一次演化 |
| **V-4** | 曲线 + 节点详情五标签 + 失败横幅 | 故意写个坏 eval，面板 30 秒内让人看出坏在哪 |
| V-5 | 导出最优程序 | 闭环 |

V-3 在 V-3.5 之前：**闸门必须先于向导存在**。反过来做等于先让 agent 造一个没人检查的评分器。

## 验证

- `gate.ts` 六条核对的单测：每条各一个正例一个反例（需要 vitest —— 上一份文档已提出，这里更硬：闸门是安全边界，必须有测试）。
- `spec.ts`：缺字段取默认 / 多字段报错 / 命令行拼接对含空格和中文的路径正确转义 / 版本不匹配报错。
- 手工端到端：`examples/poly` 走完 V-3.5 全程。
- **负例手工**：故意给一个最后一行不是数字的 eval、一个把 `solution.py` 写进 `.era-fixtures` 的 seed、一个随机打分的 eval——三条都应该在闸门被指出来，而不是跑完二十次才发现。

---

## 实现记录（2026-08-18）

### 实际落盘的文件

基础能力（都不带 era 词汇，任何面板可用）：

| 文件 | 改动 |
| --- | --- |
| `kalo-desktop/src-tauri/src/files.rs` | 新增 `read_text_since`（增量尾读，含文件被截断的 `reset` 语义、UTF-8 边界回退）、`dir_diff_names`（目录差异，>4MB 只比大小，条目上限 20000） |
| `kalo-desktop/src-tauri/src/session.rs` | 导出 `engine_binary_path()` |
| `kalo-desktop/src-tauri/src/main.rs` | 注册 `read_text_since` / `dir_diff_names` / `app_paths` |
| `kalo-desktop/src/lib/pi-bridge.ts` | 上述三个绑定 + 六个早已注册但无人调用的 job 命令绑定 |
| `kalo-desktop/src/lib/text-diff.ts` | 新增：本地两段文本的行级 diff，输出 `DiffView` 已认识的格式 |
| `kalo-desktop/src/components/MetricChart.tsx` | 新增：多序列折线/散点 + 副标题 + 点选，纯 SVG 无依赖 |

era 特有（全部关在 `src/features/era/` 里）：

| 文件 | 作用 |
| --- | --- |
| `types.ts` | trace 记录与折叠后树的类型；`ts` 是 epoch **秒** |
| `fold.ts` | 增量 NDJSON → 树，语义对齐 `era/trace.py:rebuild_tree`；无法解析的行只计数不抛 |
| `spec.ts` | `era-run.json` 解析/校验/序列化 + `era serve` 命令行拼接 |
| `gate.ts` | 六条机械核对（纯函数） |
| `probe.ts` | 在 seed 的干净副本上真跑一次评测（走普通 job 运行时） |
| `runs.ts` | 工作区/运行的发现与启动 |
| `diagnose.ts` | 出错四种样子的判定 |
| `EraPanel.tsx` / `EraGate.tsx` / `EraNodeDetail.tsx` / `EraWizard.tsx` | 界面 |
| `~/.kalo/skills/era-experiment-designer/SKILL.md` | 技能（用户数据） |

入口在侧边栏「自动化」下面的「演化」（`Sidebar.tsx` + `App.tsx` 的 `page === "era"`），占满右侧主区，侧边栏保留——一次运行要看很久，而且把 spec 交回会话只隔一次点击。

### 与设计的偏差

- **`era-run.json` 多了一个 `eraBin`**：era 是 Python 工具，Windows 上多半装在 venv 里、不在 PATH 上。不给这个口子，失败现象是「job 秒退、trace 空文件」，用户无从下手。运行视图在「一个节点都没建出来」时会直接点名这个原因。
- **闸门多了一条 seed 里有残留 `.era` 的拦截**，设计里列在边界情况，实现时并进了闸门那一屏。
- **跳过验证**按设计做成唯一显式出口：要先勾「我知道这次没有验证过评测」才亮起。

### 测试

`vitest`（新引入）：68 个用例，`npm test`。覆盖闸门六条各正反例、spec 的未知字段拒绝与转义、fold 对 `rebuild_tree` 语义的逐项对齐（含分块喂入与整块喂入结果一致）、四种失败判定、行级 diff。

`tsc --noEmit` 与 `cargo check` 均通过。cargo 需要 `CARGO_TARGET_DIR` 指到别处，否则运行中的 kalo.exe 会锁住 `target/debug` 里的 sidecar 副本。

### 未做

- **V-0**：`era` 没装在当前环境（`era: command not found`），没能手工跑通 `examples/poly`，也就没能实测 `.era/engine-trace.jsonl` 的字段。代码上按「未知事件降级显示 type」处理，不会因此崩。
- **V-5 导出最优程序**：没做。
