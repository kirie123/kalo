# Kalo 个人智能体路线图（P0 → P2）

> 定位：把 Kalo 从「桌面 coding agent」演进为**个人智能体**——主动找你、记得住事、定时干活。
> 服务四大场景：模型训练研究 / 个人投资分析 / 经验沉淀与知识构建 / 数学探索。
>
> 前置事实（2026-08 现状）：
> - pi 引擎底座已有：bash/read/write/edit 工具、skills、memory、compaction、session JSONL 持久化
> - IM 网关 P0 已落地：飞书扫码连接、引擎事件→单消息流式编辑推送、凭据/重启守护
> - 网关当前为**只读推送**：入站消息被丢弃（feishu.ts:48），双向对话是原方案预留的 P2

## 1. 设计原则

1. **个人规模，拒绝重武器**：知识库用 markdown + ripgrep 全文检索，不上向量库/数据库服务；调度用进程内 cron，不上消息队列。
2. **主动性优先**：价值排序是「它找我」>「我问它」。每期至少落地一个主动能力。
3. **复用三根现有管道**：pi 会话（执行）、网关 WS（触达）、skills（能力封装）。新功能尽量长在管道上，而不是新建管道。
4. **token 有价**：周期性检查走纯脚本（watch 任务，零 token）；只有值得推理的才起 LLM 会话（agent 任务）。

## 2. 现状与缺口

| 层 | 已有 | 缺口 |
|---|---|---|
| 入口 | 桌面 App；飞书单向推送 | 飞书双向对话（P2） |
| 调度 | 无 | scheduler：定时任务 + 后台任务表（P0/P1） |
| 能力 | pi 内置工具、skills 机制（用户级 skills 目前为空） | MCP client、领域 skill 包（P1） |
| 知识 | memory 机制存在但未启用 | 结构化知识库 + 经验卡 + 检索（P0） |

## 3. 总体架构

```
入口层   桌面 App（重交互）      飞书 IM（轻交互/被动接收）
              │                        │
调度层        │            kalo-scheduler（P0，长在网关 sidecar 内）
              │                │ cron/watch 触发
能力层   pi 引擎会话 ←—— Rust 后端（进程编排、NDJSON 总线）
              │                │
知识层   ~/.kalo/knowledge/（P0）   ~/.kalo/agent/memory/
```

调度层选型说明：放在网关 sidecar（Node）而非 Rust 侧，因为 ① 它已常驻且带重启守护；② 推送飞书的最短路径已通；③ node-cron 成熟、时区处理简单。Rust 侧保持零网络、零定时的纯粹进程编排角色。

---

## 4. P0-A：Scheduler（调度层）

### 4.1 任务模型

存储：`~/.kalo/agent/schedules.json`（网关读写，写时原子替换）。

```jsonc
{
  "tasks": [
    {
      "id": "train-watch-hrm",          // 稳定标识，推送文案引用
      "name": "HRM 训练监控",
      "kind": "watch",                   // watch=纯脚本零token | agent=起LLM会话
      "schedule": "*/10 * * * *",        // cron（本地时区）
      "cwd": "D:/train/hrm-exp12",
      // watch 型：
      "script": "tail -n 50 train.log | grep -E 'NaN|CUDA out of memory' ; pgrep -f trainer.py >/dev/null || echo PROCESS_EXITED",
      "matchMode": "nonEmpty",           // 输出非空即告警
      "cooldownMin": 30,                 // 命中后冷却，防重复轰炸
      // agent 型（与 watch 二选一）：
      "prompt": "盘点 checkpoints/ 目录，总结本周期 loss 趋势，一屏内汇报",
      "model": null,                     // null=用当前默认
      "enabled": true,
      "lastRun": "2026-08-15T09:00:00+08:00",
      "lastResult": "ok"                 // ok | alerted | error
    }
  ]
}
```

两类任务的分工：
- **watch**（训练监控主力）：网关直接 `child_process` 跑 bash 片段，输出命中才推送。零 token、可高频。
- **agent**（晨报/复盘主力）：到点起一次无头 pi 会话跑 prompt，结果推飞书。

### 4.2 触发链路（复用现有会话管道）

```
cron 到点(watch) ──► 网关本地执行脚本 ──命中──► feishu.sendText("[train-watch-hrm] 告警\n...")
cron 到点(agent) ──► 网关上行 session_request ──► Rust spawn pi(cwd,prompt)
                        ──► 现有 event 转发链 ──► 网关渲染进度到飞书（复用单消息编辑）
                        ──► session_exit ──► 网关收尾 + 更 schedules.json.lastRun
```

### 4.3 协议扩展（NDJSON，沿用现有风格）

Rust → 网关（stdin）：
```jsonc
{"cmd":"schedule_upsert","task":{...}}          // 前端保存任务
{"cmd":"schedule_remove","id":"train-watch-hrm"}
{"cmd":"schedule_run","id":"..."}               // 手动「立即运行」
{"cmd":"schedule_list"}                          // 网关回执全量
```

网关 → Rust（stdout）：
```jsonc
{"type":"schedule_status","tasks":[...]}        // 任务表快照（加载/变更/定期心跳时）
{"type":"session_request","taskId":"...","cwd":"...","prompt":"...","model":null}
                                                 // agent 型到点，请 Rust 起会话
```

Rust 侧新增 `session_request` 处理：复用 `create_session` + 盲发首条 prompt（现有 send_command 路径），会话 id 仍走 `event`/`session_exit` 回流，网关按 taskId→sessionId 映射渲染。

### 4.4 前端

设置面板新增「任务」Tab（复用左侧 Tab 结构）：
- 任务列表：名称 / 类型 / cron 下次时间 / 开关 / 上次结果（ok·告警·错误）
- 新建/编辑：类型切换（watch 表单填脚本+冷却；agent 表单填 prompt）
- 「立即运行」按钮（调试利器）

### 4.5 示例任务（出厂建议，README 提供）

| 场景 | 类型 | 说明 |
|---|---|---|
| 训练监控 | watch | grep NaN/OOM/进程退出，10min 一次，冷却 30min |
| 训练日报 | agent | 每晚 22:00 盘点 checkpoint + loss 趋势 |
| 投资晨报 | agent | 交易日 9:00 拉行情（P1 接 MCP 前先用本地脚本产物） |
| 数学题日推 | agent | 每天 20:00 一道自选主题的探索题（趣味+知识库素材） |

### 4.6 验收

- [ ] 新建 watch 任务（`echo ALARM`，`* * * * *`），1 分钟内飞书收到告警，且冷却期内不重复
- [ ] 新建 agent 任务手动运行，飞书出现流式进度并正常收尾
- [ ] 重启 App，任务表与开关状态保持
- [ ] 桌面关闭（仅网关在）时任务仍触发（网关进程独立验证）

---

## 5. P0-B：Knowledge（知识层）

### 5.1 目录布局

```
~/.kalo/knowledge/
  cards/            # 通用经验卡（跨领域）
  training-notes/   # 训练实验结论：什么配置有效/无效，loss 曲线解读
  investing/        # 交易日志、复盘、策略笔记
  math/             # 探索笔记：猜想→验证→结论/反例
  INDEX.md          # 自动维护的目录（title+tags+路径），检索加速用
```

全部 markdown，无数据库。检索 = ripgrep 关键词/标签 + INDEX.md 浏览。理由：个人量级（千级卡片）全文检索毫秒级；文件可手改可 git 可同步；零依赖零索引维护。

### 5.2 经验卡格式

```markdown
---
title: PrefixLM 在 HRM-1.3B 上优于 Causal LM
domain: training-notes
tags: [hrm, prefixlm, ablation]
date: 2026-08-15
source_session: a3f9c2        # 溯源到产生结论的会话
---
## 背景
（实验设置、变量控制）
## 结论
（一句话核心 + 置信度）
## 证据
（数据/命令输出摘录）
## 反例/边界
（什么情况下不成立）
```

frontmatter 字段由 skill 约定并校验；`source_session` 让卡片可一键跳回原始会话（桌面端历史查看器已有）。

### 5.3 能力封装：starter skill `knowledge`

以用户级 skill（`~/.kalo/skills/knowledge/SKILL.md`，引擎实际加载的用户级 skills 根）交付，暴露三个动作：

1. **save**：从当前会话提炼经验卡。skill 内置提炼模板（按 5.2 结构），LLM 起草 → 写入对应域目录 → 更新 INDEX.md。
2. **search**：`关键词/标签` → rg 检索 → 返回 top 卡片摘要。任何会话里可调。
3. **recall**：会话开始时按 cwd/话题自动检索 3-5 张相关卡注入上下文（skill 描述里写明触发时机）。

提炼时机：不自动强制——skill 指导模型在「会话产出可复用结论」时**主动建议**存卡，用户说「存」才写。质量优先于数量。

### 5.4 前端

设置面板「知识库」Tab（复用 skills 编辑器的浏览/搜索/编辑三栏模式）。

### 5.5 验收

- [ ] 任意会话得出结论后说「存入知识库」，卡片落盘且 INDEX.md 更新
- [ ] 新会话中 `search prefixlm` 命中并给出摘要
- [ ] 数学/投资/训练域目录按 frontmatter 正确归档

---

## 6. P1：能力扩展（MCP）与任务面板（Jobs）

### 6.1 MCP client

- pi extensions 机制接入 MCP server（stdio 优先，SSE 次之）
- 配置 `~/.kalo/agent/mcp.json`：`{ servers: { akshare: { command, args, env } } }`
- 优先接入：**akshare/yfinance MCP**（行情，服务投资晨报，替换 P0 里的本地脚本数据源）、**tavily/firecrawl MCP**（搜索）
- 桌面端：设置新增「MCP」Tab：server 列表、启停、工具清单展示
- 验收：投资晨报任务改走 MCP 数据源跑通

### 6.2 Jobs 统一面板（后台任务品牌化）

- 任务注册表：agent 任务、watch 任务、以及手动发起的飞书侧长任务，统一 `jobId/状态/进度/所属渠道`
- 桌面端顶部任务中心（运行中/最近失败/一键重跑）
- 前端新增 `job_*` 命令族查询（数据源即网关任务表 + Rust 会话表联查）
- 验收：晨报任务失败后在任务中心可见原因并重跑成功

---

## 7. P2：双向对话与高级编排

### 7.1 飞书入站（把 feishu.ts:48 的丢弃位变成入口）

- `im.message.receive_v1`（白名单已就绪）→ 网关上行 `im_message{text, openId}`
- 三种路由：
  - **新任务**：普通文本 → Rust 起会话，复用 P0-A 的 `session_request` 链路 → 双向对话打通
  - **追问**：回复某条进度消息 → 找到对应 sessionId → 追加上下文继续（消息 id↔sessionId 映射）
  - **快捷指令**：`任务列表` / `停 任务id` / `存卡`（把当前对话提炼进 knowledge）
- 这是 steering 的基础：长任务跑着，你在手机上直接发指令改方向

### 7.2 Steering（中途转向）

进行中会话收到 `im_message` 时，作为高优先级用户消息注入队列（pi 会话支持排队消息），引擎在当前工具步完成后消化。桌面端同样支持（输入框发送时任务运行中即转为 steering）。

### 7.3 Goal-bar（目标条）

长任务的结构化目标追踪：会话内 todo/plan 已有基础，升级为 UI 组件——目标、当前阶段、完成度常驻桌面顶栏 + 飞书首条消息内嵌阶段行。数据来自引擎事件流里的结构化 todo 更新。

### 7.4 Spill（超长任务接力）

跨会话接力：上下文将满时自动执行「交接仪式」——生成 handoff 笔记（目标/已试路径/结论/下一步）存入会话目录，自动起新会话注入笔记继续，飞书消息标注 `part 2`。compaction 解决会话内压缩，spill 解决跨会话接力，二者互补。

### 7.5 Subagent 并行研究

pi 的 agent 工具基础之上，封装「研究模式」：一个主会话派生 2-4 个子会话并行探索（如数学猜想的多个证明方向），子结论汇流渲染。依赖 7.1-7.4 的稳定性。

---

## 8. 里程碑与依赖

```
P0-A scheduler ──┬──► P1-B jobs 面板 ──► P2 steering/goal-bar
P0-B knowledge ──┴──► P1-A MCP(数据源升级) ──► 投资晨报完整形态
P2-A 飞书入站 ──► P2 全部
```

实施顺序建议：P0-A → P0-B（可并行）→ P1-A → P1-B → P2 按需。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 网关单进程承担调度+渲染+WS，职责膨胀 | 调度器独立模块 `scheduler.ts`，纯函数+注入时钟，可单测；崩溃重启已守护，任务表落盘可恢复 |
| cron 时区/休眠唤醒漏触发 | 每分钟 tick 时校验 `nextRun` 错过即补跑（至多一次），日志记录 |
| watch 脚本无超时挂死 | 网关侧硬超时 60s，超时按 error 上报 |
| 知识卡质量滑坡（垃圾进垃圾出） | 默认手动确认存卡；INDEX 定期由 agent 任务巡检去重 |
| 飞书 API 频控 | 已有节流；告警类再叠加 cooldownMin |
| MCP server 引入供应链面 | 仅本地 stdio、来源白名单、设置页明示启停 |
