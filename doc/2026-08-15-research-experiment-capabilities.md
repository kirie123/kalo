# 科研与实验能力设计（论文沉淀 / 在线调研 / 实验队列 / math）

日期：2026-08-15
状态：已确认方向，阶段 1+2 实现中

## 背景与目标

让 Kalo（桌面端 + harness）支撑两类日常工作：

1. **读论文并沉淀方法 idea**——本地 PDF 为主，结构化笔记 + 长期记忆双轨沉淀
2. **实验自动跑**——制定实验队列后 agent 自主执行、监控、记录，先队列后迭代

补充：math 探索（轻量，技能 + 记忆即可）。

## 已确认的需求决策

- 训练环境：本机 GPU + 远程 SSH 都有 → 技能内置两套启动模板
- 实验管理：当前是 agent 写脚本 + 笔记落目录；wandb 可选埋点，不强制接入
- 自动化程度：先队列式执行（异常停下叫人），跑稳后再加自主迭代
- 论文来源：本地为主；新增"在线调研"模块

## 总体思路

文件即状态。实验队列、论文笔记、调研综述都是结构化 Markdown，agent 通过读写它们驱动流程；memory（tags 分类）负责跨会话沉淀精华，让任何对话都能联想到过往结论。

新代码只有两个内置扩展：`web_fetch` 工具 + kalo 技能包。其余全是技能（prompt 工程）与目录约定。

## A. 论文阅读与沉淀

- **paper-reading 技能**：问题与动机 → 核心 idea（一句话）→ 方法拆解 → 关键实验/消融 → 局限性 → 可复用点
- 双轨产物：
  - 详细笔记 `~/.kalo/papers/<slug>.md`
  - 精华 `memory_save`（tags: `[paper]`）：一句话 idea + 关键数字
- 本地 PDF：拖入对话（现有 pdf-extract）或 Python pypdf 批量提取（技能内含模板命令）

## B. 在线调研模块

- **`web_fetch` 内置工具**（harness 内置扩展）：输入 URL 返回正文文本（HTML→简化 markdown，长度截断，超时保护，无新依赖）
- **web-research 技能**：拆解问题 → 多源检索（arXiv API、DuckDuckGo HTML，均无需 API key）→ web_fetch 精读 → 交叉验证 → 综述写 `~/.kalo/research/<topic>.md` → 精华 `memory_save`（tags: `[research]`），须注明来源链接

## C. 实验队列自动跑

工作区约定（experiment-runner 技能写死协议）：

```
experiments/                # 位于项目 cwd 下
├── queue.md                # 队列：待跑/在跑/完成，含目的+配置
├── runs/<name>/
│   ├── config.yaml         # 超参
│   ├── run.log             # 训练输出（后台进程重定向）
│   ├── result.md           # 完成后 agent 写的分析
│   └── status              # pending/running/done/failed
└── findings.md             # 跨实验结论，迭代期决策依据
```

队列循环：

1. 读 queue.md 取下一个 pending → 标记 running
2. 启动训练（启动即返回，避免 bash 超时）：本地 Windows 用 PowerShell `Start-Process` 重定向日志；远程 SSH 用 `nohup`/`tmux`；先判平台再选模板
3. `sleep` + tail 日志轮询：loss 曲线、GPU 占用、异常特征（NaN/OOM/非零退出码）
4. 完成 → 写 result.md、更新 queue.md、结论 `memory_save`（tags: `[experiment]`）→ 取下一个
5. 失败 → 标记 failed、保存现场（日志尾部 + 配置）、停下通知用户，不擅自重试

**硬约束**：循环跑在桌面端会话里，应用需保持打开（引擎是应用子进程）。v1 接受；后续可做定时唤醒降低对话占用。

**wandb**：技能内置实验脚本模板（可选 wandb 埋点），查询走 wandb CLI；v1 不强制。

## D. math 探索

`math` 技能：记号约定、sympy/numpy 数值验证先行、证明结构模板、结论 `memory_save`（tags: `[math]`）。零新代码。

## 技能分发方式

四个技能作为内置扩展（`src/extensions/kalo-skills/`）随引擎编译，内容内嵌为字符串常量；`session_start` 时 **write-if-missing** 写入 `~/.kalo/skills/<name>/SKILL.md`：

- 单一位置，设置页 Skills 区块可见可编辑
- 用户改动不会被覆盖（只写缺失的）
- 代价：引擎侧技能内容更新不会自动传播（v1 接受，后续可加版本标记）

## 实施阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 四个技能（paper-reading / web-research / experiment-runner / math）+ 目录约定 | 实现中 |
| 2 | `web_fetch` 内置工具（~100 行内置扩展） | 实现中 |
| 3 | 自主迭代：agent 读 findings.md 提新实验建议，用户批准入队 | 待队列跑稳 |
| 4 | 桌面实验面板、定时唤醒、wandb 深度集成 | 另议 |

## 目录一览

| 路径 | 用途 |
|---|---|
| `~/.kalo/skills/` | 全局技能（含内置分发的四个） |
| `~/.kalo/memory/` | 长期记忆（paper/research/experiment/math 按 tag 区分） |
| `~/.kalo/papers/` | 论文结构化笔记 |
| `~/.kalo/research/` | 在线调研综述 |
| `<项目>/experiments/` | 实验队列与 runs（项目级） |
