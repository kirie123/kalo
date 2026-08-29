# 数字专家（Digital Expert）+ paper-broker 虚拟账号

日期：2026-08-29
状态：已实施（M1–M4，2026-08-29）

## 需求

用户想要两类能力：

1. **数字专家**：在 Kalo 上创建有独立身份的长期 Agent 实例——有自己的工作目录
   （目录形态由创建时的 agent 按使命自行规划）、自己的技能、**与个人记忆物理隔离的记忆**、
   自己的定时任务，并有一个专门面板查看各专家的运行状态 / 记忆 / 任务。
2. **虚拟账号**：一个接口/CLI 完成账户金额管理、下单、结算；关键是
   **agent 不能随意改数值**——状态变更只能走受校验的入口，篡改要可检测。

第一个实例是「投资专家」：每日收盘后拉数据 → 分析 → 决策 → 虚拟下单 → 记录 →
周复盘改进规则（「场景飞轮」，见本文「飞轮」节）。

### 为什么不用现成开源项目

调研过的都不契合（2026-08-29 实测检索）：

| 项目 | 问题 |
| --- | --- |
| open-paper-trading-mcp | 行情源绑死 Robinhood（美股），要 Docker + PostgreSQL；REST+MCP 双接口的思路可借鉴，体量不合适 |
| vnpy_paperaccount | 是 VeighNa 框架内的 UI 模块，不是独立 CLI/服务；要拖起行情网关（CTP 等），期货语境 |
| freqtrade dry-run | 只认加密货币交易所，是 bot 框架不是账本服务 |
| Alpaca paper trading | 只有美股，云端托管，数据不在本地 |

结论：自建极小的 `paper-broker` CLI（纯 Python 标准库，复用 `~/.kalo/market/py` 环境）。

## 关键事实（引擎与桌面端现状，已核实）

- pi 引擎**原生支持项目级技能**：`<cwd>/.kalo/skills/` 已被扫描为 project scope
  （`kalo-harness/packages/coding-agent/src/core/skills.ts` 的 `loadSkills`，
  `CONFIG_DIR_NAME = ".kalo"`）。**专家目录挂技能零引擎改动。**
- memory 扩展写死 `~/.kalo/memory/`（`extensions/memory/index.ts` 的 `memoryDir()`）——
  记忆隔离的唯一引擎改动点。
- `PiProcess::spawn`（`src-tauri/src/session.rs`）是引擎进程唯一 spawn 点：
  桌面会话（`main.rs`）与调度无头会话（`gateway.rs handle_session_request`）都走它。
  环境变量在此注入即全覆盖。
- scheduler 的 `ScheduleTask`（`gateway/src/scheduler.ts`）已有 `cwd/kind/prompt`，加 `expertId` 即可。
- job runtime 已有 `owner` 字段，专家起的 job 约定 `owner = "expert:<id>"`，不改 job runtime。

## 决策

1. **专家 = 注册表项 + 环境变量注入**。注册表 `~/.kalo/experts.json`（atomic tmp+rename，
   与 schedules 同款）；会话 spawn 时注入 `KALO_EXPERT_ID/NAME/MISSION` 与
   `KALO_MEMORY_DIR=<workdir>/.kalo/memory`。不做引擎分叉式的深度定制。
2. **记忆隔离走 env 覆盖**：`memoryDir()` 优先读 `KALO_MEMORY_DIR`，无 env 时行为不变。
   个人记忆与专家记忆物理分离，互不可见。
3. **目录约定不编译进代码**：专家目录里有什么（`portfolio/`、`papers/`、……）由创建会话
   按使命规划并写进该目录的 AGENTS.md——沿用路线图「能用提示解决的绝不写扩展」。
   代码只约定两件必需品：`<workdir>/.kalo/skills/`（引擎原生）与 `<workdir>/.kalo/memory/`。
4. **创建专家 = 一次普通会话**（内置 skill `expert-designer` 驱动），与 era 实验创建同款模式：
   问清使命 → 规划目录 → 写 AGENTS.md（专家宪章）→ 注册 experts.json → 按需写 schedules。
5. **虚拟账号用 append-only 账本 + 哈希链**，不用数据库也不起服务。
   **诚实边界**：agent 在本机有 shell 权限，任何本地文件理论上都能改，起 HTTP 服务也挡不住
   （同一用户）。所以目标是「**防君子 + 可审计**」：
   - 状态变更只允许走 CLI（内部校验：不能卖超出可用持仓、不能买超出现金、T+1、整手）；
   - `ledger.jsonl` 是唯一真相，每条带 `prev_hash`，`hash = sha256(prev_hash + canonical(entry))`；
   - `state.json`（现金/持仓）只是派生缓存，头记 ledger tip 哈希，可被重算推翻；
   - `broker.py verify` 重放全链 + 重算 state 对比，不一致非零退出——挂 watch 任务每日校验，
     agent 无法「悄悄改一个数字」而不被发现。
6. **面板只读聚合**：`src/features/experts/` 复用现有数据源（会话池 / job-status / schedules /
   文件面板），不建新运行时机制。M1 只读，管理操作后续再议。
7. **定价与 A 股规则写在代码里**（agent 绕不过）：价格默认取 market-data 前复权日线缓存；
   100 股整手（卖出可零股）、T+1、佣金万 2.5 最低 5 元、卖出印花税千 1。

## 架构

```
~/.kalo/experts.json                     注册表（id / name / workdir / mission / enabled）

<workdir>/                               专家目录（用户任选）
├── AGENTS.md                            专家宪章（创建会话写，含职责/纪律/复盘频率）
├── .kalo/
│   ├── skills/                          专家级技能（引擎 project scope，原生支持）
│   └── memory/                          专家记忆（KALO_MEMORY_DIR 指向这里）
└── …其余目录由创建会话按使命规划…         如 broker/ decisions/ reviews/ RULES.md

<workdir>/broker/                        paper-broker 账本（投资类专家才有）
├── ledger.jsonl                         append-only 事件流 + 哈希链（唯一真相）
├── state.json                           派生缓存（现金/持仓 + ledger tip 哈希）
└── snapshots.jsonl                      每日结算快照（同入链）
```

改动面：

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 引擎 | `extensions/memory/index.ts` | `memoryDir()` 支持 `KALO_MEMORY_DIR` 覆盖 |
| 引擎 | `extensions/expert-context/`（新增） | 读 `KALO_EXPERT_*` env，系统提示注入专家身份；注册进 `builtInExtensions` |
| Rust | `src-tauri/src/experts.rs`（新增） | 注册表 CRUD + Tauri 命令 `expert_list/upsert/remove` |
| Rust | `session.rs` / `main.rs` / `gateway.rs` | `PiProcess::spawn` 加 expert 参数并注入 env；`session_request` 解析 `expertId` 查注册表 |
| gateway | `scheduler.ts` | `ScheduleTask.expertId`；`session_request` 透传 |
| 前端 | `src/features/experts/`（新增）+ `src/lib/expert-view.ts` | 只读面板：列表 + 详情（进行中/记忆/定时任务/文件） |
| skills | `internal-skills/expert-designer/`（新增） | 创建专家的引导流程 |
| skills | `internal-skills/paper-broker/`（新增） | `broker.py` CLI + SKILL.md 纪律 + pytest |

## paper-broker CLI 契约

解释器复用 `~/.kalo/market/py`，只用标准库（+已有 pandas）。

```
broker.py init <dir> --cash 1000000
broker.py deposit|withdraw <dir> <amount>
broker.py buy  <dir> <code> <qty> [--price P | --date D]
broker.py sell <dir> <code> <qty> [--price P | --date D]
broker.py positions <dir>
broker.py pnl <dir> [--benchmark 000300]
broker.py settle <dir> --date D          # 收盘结算：按当日收盘价重估 + 快照入链
broker.py history <dir>
broker.py verify <dir>                   # 重放校验，不一致非零退出（watch 告警用）
```

定价：`--price` 显式指定优先（决策时按决策价成交）；否则取 market-data 缓存的前复权日线
对应日期收盘价，取不到报错退出（不猜价）。

## 飞轮（第一个专家实例的接线，零代码）

- watch（零 token）：工作日 15:10 `md.py macro append` + `broker.py settle`；
- agent：工作日 15:30 收盘飞轮（读 AGENTS.md/RULES.md + market-data 事实 → decisions/ →
  经 broker CLI 虚拟下单 → 飞书摘要），任务带 `expertId`；
- agent：周五 20:00 周复盘（decisions 预期 vs 实际 → reviews/ → 必要时改 RULES.md 并记录原因）；
- watch：每日 `broker.py verify`，非零退出推飞书。

## 里程碑

- **M1 专家底座**：注册表 + env 注入 + expertId 透传 + 只读面板 + 引擎重建。
- **M2 创建闭环**：`expert-designer` skill + 「新建专家」入口。
- **M3 paper-broker**：CLI + 哈希链账本 + pytest。
- **M4 飞轮实例**：用 M2 创建投资专家，接 M3 账本，配四条调度。

## 验证

- 引擎：`kalo-harness` 下 `npm run check`；`bun run build:engine` 重建并同步 exe；
  冒烟：带 `KALO_MEMORY_DIR` 起会话，`memory_save` 落进专家目录而非 `~/.kalo/memory/`。
- Rust：`cargo check` + `cargo test`（experts.rs 就近单测）。
- gateway：`tsc --noEmit` + scheduler 测试（expertId 透传）。
- 前端：`npx tsc --noEmit` + vitest（expert-view 纯逻辑）；面板人工验证。
- paper-broker：pytest 全绿 + 端到端（init→deposit→buy→settle→sell→pnl→verify；
  手改 state.json 后 verify 必须报警）。

## 不做

- 不接真实券商、不真实下单；broker 输出固定声明「纸交易记录，不构成投资建议」。
- 不做实时行情/分钟级撮合；日线收盘价结算。
- 面板 M1 只读；不做专家暂停/删除等管理操作。
- 不引入数据库/服务进程；防篡改靠哈希链可检测性，不做权限隔离（同用户下是假的）。

## 后续

- 专家面板的管理操作（停用/删除/克隆）。
- `recall` 检索按 expertId 分 scope。
- broker 若出现第二个资产类别（如场内基金）再抽资产配置，不预先抽象。
