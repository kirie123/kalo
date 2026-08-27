# era 演化实验接入 kalo-desktop

日期：2026-08-18
状态：待评审

## 需求

左侧「自动化」下增加一个入口，点开是 era 的搜索树面板：能新建一次演化实验、看树实时长出来、看分数曲线、停止、查看最优程序，并能配置模型等参数。

era（`d:/project/era-evolve`）是一个把程序演化到更高分的搜索器：FUTS 树搜索选节点 → 让编码 agent 改程序 → 跑用户的 `--eval` 拿分 → 回传访问数。分数由 era 跑评测得到，agent 从不自报成绩。

## 先说清楚一件事

这是**领域特例进入 base** 的一次例外。既有原则是「不要增加太定制和特殊的那种，主要是抽共同的」，era 的树、`c_puct`、`selection gap` 这些词进了 kalo-desktop 就是编译进代码的领域词汇。

我按你的决定做，但把边界划在一处，让它可控：

| 层 | 放什么 | era 词汇 |
| --- | --- | --- |
| harness / gateway / Rust | **通用能力**：起任务、读文件增量、指标 | **零** |
| kalo-desktop 前端 | `src/features/era/` 一个目录：配置表单 + 事件折叠 + 树渲染 | 全部集中在这里 |

结果是：era 相关代码整个目录可删，删掉不影响任何其他功能；而它依赖的三项通用能力（`job_run` / 文件增量读 / 指标图）本来就是路线图上欠的。

## 关键设计：era 就是一条普通后台任务

`era serve` 的 stdout 是 NDJSON 事件流，一行一个 JSON，每条 flush（`era/events.py:158-188`）；同一批记录也写进 `<out>/trace.jsonl`（append-only）。

于是**不需要任何新的进程管理**：

```
桌面「新建实验」表单
   └─► job_run(label, cwd, cmd="era serve --out <dir> ...", gate?, health?)
          └─► gateway 已有的 command job：detached 起进程，stdout 重定向到 logPath
                 └─► era 自己还在 <out>/trace.jsonl 写同一份记录
桌面 era 面板
   └─► 增量读 <out>/trace.jsonl → 前端折叠成树（与 era/trace.py:153 rebuild_tree 同构）
```

好处全是白捡的：

- **进程归 job runtime 管**：detached 落盘，gateway 重启重验 PID 不杀进程；关掉 app 实验照跑。
- `job_list` / `job_kill` / 飞书 `/status` `/stop` 自动生效，不写一行代码。
- 跑完自动推飞书（`onJobDone` 已有）。
- `gate` 可用：显存不够就 `queued` 等着，用户自己写的 bash 门。

被否决的替代方案：gateway 用管道拉起 era 并解析 stdout。管道能拿到 stdin 控制通道（优雅 abort），但进程就活不过 gateway 重启，且要新写一套所有权。**不值得**——见下面「停止语义」。

### 两个必须注意的细节

1. **必须传 `-q`**。job 的重定向是 `exec >> log 2>&1`（`gateway-backend.ts:373`），era 的人类可读日志走 stderr，会混进同一个文件。所以命令固定带 `-q`；折叠器同时**跳过任何解析失败的行**，双保险。
2. **面板读 `trace.jsonl`，不读 job 日志**。`job_logs` 是消费式游标（读一次就没了，`types.ts:118`），面板要的是「全量 + 增量 tail」。`trace.jsonl` 是 era 自己的 append-only 文件，正合适。

## 停止语义

era 的优雅中止是 stdin 上 `{"type":"era_abort"}` → 写 `run_interrupted` → 正常收尾。detached job 的 stdin 是 `ignore`，所以只能 `job_kill`，在 Windows 上是 `taskkill /T /F`（`gateway-backend.ts:552`）。

**后果可接受**：`trace.jsonl` 每条 flush、append-only，`era replay` 仍能重建，面板也照样折叠得出树；丢的只是 `run_interrupted` 标记和最终 `tree.json`。面板上把这种 run 标为「已中断」即可。

想要优雅停就得给 job runtime 加一条通用的 stdin 通道（`stopSignal`：先写一行，超时再硬杀）。这是通用能力，可以后补，v1 不做。

## 模型怎么选

era **从不传 `--model` / `--api-key` / `--provider`**，并且有断言挡住（`engines/pi.py:181` `assert_no_model_or_credential_args`）。它让 agent 读自己的配置。

而 kalo 的 pi 解析顺序是：CLI 参数 → scoped models → **settings 里保存的默认模型**（`model-resolver.ts:669`）。era 不传 CLI 参数、又用 `--no-approve` 关掉了项目级配置，所以落到第三条：

> **era 起的每个 pi 子进程，用的就是 kalo 当前的默认模型。**

v1 的做法：面板顶部显示「使用当前默认模型：`deepseek/deepseek-v4-pro`」，旁边一个链接跳设置→模型页。**不做 per-run 覆盖**。

要做 per-run 覆盖，只能改 era 上游加一个通用的 `--agent-arg`（可重复，追加到引擎 argv，凭据断言保留）。era 是你的仓库，可以做，但那是 era 的改动不是 kalo 的，单独一件事。**这条需要你拍板。**

## 面板

侧边栏「自动化」现在是打开设置页的「任务」标签（`Sidebar.tsx:155`）。新增一个平级标签「演化」。

**列表视图**（默认）

扫描 runs 根目录下含 `trace.jsonl` 的子目录，每行：名称 / 状态（运行中 · 已完成 · 已中断）/ 节点数 / 最优分 / 花费 / 耗时。顶部一个「新建实验」。

**详情视图**

```
┌ era-run-3  运行中 · 12/20 次扩展 · $0.42 ───────── [停止] [导出最优] ┐
│                                                                      │
│  最优分曲线（best-so-far）                                            │
│  ▁▃▅▅▆▆▇▇▇█                                                          │
│                                                                      │
│  搜索树                                    ┌ 节点 n0007 ───────────┐  │
│    n0000 seed      -32900                  │ 算子   mutate        │  │
│    └ n0001 mutate  -18220  ×3              │ 分数   -5823.1       │  │
│      ├ n0003 …     -6912   ×2              │ 访问   2             │  │
│      └ n0007 …     -5823 ★  ×2             │ 步数   14  工具 31   │  │
│        └ n0011 …   评测中…                  │ 花费   $0.031        │  │
│                                            │ agent 最后一句 …      │  │
│  事件流（最近 50 条，可折叠）                 │ [看程序] [看 diff]    │  │
└──────────────────────────────────────────────────────────────────────┘
```

- 树是折叠 `node_created` / `evaluated` / `backprop` 得到的，与 era 自己的 `rebuild_tree` 同构。★ 是当前最优；`×N` 是访问数。
- 节点点击 → 右侧详情；「看程序」复用已有的 `FileViewerModal`。
- 事件流是原始 NDJSON 的人类可读投影，出问题时能看见。
- 运行中每 1.5 s 增量读一次 `trace.jsonl`；不在详情页时不读。

**新建表单**

必填：任务描述 / seed 目录 / eval 命令 / 优化方向 / 预算 / 输出目录（默认 `<seed 的父目录>/era-runs/<名称>`）。

折叠的「高级」：`--max-steps` `--c-puct` `--eval-timeout` `--mutate-timeout` `--eval-repeats` `--eval-aggregate` `--best-by` `--lcb-z` `--holdout-eval` `--recombine-every` `--ideas`。默认值与 era 的默认一致，表单只是把 CLI 摆出来。

底部固定两项，都不可编辑、只展示：

- **引擎**：kalo 自带的 `pi.exe`（`--agent-bin` 自动指过去）。已核对 era 需要的 7 个参数 kalo-harness 全支持（`--mode rpc` / `--no-session` / `--no-approve` / `--no-extensions` / `--no-skills` / `--no-prompt-templates` / `--no-context-files`），`turn_end` 事件与 `get_session_stats` 命令也都在。用户不需要单独装 pi。
- **模型**：当前默认模型 + 跳转链接。

**环境自检**：面板首次打开跑一次 `era doctor`（era 是否在 PATH / Python 是否 ≥3.10），失败就在面板里给出安装提示，不弹窗、不阻塞。

## 需要的通用能力（base 层，无 era 词汇）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| `job_run` | **缺** | 上一轮 E-1。没有它 era 只能裸 `bash` 跑，丢掉 gate / 落盘 / 推送 |
| 文件增量读 `read_text_since(path, offset)` | **缺** | Rust `files.rs` 加一个命令，返回 `{text, offset, size}`。任何 append-only 日志都能用 |
| 指标折线图组件 | **缺** | 输入 `{x, y}[]`，era 用它画 best-so-far；将来任何 job 的 `metrics.jsonl` 也用它 |
| 桌面能起 job | **缺** | `job_start` Rust 命令已注册但零调用方（`main.rs:488`） |

除此之外**不新增任何协议、不改 gateway、不改 harness**。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `kalo-desktop/src-tauri/src/files.rs` | 新增 `read_text_since`（通用增量读） |
| `kalo-desktop/src-tauri/src/main.rs` | 注册该命令 |
| `kalo-desktop/src/lib/pi-bridge.ts` | `readTextSince` / `jobRun` 绑定 |
| `kalo-desktop/src/components/MetricChart.tsx` | 新增：通用折线图 |
| `kalo-desktop/src/features/era/types.ts` | era 事件与树的类型 |
| `kalo-desktop/src/features/era/fold.ts` | 新增：NDJSON → 树（纯函数，对着 `era/trace.py:153`） |
| `kalo-desktop/src/features/era/runs.ts` | 新增：扫描 runs 根目录、拼命令行 |
| `kalo-desktop/src/features/era/EraPanel.tsx` | 新增：列表 + 详情 |
| `kalo-desktop/src/features/era/EraNewRunForm.tsx` | 新增：新建表单 |
| `kalo-desktop/src/components/SettingsPage.tsx` | 加「演化」标签 |

harness、gateway、协议层：**不动**。

## 边界情况

- **era 没装 / Python 太老**：面板可用，新建按钮禁用，给出 `pip install -e` 的提示。
- **网关没跑**：起不了 job，与 `job_*` 同一套文案。
- **输出目录非空**：era 要求全新目录，表单先检查并提示改名。
- **`trace.jsonl` 还没出现**（进程刚起）：显示「启动中」，不报错。
- **run 目录被手工删了**：列表里消失，不留幽灵。
- **同一 run 开两个面板**：只读，无冲突。
- **超长 trace**（几千事件）：折叠器只维护树 + 最近 N 条事件，不在内存里留全量原始行。
- **路径含空格 / 中文**：命令行拼接一律走 shell 引号转义，表单不做「看起来能跑」的字符串拼接。
- **gate 让 run 排队**：面板状态显示「等待门控」，与 job 状态一致。

## 分期

| 阶段 | 内容 | 可验收 |
| --- | --- | --- |
| V-0 | 手工验证：`era run --agent-bin <kalo pi.exe>` 跑通 `examples/poly` | 通路成立，零代码 |
| V-1 | `job_run` + `read_text_since` | 能从桌面起一条 era job 并看到日志增长 |
| V-2 | fold + 树面板（只读） | 树实时长出来，能停止 |
| V-3 | 新建表单 + 环境自检 | 不碰命令行也能起一次实验 |
| V-4 | 最优分曲线 + 导出最优程序 | 一次实验闭环 |

V-0 是**前置门槛**：跑不通就没有后面。

## 验证

- V-0 手工：`examples/poly` 一两次变异出结果；确认 era 起的 pi 用的是 kalo 的默认模型（看 `nodes/*/.era/engine-trace.jsonl` 里的 `model` 字段）。
- `fold.ts` 单测：拿一份真实 `trace.jsonl` 折叠，结果与 `era replay` 输出的树一致（节点数、父子边、分数、访问数）。**kalo-desktop 目前没有测试运行器**，这条需要先引入 vitest，或者退而求其次做一次性的人工比对——建议引入，这个折叠逻辑值得有测试。
- 中断的 run 能正常折叠（硬杀之后）。
- 长 trace（≥2000 事件）面板不卡。
